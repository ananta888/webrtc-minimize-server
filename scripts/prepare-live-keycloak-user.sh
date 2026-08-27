#!/usr/bin/env bash
set -euo pipefail

keycloak_url="${LIVE_KEYCLOAK_URL:-http://localhost:8081}"
admin_user="${KEYCLOAK_ADMIN_USERNAME:-admin}"
admin_password="${KEYCLOAK_ADMIN_PASSWORD:?Set KEYCLOAK_ADMIN_PASSWORD for the ephemeral test stack}"
test_user="${LIVE_OIDC_USERNAME:?Set LIVE_OIDC_USERNAME}"
test_password="${LIVE_OIDC_PASSWORD:?Set LIVE_OIDC_PASSWORD}"

discovery_url="${keycloak_url}/realms/webrtc/.well-known/openid-configuration"
for attempt in $(seq 1 45); do
  if curl --fail --silent --show-error "$discovery_url" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 45 ]; then
    echo "Keycloak discovery did not become ready: $discovery_url" >&2
    exit 1
  fi
  sleep 2
done

kcadm=(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh)
"${kcadm[@]}" config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$admin_user" \
  --password "$admin_password" >/dev/null

user_id="$(
  "${kcadm[@]}" get users -r webrtc -q "username=$test_user" \
    --fields id,username --format csv --noquotes \
    | awk -F, -v expected="$test_user" '$2 == expected { gsub(/\r/, "", $1); print $1; exit }'
)"

if [ -z "$user_id" ]; then
  "${kcadm[@]}" create users -r webrtc \
    -s "username=$test_user" -s enabled=true -s emailVerified=true >/dev/null
  user_id="$(
    "${kcadm[@]}" get users -r webrtc -q "username=$test_user" \
      --fields id,username --format csv --noquotes \
      | awk -F, -v expected="$test_user" '$2 == expected { gsub(/\r/, "", $1); print $1; exit }'
  )"
fi

if [ -z "$user_id" ]; then
  echo "Unable to resolve the Keycloak test user" >&2
  exit 1
fi

"${kcadm[@]}" update "users/$user_id" -r webrtc \
  -s firstName=WebRTC -s lastName=Gate \
  -s "email=${test_user}@example.invalid" -s emailVerified=true >/dev/null
"${kcadm[@]}" set-password -r webrtc --username "$test_user" \
  --new-password "$test_password" >/dev/null

echo "Keycloak live-gate identity prepared"
