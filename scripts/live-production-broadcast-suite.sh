#!/usr/bin/env bash
set -euo pipefail

if [ "${RUN_LIVE_PRODUCTION_SUITE:-0}" != "1" ]; then
  printf '%s\n' "SKIP isolated production broadcast suite: set RUN_LIVE_PRODUCTION_SUITE=1"
  exit 0
fi

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ssh_key="${LIVE_PRODUCTION_SSH_KEY:-$HOME/.ssh/oracle-ananta.key}"
keycloak_target="${LIVE_KEYCLOAK_SSH_TARGET:-opc@89.168.123.128}"
packager_target="${LIVE_PACKAGER_SSH_TARGET:-krusty@192.168.178.103}"
keycloak_container="${LIVE_KEYCLOAK_CONTAINER:-ananta-public-keycloak-1}"
keycloak_realm="${LIVE_KEYCLOAK_REALM:-ananta}"
packager_image="${LIVE_PACKAGER_IMAGE:-webrtc-minimize-server-native-packager:local}"
packager_network="${LIVE_PACKAGER_NETWORK:-webrtc-minimize-server_packager-egress}"
output_volume="${LIVE_PACKAGER_OUTPUT_VOLUME:-webrtc-minimize-server_native-broadcast-output}"

case "$ssh_key" in /*) ;; *) printf '%s\n' "LIVE_PRODUCTION_SSH_KEY must be absolute" >&2; exit 2 ;; esac
test -f "$ssh_key"
for value in "$keycloak_target" "$packager_target" "$keycloak_container" "$keycloak_realm" \
  "$packager_image" "$packager_network" "$output_volume"; do
  case "$value" in *[!A-Za-z0-9._@:/-]*|'') printf '%s\n' "invalid production-suite target" >&2; exit 2 ;; esac
done

cd "$repo_root"
umask 077
gate_user="webrtc-gate-$(date +%s)-$RANDOM"
gate_password="$(openssl rand -hex 24)"
gate_directory="$(mktemp -d)"
gate_user_id=""
gate_packager_id=""
gate_container=""
gate_volume=""
gate_revoked=0

cleanup() {
  set +e
  if [ -n "$gate_packager_id" ] && [ "$gate_revoked" -eq 0 ]; then
    RUN_LIVE_NATIVE_PACKAGER_ONBOARDING=1 \
      LIVE_OIDC_USERNAME="$gate_user" LIVE_OIDC_PASSWORD="$gate_password" \
      LIVE_NATIVE_PACKAGER_ACTION=revoke LIVE_NATIVE_PACKAGER_IDS="$gate_packager_id" \
      node scripts/live-native-packager-onboarding-gate.mjs >/dev/null 2>&1
  fi
  if [ -n "$gate_container" ]; then
    ssh -i "$ssh_key" "$packager_target" \
      "docker stop -t 5 '$gate_container' >/dev/null 2>&1 || true; docker container rm '$gate_container' >/dev/null 2>&1 || true"
  fi
  if [ -n "$gate_volume" ]; then
    ssh -i "$ssh_key" "$packager_target" "docker volume rm '$gate_volume' >/dev/null 2>&1 || true"
  fi
  if [ -n "$gate_user_id" ]; then
    ssh -i "$ssh_key" "$keycloak_target" \
      "docker exec '$keycloak_container' sh -lc '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 --realm master --user \"\$KC_BOOTSTRAP_ADMIN_USERNAME\" --password \"\$KC_BOOTSTRAP_ADMIN_PASSWORD\" >/dev/null 2>&1; /opt/keycloak/bin/kcadm.sh delete users/$gate_user_id -r $keycloak_realm >/dev/null 2>&1 || true'"
  fi
  case "$gate_directory" in /tmp/tmp.*) find "$gate_directory" -depth -delete ;; esac
}
trap cleanup EXIT HUP INT TERM

user_base64="$(printf '%s' "$gate_user" | base64 -w0)"
password_base64="$(printf '%s' "$gate_password" | base64 -w0)"
gate_user_id="$({
  printf 'gate_user_base64=%q\n' "$user_base64"
  printf 'gate_password_base64=%q\n' "$password_base64"
  printf 'keycloak_container=%q\n' "$keycloak_container"
  printf 'keycloak_realm=%q\n' "$keycloak_realm"
  cat <<'REMOTE'
set -euo pipefail
gate_user="$(printf '%s' "$gate_user_base64" | base64 -d)"
gate_password="$(printf '%s' "$gate_password_base64" | base64 -d)"
docker exec -e GATE_USER="$gate_user" -e GATE_PASSWORD="$gate_password" "$keycloak_container" sh -lc '
  set -eu
  k=/opt/keycloak/bin/kcadm.sh
  "$k" config credentials --server http://127.0.0.1:8080 --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null
  "$k" create users -r '"$keycloak_realm"' -s "username=$GATE_USER" -s enabled=true -s emailVerified=true >/dev/null
  id=$("$k" get users -r '"$keycloak_realm"' -q "username=$GATE_USER" --fields id --format csv --noquotes | tr -d "\r" | tail -n 1)
  test -n "$id"
  "$k" update "users/$id" -r '"$keycloak_realm"' -s firstName=WebRTC -s lastName=Gate -s "email=$GATE_USER@example.invalid" -s emailVerified=true >/dev/null
  "$k" set-password -r '"$keycloak_realm"' --username "$GATE_USER" --new-password "$GATE_PASSWORD" >/dev/null
  printf "%s\n" "$id"
'
REMOTE
} | ssh -i "$ssh_key" "$keycloak_target" bash -s)"
case "$gate_user_id" in *[!A-Za-z0-9-]*|'') printf '%s\n' "isolated Keycloak identity creation failed" >&2; exit 1 ;; esac
printf '%s\n' "Isolated Keycloak identity prepared"

RUN_LIVE_NATIVE_PACKAGER_ONBOARDING=1 \
  LIVE_OIDC_USERNAME="$gate_user" LIVE_OIDC_PASSWORD="$gate_password" \
  LIVE_NATIVE_PACKAGER_ACTION=download LIVE_NATIVE_PACKAGER_OUTPUT_DIR="$gate_directory" \
  LIVE_NATIVE_PACKAGER_TARGET=linux-amd64 \
  node scripts/live-native-packager-onboarding-gate.mjs

gate_packager_id="$(jq -r '.entries[0].packagerId' "$gate_directory/manifest.json")"
installer="$(find "$gate_directory" -maxdepth 1 -type f -name '1-ananta-native-packager-*.sh' -print -quit)"
gate_token="$(sed -n "s/^enrollment_token='\([^']*\)'$/\1/p" "$installer")"
case "$gate_packager_id" in pkr_[A-Za-z0-9_-]*) ;; *) printf '%s\n' "invalid packager id" >&2; exit 1 ;; esac
test "${#gate_token}" -eq 43
gate_suffix="${gate_packager_id#pkr_}"
gate_container="webrtc-gate-packager-${gate_suffix}"
gate_volume="webrtc-gate-identity-${gate_suffix}"

{
  printf 'gate_packager_id=%q\n' "$gate_packager_id"
  printf 'gate_token=%q\n' "$gate_token"
  printf 'gate_container=%q\n' "$gate_container"
  printf 'gate_volume=%q\n' "$gate_volume"
  printf 'packager_image=%q\n' "$packager_image"
  printf 'packager_network=%q\n' "$packager_network"
  printf 'output_volume=%q\n' "$output_volume"
  cat <<'REMOTE'
set -euo pipefail
common=(--network "$packager_network" --read-only --cap-drop ALL --security-opt no-new-privileges
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001 --pids-limit 256 --memory 3g --cpus 4
  -e NATIVE_PACKAGER_ID="$gate_packager_id"
  -e NATIVE_PACKAGER_IDENTITY_FILE=/var/lib/ananta-native-packager/identity.pem
  -e NATIVE_PACKAGER_OUTPUT_ROOT=/var/lib/ananta-broadcast-output
  -v "$gate_volume:/var/lib/ananta-native-packager"
  -v "$output_volume:/var/lib/ananta-broadcast-output")
docker volume create "$gate_volume" >/dev/null
docker run --rm --name "${gate_container}-enroll" "${common[@]}" \
  -e NATIVE_PACKAGER_ENROLLMENT_TOKEN="$gate_token" "$packager_image" enroll >/dev/null
docker run -d --name "$gate_container" "${common[@]}" \
  -e NATIVE_PACKAGER_ICE_TRANSPORT_POLICY=relay \
  -e NATIVE_PACKAGER_LABEL='Isolated Production Gate' "$packager_image" >/dev/null
REMOTE
} | ssh -i "$ssh_key" "$packager_target" bash -s
unset gate_token password_base64

RUN_LIVE_NATIVE_PACKAGER_ONBOARDING=1 \
  LIVE_OIDC_USERNAME="$gate_user" LIVE_OIDC_PASSWORD="$gate_password" \
  LIVE_NATIVE_PACKAGER_ACTION=verify-online LIVE_NATIVE_PACKAGER_IDS="$gate_packager_id" \
  node scripts/live-native-packager-onboarding-gate.mjs
RUN_LIVE_PRODUCTION_BROADCAST=1 \
  LIVE_OIDC_USERNAME="$gate_user" LIVE_OIDC_PASSWORD="$gate_password" \
  LIVE_NATIVE_PACKAGER_ID="$gate_packager_id" \
  node scripts/live-production-broadcast-gate.mjs
gate_revoked=1
printf '%s\n' "PASS isolated production broadcast suite with normal revocation"
