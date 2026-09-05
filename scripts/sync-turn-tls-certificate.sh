#!/usr/bin/env bash
set -euo pipefail

source_cert=${TURN_TLS_SOURCE_CERT:?TURN_TLS_SOURCE_CERT must point to the Caddy certificate chain}
source_key=${TURN_TLS_SOURCE_KEY:?TURN_TLS_SOURCE_KEY must point to the Caddy private key}
target_dir=${TURN_TLS_TARGET_DIR:-/etc/ananta/turn-tls}
server_name=${TURN_TLS_SERVER_NAME:-webrtc.ananta.de}
minimum_valid_seconds=${TURN_TLS_MIN_VALID_SECONDS:-604800}
source_uid=${TURN_TLS_SOURCE_UID:-0}
target_uid=${TURN_TLS_TARGET_UID:-0}
target_gid=${TURN_TLS_TARGET_GID:-0}
restart_enabled=${TURN_TLS_RESTART_ENABLED:-1}
compose_project=${TURN_TLS_COMPOSE_PROJECT:-ananta-public}
compose_service=${TURN_TLS_COMPOSE_SERVICE:-coturn}

fail() {
  printf 'TURN TLS certificate sync failed: %s\n' "$1" >&2
  exit 1
}

case "$target_dir" in
  /*) ;;
  *) fail "target directory must be absolute" ;;
esac
[ "$target_dir" != "/" ] || fail "target directory must not be /"
[[ "$server_name" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || fail "invalid server name"
[[ "$minimum_valid_seconds" =~ ^[0-9]{1,10}$ ]] || fail "invalid minimum validity"
[[ "$source_uid" =~ ^[0-9]+$ ]] || fail "invalid source uid"
[[ "$target_uid" =~ ^[0-9]+$ ]] || fail "invalid target uid"
[[ "$target_gid" =~ ^[0-9]+$ ]] || fail "invalid target gid"
[[ "$restart_enabled" =~ ^[01]$ ]] || fail "restart flag must be 0 or 1"
[[ "$compose_project" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail "invalid Compose project"
[[ "$compose_service" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail "invalid Compose service"

for source_file in "$source_cert" "$source_key"; do
  [ -f "$source_file" ] || fail "source is not a regular file"
  [ ! -L "$source_file" ] || fail "source symlinks are not accepted"
  [ "$(stat -c '%u' "$source_file")" = "$source_uid" ] || fail "unexpected source owner"
  source_mode=$(stat -c '%a' "$source_file")
  [[ "$source_mode" =~ ^[0-7]{3,4}$ ]] || fail "invalid source mode"
  (( (8#$source_mode & 8#022) == 0 )) || fail "source is group- or world-writable"
done

install -d -m 0750 -o "$target_uid" -g "$target_gid" "$target_dir"
install -d -m 0750 -o "$target_uid" -g "$target_gid" "$target_dir/releases"
[ ! -e "$target_dir/current" ] || [ -L "$target_dir/current" ] \
  || fail "current target exists and is not a symlink"

staging_dir=$(mktemp -d "$target_dir/releases/.candidate.XXXXXX")
next_link=""
marker_candidate=""
cleanup() {
  [ -z "$next_link" ] || rm -f -- "$next_link"
  [ -z "$marker_candidate" ] || rm -f -- "$marker_candidate"
  [ ! -d "$staging_dir" ] || rm -rf -- "$staging_dir"
}
trap cleanup EXIT

install -m 0444 -o "$target_uid" -g "$target_gid" "$source_cert" "$staging_dir/certificate.pem"
install -m 0440 -o "$target_uid" -g "$target_gid" "$source_key" "$staging_dir/private-key.pem"

openssl x509 -in "$staging_dir/certificate.pem" -noout >/dev/null 2>&1 \
  || fail "certificate cannot be parsed"
openssl pkey -in "$staging_dir/private-key.pem" -noout >/dev/null 2>&1 \
  || fail "private key cannot be parsed"
openssl verify -partial_chain -CAfile "$staging_dir/certificate.pem" -verify_hostname "$server_name" \
  "$staging_dir/certificate.pem" >/dev/null 2>&1 \
  || fail "certificate does not cover the configured server name"
openssl x509 -in "$staging_dir/certificate.pem" -noout -checkend "$minimum_valid_seconds" >/dev/null 2>&1 \
  || fail "certificate expires inside the required validity window"

openssl x509 -in "$staging_dir/certificate.pem" -pubkey -noout > "$staging_dir/certificate.pub"
openssl pkey -in "$staging_dir/private-key.pem" -pubout > "$staging_dir/private-key.pub"
cmp -s "$staging_dir/certificate.pub" "$staging_dir/private-key.pub" \
  || fail "certificate and private key do not match"
rm -f -- "$staging_dir/certificate.pub" "$staging_dir/private-key.pub"

release_id=$(openssl x509 -in "$staging_dir/certificate.pem" -fingerprint -sha256 -noout \
  | sed -E 's/^[^=]+=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')
[[ "$release_id" =~ ^[a-f0-9]{64}$ ]] || fail "certificate fingerprint is invalid"
release_dir="$target_dir/releases/$release_id"

secure_release_permissions() {
  local directory=$1
  chown "$target_uid:$target_gid" "$directory" "$directory/certificate.pem" "$directory/private-key.pem"
  chmod 0750 "$directory"
  chmod 0444 "$directory/certificate.pem"
  chmod 0440 "$directory/private-key.pem"
}

restart_marker="$target_dir/restart-required"
coturn_container=""
resolve_coturn_container() {
  local containers
  mapfile -t containers < <(docker ps -q \
    --filter "label=com.docker.compose.project=$compose_project" \
    --filter "label=com.docker.compose.service=$compose_service")
  [ "${#containers[@]}" -eq 1 ] || fail "expected exactly one running Coturn container"
  coturn_container=${containers[0]}
}

restart_coturn() {
  [ "$restart_enabled" = "1" ] || return 0
  [ -n "$coturn_container" ] || resolve_coturn_container
  docker restart "$coturn_container" >/dev/null
  [ "$(docker inspect --format '{{.State.Running}}' "$coturn_container")" = "true" ] \
    || fail "Coturn did not return to running state"
  rm -f -- "$restart_marker"
}

if [ -L "$target_dir/current" ] \
  && cmp -s "$staging_dir/certificate.pem" "$target_dir/current/certificate.pem" \
  && cmp -s "$staging_dir/private-key.pem" "$target_dir/current/private-key.pem"; then
  [ "$(readlink -f -- "$target_dir/current")" = "$release_dir" ] \
    || fail "current symlink does not match the certificate fingerprint"
  secure_release_permissions "$release_dir"
  if [ -e "$restart_marker" ]; then
    [ -f "$restart_marker" ] && [ ! -L "$restart_marker" ] \
      || fail "restart marker is invalid"
    restart_coturn
    printf 'TURN TLS certificate is current and its pending restart completed.\n'
    exit 0
  fi
  printf 'TURN TLS certificate is already current.\n'
  exit 0
fi

if [ -e "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || fail "release target is invalid"
  cmp -s "$staging_dir/certificate.pem" "$release_dir/certificate.pem" \
    && cmp -s "$staging_dir/private-key.pem" "$release_dir/private-key.pem" \
    || fail "release fingerprint collision"
  rm -rf -- "$staging_dir"
else
  mv -- "$staging_dir" "$release_dir"
fi
secure_release_permissions "$release_dir"

if [ "$restart_enabled" = "1" ]; then
  resolve_coturn_container
  marker_candidate="$target_dir/.restart-required.$$"
  install -m 0600 -o "$target_uid" -g "$target_gid" /dev/null "$marker_candidate"
  mv -Tf -- "$marker_candidate" "$restart_marker"
  marker_candidate=""
fi

next_link="$target_dir/.current.$$"
ln -s "releases/$release_id" "$next_link"
mv -Tf -- "$next_link" "$target_dir/current"
next_link=""
sync -f "$target_dir" 2>/dev/null || true
restart_coturn

printf 'TURN TLS certificate updated and validated for %s.\n' "$server_name"
