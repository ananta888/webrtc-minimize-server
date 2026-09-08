#!/bin/sh
set -eu

action=${1:-deploy}
project_dir=${PROJECT_DIR:-$(pwd)}
production_origin=${PRODUCTION_ORIGIN:-https://webrtc.ananta.de}
proxy_network=${WEBRTC_REVERSE_PROXY_NETWORK:-webrtc-edge}
state_dir="$project_dir/.deploy"
previous_file="$state_dir/previous-image"
signing_key="$state_dir/secrets/broadcast-signing-private-key.pem"
compose_files="-f compose.yaml -f infra/reverse-proxy/compose.caddy-network.yaml -f infra/deployment/compose.production.yaml"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/deployment-image-set.sh"

cd "$project_dir"
case "$action" in deploy|rollback|rotate-broadcast-key|smoke) ;;
  *) echo 'Invalid deployment action' >&2; exit 2 ;;
esac
# Read-only validation precedes locks, signing keys, snapshots and Docker writes.
machine_selection=$(node "$script_dir/machine-deployment-config.mjs")
case "$machine_selection" in
  'disabled disabled'|'legacy enabled'|'legacy disabled'|'profile enabled'|'profile disabled') ;;
  *) echo 'Invalid machine deployment selection' >&2; exit 2 ;;
esac
set -- $machine_selection
machine_mode=$1
machine_admission=$2
machine_override=
case "$machine_mode" in
  legacy) machine_override=infra/deployment/compose.machine.yaml ;;
  profile) machine_override=infra/deployment/compose.machine-profile.yaml ;;
esac
if [ -n "$machine_override" ]; then
  [ -f "$machine_override" ] || { echo 'Machine deployment override is unavailable' >&2; exit 2; }
  compose_files="$compose_files -f $machine_override"
fi
mkdir -p "$state_dir"
case "$action" in deploy|rollback|rotate-broadcast-key)
  operation_lock="$state_dir/operation.lock"
  mkdir "$operation_lock" || { echo 'Deployment operation already active or interrupted; inspect before removing its lock.' >&2; exit 1; }
  trap 'rmdir "$operation_lock"' EXIT
  trap 'exit 1' HUP INT TERM
  ;;
esac
node scripts/ensure-broadcast-signing-key.mjs "$signing_key"
native_broadcast=$(node scripts/native-broadcast-deployment-enabled.mjs)

smoke() {
  attempts=0
  while [ "$attempts" -lt 12 ]; do
    if PRODUCTION_ORIGIN="$production_origin" EXPECT_NATIVE_BROADCAST="$native_broadcast" EXPECT_MACHINE_ADMISSION="$machine_admission" \
      node scripts/production-smoke-gate.mjs; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

rollback() {
  if [ -e "$state_dir/previous-images" ]; then
    restore_image_set
    return $?
  fi
  if [ "$native_broadcast" = enabled ]; then
    echo 'Legacy rollback has no native image set; refusing a mixed-version rollback.' >&2
    return 1
  fi
  if [ ! -s "$previous_file" ]; then
    echo "No previous immutable image recorded" >&2
    return 1
  fi
  previous_image=$(sed -n '1p' "$previous_file")
  case "$previous_image" in
    webrtc-minimize-server:rollback) ;;
    *) echo "Recorded rollback image is invalid" >&2; return 1 ;;
  esac
  docker image inspect "$previous_image" >/dev/null
  WEBRTC_IMAGE="$previous_image" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
    docker compose $compose_files up -d --no-build --pull never --wait webrtc
  smoke
}

rotate_broadcast_key() {
  if [ "${CONFIRM_BROADCAST_KEY_ROTATION:-}" != "1" ]; then
    echo "Refusing signing-key rotation without CONFIRM_BROADCAST_KEY_ROTATION=1" >&2
    return 1
  fi
  next_key="$signing_key.next"
  previous_key="$signing_key.previous"
  if [ -e "$next_key" ] || [ -e "$previous_key" ]; then
    echo "Refusing signing-key rotation with stale temporary key material" >&2
    return 1
  fi
  current_container=$(docker compose $compose_files ps -q webrtc 2>/dev/null || true)
  if [ -z "$current_container" ]; then
    echo "Cannot rotate the signing key without a running control plane" >&2
    return 1
  fi
  current_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")
  docker image inspect "$current_image" >/dev/null
  node scripts/ensure-broadcast-signing-key.mjs "$next_key"
  mv -Tf "$signing_key" "$previous_key"
  mv -Tf "$next_key" "$signing_key"
  if ! WEBRTC_IMAGE="$current_image" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
    docker compose $compose_files up -d --no-build --force-recreate --wait webrtc || ! smoke; then
    echo "Signing-key rotation failed; restoring the previous key" >&2
    rm -f "$signing_key"
    mv -Tf "$previous_key" "$signing_key"
    WEBRTC_IMAGE="$current_image" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
      docker compose $compose_files up -d --no-build --force-recreate --wait webrtc
    smoke
    return 1
  fi
  rm -f "$previous_key"
  echo "Broadcast signing key rotated; all pre-rotation grants and programs are invalid."
}

case "$action" in
  smoke)
    smoke
    ;;
  rollback)
    rollback
    ;;
  rotate-broadcast-key)
    rotate_broadcast_key
    ;;
  deploy)
    if [ -n "$(git status --porcelain)" ]; then
      echo "Refusing production deploy from a dirty worktree" >&2
      exit 1
    fi
    revision=$(git rev-parse --verify HEAD)
    source_timestamp=$(git show -s --format=%cI "$revision")
    candidate="webrtc-minimize-server:${revision}"
    candidate_native="webrtc-minimize-server-native-packager:${revision}"
    candidate_origin="webrtc-minimize-server-broadcast-hls-origin:${revision}"
    save_image_set
    if [ "$native_broadcast" = "enabled" ]; then
      NATIVE_PACKAGER_IMAGE="$candidate_native" BROADCAST_HLS_ORIGIN_IMAGE="$candidate_origin" \
        SOURCE_REVISION="$revision" SOURCE_TIMESTAMP="$source_timestamp" \
        docker compose $compose_files --profile native-packager build native-packager broadcast-hls-origin
      NATIVE_PACKAGER_IMAGE="$candidate_native" \
        docker compose $compose_files --profile native-packager run --rm --no-deps --pull never native-packager preflight
    fi
    WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
      docker compose $compose_files up -d --no-build --wait production-egress-firewall
    docker build --pull --build-arg "SOURCE_REVISION=$revision" \
      --build-arg "SOURCE_TIMESTAMP=$source_timestamp" -t "$candidate" .
    if ! activate_image_set; then
      echo "Candidate failed; restoring previous image set" >&2
      rollback
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {deploy|smoke|rollback|rotate-broadcast-key}" >&2
    exit 2
    ;;
esac
