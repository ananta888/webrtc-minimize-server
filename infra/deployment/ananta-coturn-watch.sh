#!/usr/bin/env bash
# Probe coturn over STUN and an authenticated TURN allocation; restart it when
# either fails, with a cooldown.
#
# coturn can stop answering UDP STUN/TURN binds while the process stays up (seen
# twice in production), which kills every ICE candidate and with it the media
# path. A STUN bind alone does not prove that TURN works: the relay can still
# refuse credentials or fail to allocate. With a shared secret configured, this
# probe therefore mints a fresh TURN REST credential (the same HMAC-SHA1 scheme
# the room server uses), performs a real long-term-credential Allocate and
# releases the allocation again. Install as /usr/local/sbin/ananta-coturn-watch
# and drive it with ananta-coturn-watch.timer.
#
# The secret is read from ANANTA_COTURN_SECRET_FILE (root-only, never passed on a
# command line). Without it the probe falls back to STUN only and says so.
set -u

CONTAINER=${ANANTA_COTURN_CONTAINER:-ananta-public-coturn-1}
STATE=${ANANTA_COTURN_STATE:-/run/ananta-coturn-watch.last}
COOLDOWN=${ANANTA_COTURN_COOLDOWN:-300}
LOG=${ANANTA_COTURN_LOG:-/var/log/ananta-coturn-watch.log}
export ANANTA_COTURN_HOST=${ANANTA_COTURN_HOST:-127.0.0.1}
export ANANTA_COTURN_PORT=${ANANTA_COTURN_PORT:-3478}
export ANANTA_COTURN_SECRET_FILE=${ANANTA_COTURN_SECRET_FILE:-/etc/ananta/coturn-watch.secret}

# Prints one reason token; exit 0 healthy, 1 STUN unanswered, 2 TURN allocate failed.
probe() {
  python3 - <<'PY'
import base64, hashlib, hmac, os, socket, struct, sys, time

MAGIC = 0x2112A442
HOST = os.environ["ANANTA_COTURN_HOST"]
PORT = int(os.environ["ANANTA_COTURN_PORT"])


def attr(kind, value):
    return struct.pack("!HH", kind, len(value)) + value + b"\0" * ((4 - len(value) % 4) % 4)


def message(kind, attrs, key=None):
    tid = os.urandom(12)
    body = b"".join(attrs)
    if key is not None:
        # MESSAGE-INTEGRITY covers the header with a length that already includes itself.
        header = struct.pack("!HHI", kind, len(body) + 24, MAGIC) + tid
        body += attr(0x0008, hmac.new(key, header + body, hashlib.sha1).digest())
    return struct.pack("!HHI", kind, len(body), MAGIC) + tid + body, tid


def parse(data, tid):
    if len(data) < 20:
        return None, {}
    kind, length, magic = struct.unpack("!HHI", data[:8])
    if magic != MAGIC or data[8:20] != tid:
        return None, {}
    attrs, offset = {}, 20
    while offset + 4 <= min(len(data), 20 + length):
        akind, alen = struct.unpack("!HH", data[offset:offset + 4])
        attrs.setdefault(akind, data[offset + 4:offset + 4 + alen])
        offset += 4 + alen + (4 - alen % 4) % 4
    return kind, attrs


def error_code(attrs):
    value = attrs.get(0x0009, b"")
    return (value[2] & 7) * 100 + value[3] if len(value) >= 4 else 0


def exchange(sock, packet, tid):
    for _ in range(2):
        sock.sendto(packet, (HOST, PORT))
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            try:
                sock.settimeout(max(0.05, deadline - time.monotonic()))
                data, _ = sock.recvfrom(2048)
            except socket.timeout:
                break
            kind, attrs = parse(data, tid)
            if kind is not None:
                return kind, attrs
    return None, {}


def done(code, reason):
    print(reason)
    sys.exit(code)


sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    packet, tid = message(0x0001, [])
    kind, _ = exchange(sock, packet, tid)
    if kind != 0x0101:
        done(1, "stun-unanswered")
    try:
        with open(os.environ["ANANTA_COTURN_SECRET_FILE"], "rb") as handle:
            secret = handle.read().strip()
    except OSError:
        secret = b""
    if not secret:
        done(0, "stun-only")

    transport = attr(0x0019, b"\x11\0\0\0")  # REQUESTED-TRANSPORT: UDP
    packet, tid = message(0x0003, [transport])
    kind, attrs = exchange(sock, packet, tid)
    if kind is None:
        done(2, "allocate-unanswered")
    if kind != 0x0113 or error_code(attrs) != 401 or 0x0014 not in attrs or 0x0015 not in attrs:
        done(2, "allocate-challenge-%d" % error_code(attrs))
    realm, nonce = attrs[0x0014], attrs[0x0015]

    # TURN REST: username "<expiry>:<label>", password base64(HMAC-SHA1(secret, username)).
    username = ("%d:coturn-watch" % (int(time.time()) + 300)).encode()
    password = base64.b64encode(hmac.new(secret, username, hashlib.sha1).digest())
    key = hashlib.md5(username + b":" + realm + b":" + password).digest()

    for _ in range(2):
        auth = [attr(0x0006, username), attr(0x0014, realm), attr(0x0015, nonce)]
        packet, tid = message(0x0003, auth + [transport], key)
        kind, attrs = exchange(sock, packet, tid)
        if kind == 0x0113 and error_code(attrs) == 438 and 0x0015 in attrs:
            nonce = attrs[0x0015]  # stale nonce: retry once with the new one
            continue
        break
    if kind is None:
        done(2, "allocate-unanswered")
    if kind != 0x0103 or 0x0016 not in attrs:
        done(2, "allocate-rejected-%d" % error_code(attrs))

    # Release the probe allocation right away (LIFETIME 0).
    auth = [attr(0x0006, username), attr(0x0014, realm), attr(0x0015, nonce)]
    packet, tid = message(0x0004, auth + [attr(0x000D, b"\0\0\0\0")], key)
    exchange(sock, packet, tid)
    done(0, "allocate-ok")
except OSError as error:
    done(1, "socket-error-%s" % (error.errno or "unknown"))
finally:
    sock.close()
PY
}

reason=$(probe)
status=$?
[ "$status" -eq 0 ] && exit 0

now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  echo "$(date -Is) coturn unhealthy ($reason), within cooldown" >> "$LOG"
  exit 0
fi
echo "$now" > "$STATE"
echo "$(date -Is) coturn unhealthy ($reason) -> docker restart $CONTAINER" >> "$LOG"
docker restart "$CONTAINER" >> "$LOG" 2>&1
