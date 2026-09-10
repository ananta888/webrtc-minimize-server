#!/bin/sh
# Sourced by production-deploy.sh. Uses its compose_files, state_dir and proxy_network.
# Snapshot files are data, never shell input. Tags are unique per snapshot so a
# failed later snapshot cannot silently repoint an older rollback target.

require_machine_reload_image() {
  [ "${machine_mode:-disabled}" = profile-reload ] || return 0
  [ "$1" = '-' ] && return 0
  reload_profile=$(docker image inspect --format '{{index .Config.Labels "io.ananta.meet.trust-reload"}}' "$1") || return 1
  [ "$reload_profile" = sighup-v1 ] || { echo 'Image lacks required local machine trust reload support.' >&2; return 1; }
}

snapshot_service() {
  snapshot_container=$(docker compose $compose_files --profile native-packager ps -q "$1") || return 1
  if [ -z "$snapshot_container" ]; then printf '%s\n' '-'; return 0; fi
  snapshot_image=$(docker inspect --format '{{.Image}}' "$snapshot_container") || return 1
  if ! docker image inspect "$snapshot_image" >/dev/null 2>&1; then
    # Containerd can discard an old multi-platform index while retaining the
    # exact runnable manifest under a newer index (e.g. refreshed attestations).
    # Resolve the configured tag ONCE, then compare immutable platform content.
    snapshot_reference=$(docker inspect --format '{{.Config.Image}}' "$snapshot_container") || return 1
    snapshot_image=$(docker image inspect --format '{{.Id}}' "$snapshot_reference") || return 1
    snapshot_platform=$(docker inspect --format '{{.ImageManifestDescriptor.Platform.OS}}/{{.ImageManifestDescriptor.Platform.Architecture}}' "$snapshot_container") || return 1
    case "$snapshot_platform" in linux/amd64|linux/arm64) ;; *) return 1 ;; esac
    snapshot_running_manifest=$(docker inspect --format '{{.ImageManifestDescriptor.Digest}}' "$snapshot_container") || return 1
    printf '%s\n' "$snapshot_running_manifest" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
    snapshot_available_manifest=$(docker image inspect --platform "$snapshot_platform" --format '{{.Id}}' "$snapshot_image") || return 1
    [ "$snapshot_running_manifest" = "$snapshot_available_manifest" ] || { echo 'Running image differs from available rollback content.' >&2; return 1; }
  fi
  docker image tag "$snapshot_image" "$2" || return 1
  printf '%s\n' "$2"
}

save_image_set() {
  snapshot_temporary=$(mktemp "$state_dir/rollback.XXXXXX") || return 1
  snapshot_suffix=${snapshot_temporary##*/}
  snapshot_web=$(snapshot_service webrtc "webrtc-minimize-server:$snapshot_suffix") || return 1
  require_machine_reload_image "$snapshot_web" || return 1
  snapshot_native=$(snapshot_service native-packager "webrtc-minimize-server-native-packager:$snapshot_suffix") || return 1
  snapshot_origin=$(snapshot_service broadcast-hls-origin "webrtc-minimize-server-broadcast-hls-origin:$snapshot_suffix") || return 1
  # A partly provisioned native pair is not a recoverable baseline.
  if { [ "$snapshot_native" = '-' ] && [ "$snapshot_origin" != '-' ]; } ||
     { [ "$snapshot_native" != '-' ] && [ "$snapshot_origin" = '-' ]; }; then
    echo 'Incomplete native rollback baseline.' >&2
    return 1
  fi
  printf '%s\n' 'image-set-v1' "$snapshot_web" "$snapshot_native" "$snapshot_origin" > "$snapshot_temporary" || return 1
  mv -f -- "$snapshot_temporary" "$state_dir/previous-images" || return 1
}

read_image_set() {
  snapshot_file="$state_dir/previous-images"
  [ -f "$snapshot_file" ] && [ ! -L "$snapshot_file" ] || return 1
  [ "$(wc -l < "$snapshot_file" | tr -d ' ')" = 4 ] || return 1
  [ "$(sed -n '1p' "$snapshot_file")" = image-set-v1 ] || return 1
  rollback_web=$(sed -n '2p' "$snapshot_file")
  rollback_native=$(sed -n '3p' "$snapshot_file")
  rollback_origin=$(sed -n '4p' "$snapshot_file")
  if [ "$rollback_web" != '-' ]; then
    printf '%s\n' "$rollback_web" | grep -Eq '^webrtc-minimize-server:rollback\.[A-Za-z0-9]{6}$' || return 1
  fi
  if [ "$rollback_native" = '-' ]; then
    [ "$rollback_origin" = '-' ] || return 1
  else
    printf '%s\n' "$rollback_native" | grep -Eq '^webrtc-minimize-server-native-packager:rollback\.[A-Za-z0-9]{6}$' || return 1
    printf '%s\n' "$rollback_origin" | grep -Eq '^webrtc-minimize-server-broadcast-hls-origin:rollback\.[A-Za-z0-9]{6}$' || return 1
    [ "${rollback_native#*:}" = "${rollback_origin#*:}" ] || return 1
    [ "$rollback_web" = '-' ] || [ "${rollback_web#*:}" = "${rollback_native#*:}" ] || return 1
    docker image inspect "$rollback_native" "$rollback_origin" >/dev/null || return 1
  fi
  [ "$rollback_web" = '-' ] || docker image inspect "$rollback_web" >/dev/null || return 1
  require_machine_reload_image "$rollback_web" || return 1
}

restore_image_set() {
  read_image_set || { echo 'Missing or invalid complete rollback image set; no services changed.' >&2; return 1; }
  if [ "$rollback_native" = '-' ]; then
    docker compose $compose_files --profile native-packager stop broadcast-hls-origin native-packager || return 1
    native_broadcast=disabled
  else
    NATIVE_PACKAGER_IMAGE="$rollback_native" BROADCAST_HLS_ORIGIN_IMAGE="$rollback_origin" \
      docker compose $compose_files --profile native-packager up -d --no-build --pull never --wait native-packager broadcast-hls-origin || return 1
  fi
  if [ "$rollback_web" = '-' ]; then
    docker compose $compose_files stop webrtc || return 1
    echo 'First installation reverted to its prior stopped state; no volumes removed.'
    return 0
  fi
  WEBRTC_IMAGE="$rollback_web" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
    docker compose $compose_files up -d --no-build --pull never --wait webrtc || return 1
  smoke
}

activate_image_set() {
  require_machine_reload_image "$candidate" || return 1
  if [ "$native_broadcast" = enabled ]; then
    NATIVE_PACKAGER_IMAGE="$candidate_native" BROADCAST_HLS_ORIGIN_IMAGE="$candidate_origin" \
      docker compose $compose_files --profile native-packager up -d --no-build --pull never --wait native-packager broadcast-hls-origin || return 1
  fi
  WEBRTC_IMAGE="$candidate" WEBRTC_REVERSE_PROXY_NETWORK="$proxy_network" \
    docker compose $compose_files up -d --no-build --pull never --wait webrtc || return 1
  smoke
}
