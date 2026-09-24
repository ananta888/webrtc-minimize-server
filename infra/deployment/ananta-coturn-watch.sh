#!/usr/bin/env bash
# Probe coturn over STUN and restart it when it stops answering, with a cooldown.
#
# coturn can stop answering UDP STUN/TURN binds while the process stays up (seen
# twice in production), which kills every ICE candidate and with it the media
# path. This probe notices that and restarts the container at most once per
# cooldown window. Install as /usr/local/sbin/ananta-coturn-watch and drive it
# with ananta-coturn-watch.timer.
set -u

CONTAINER=${ANANTA_COTURN_CONTAINER:-ananta-public-coturn-1}
STATE=${ANANTA_COTURN_STATE:-/run/ananta-coturn-watch.last}
COOLDOWN=${ANANTA_COTURN_COOLDOWN:-300}
LOG=${ANANTA_COTURN_LOG:-/var/log/ananta-coturn-watch.log}

probe() {
  python3 - <<'PY'
import os, socket, sys

request = b"\x00\x01\x00\x00\x21\x12\xa4\x42" + os.urandom(12)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(3)
try:
    sock.sendto(request, ("127.0.0.1", 3478))
    data, _ = sock.recvfrom(512)
    sys.exit(0 if len(data) >= 20 else 1)
except Exception:
    sys.exit(1)
finally:
    sock.close()
PY
}

probe && exit 0

now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  echo "$(date -Is) coturn not answering, within cooldown" >> "$LOG"
  exit 0
fi
echo "$now" > "$STATE"
echo "$(date -Is) coturn not answering -> docker restart $CONTAINER" >> "$LOG"
docker restart "$CONTAINER" >> "$LOG" 2>&1
