#!/bin/sh
set -eu

action=${1:-deploy}
project_dir=${PROJECT_DIR:-$(pwd)}
production_origin=${PRODUCTION_ORIGIN:-https://webrtc.ananta.de}
proxy_network=${WEBRTC_REVERSE_PROXY_NETWORK:-webrtc-edge}
state_dir="$project_dir/.deploy"
previous_file="$state_dir/previous-image"
rollback_image="webrtc-minimize-server:rollback"
signing_key="$state_dir/secrets/broadcast-signing-private-key.pem"
compose_files="-f compose.yaml -f infra/reverse-proxy/compose.caddy-network.yaml -f infra/deployment/compose.production.yaml"

cd "$project_dir"
mkdir -p "$state_dir"
node scripts/ensure-broadcast-signing-key.mjs "$signing_key"
native_broadcast=$(node scripts/native-broadcast-deployment-enabled.mjs)

smoke() {
  attempts=0
  while [ "$attempts" -lt 12 ]; do
    if PRODUCTION_ORIGIN="$production_origin" EXPECT_NATIVE_BROADCAST="$native_broadcast" \
      node scripts/production-smoke-gate.mjs; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

rollback() {
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
    docker compose $compose_files up -d --no-build --wait webrtc
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
    current_container=$(docker compose $compose_files ps -q webrtc 2>/dev/null || true)
    if [ -n "$current_container" ]; then
      current_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")
      docker image inspect "$current_image" >/dev/null
      docker image tag "$current_image" "$rollback_image"
      printf '%s\n' "$rollback_image" > "$previous_file.new"
      mv "$previous_file.new" "$previous_file"
    fi
    if [ "$native_broadcast" = "enabled" ]; then
      SOURCE_REVISION="$revision" SOURCE_TIMESTAMP="$source_timestamp" \
        docker compose $compose_files --profile native-packager build native-packager broadcast-hls-origin
      docker compose $compose_files --profile native-packager up -d --wait native-packager broadcast-hls-origin
    fi
    WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
      docker compose $compose_files up -d --no-build --wait production-egress-firewall
    docker build --pull --build-arg "SOURCE_REVISION=$revision" \
      --build-arg "SOURCE_TIMESTAMP=$source_timestamp" -t "$candidate" .
    if ! WEBRTC_IMAGE="$candidate" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
      docker compose $compose_files up -d --no-build --wait webrtc || ! smoke; then
      echo "Candidate failed; restoring previous image" >&2
      rollback
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {deploy|smoke|rollback|rotate-broadcast-key}" >&2
    exit 2
    ;;
esac
