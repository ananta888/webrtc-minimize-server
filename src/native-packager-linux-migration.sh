# Explicit migration of the historical shared Linux user-service layout only.
die() { printf '%s\n' "$1" >&2; exit 1; }
action=${1:-}
case "$action:$#" in
  migrate:2) [ "$2" = "$artifact_sha256" ] || die 'Supply the independently verified candidate SHA-256.' ;;
  recover:1|purge:1) ;;
  *) die 'Usage: migrate-<id> migrate <verified-sha256> | recover | purge' ;;
esac
for utility in systemctl timeout flock sha256sum stat curl cmp; do command -v "$utility" >/dev/null || die 'Required migration utility is unavailable.'; done
base="$HOME/.local/share/ananta-native-packager"
root="$base/$packager_id"
journal="$base/.migration-$packager_id"
unit_dir="$HOME/.config/systemd/user"
unit="ananta-native-packager-$packager_id.service"
unit_file="$unit_dir/$unit"
root_locked=0
old_identity="$base/identity-$packager_id.pem"
old_binary="$base/native-broadcast-packager"
old_launcher="$base/run-$packager_id"
old_uninstall="$base/uninstall-$packager_id"
owner=$(id -u)
private_dir() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = "$owner" ] && [ "$(stat -c %a "$1")" = 700 ]; }
regular() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = "$owner" ] && [ "$(stat -c %s "$1")" -le "$2" ]; }
hash() { sha256sum "$1" | awk '{print $1}'; }
same_text() { printf '%s' "$2" | cmp -s - "$1"; }
for directory in "$base" "$unit_dir"; do [ -d "$directory" ] && [ ! -L "$directory" ] && [ "$(stat -c %u "$directory")" = "$owner" ] || die 'Unsafe migration directory.'; done
private_dir "$base" || die 'The legacy base must be private to its owner (0700).'
[ ! -L "$base/.migration.lock" ] && { [ ! -e "$base/.migration.lock" ] || regular "$base/.migration.lock" 0; } || die 'Unsafe migration lock.'
exec 9>"$base/.migration.lock"
flock -n 9 || die 'Another legacy migration is active.'
systemd() { timeout 30 systemctl --user "$@"; }
check_unit() {
  regular "$unit_file" 32768 || return 1
  [ "$(systemd show --value --property=FragmentPath "$unit")" = "$unit_file" ] || return 1
  [ -z "$(systemd show --value --property=DropInPaths "$unit")" ]
}
stable() {
  systemd is-active --quiet "$unit" || return 1
  pid=$(systemd show --value --property=MainPID "$unit") || return 1
  printf '%s\n' "$pid" | grep -Eq '^[1-9][0-9]*$' || return 1
  for observation in 1 2 3 4 5; do
    sleep 2
    systemd is-active --quiet "$unit" || return 1
    [ "$(systemd show --value --property=MainPID "$unit")" = "$pid" ] || return 1
  done
}
stop() {
  systemd stop "$unit" || return 1
  [ "$(systemd show --value --property=MainPID "$unit")" = 0 ]
}
replace_unit() {
  temporary_unit=$(mktemp "$unit_dir/.ananta-migration-XXXXXXXXXXXX") || return 1
  if ! cp -- "$1" "$temporary_unit" || ! mv -Tf -- "$temporary_unit" "$unit_file"; then
    rm -f -- "$temporary_unit"; return 1
  fi
  systemd daemon-reload
}
lock_root() {
  private_dir "$root" || return 1
  [ ! -L "$root/.maintenance.lock" ] && { [ ! -e "$root/.maintenance.lock" ] || regular "$root/.maintenance.lock" 0; } || return 1
  exec 8>"$root/.maintenance.lock"
  flock -n 8 || return 1
  root_locked=1
}
known_entries() {
  directory=$1; shift
  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    allowed=0
    for name in "$@"; do if [ "${entry##*/}" = "$name" ]; then allowed=1; break; fi; done
    [ "$allowed" = 1 ] || return 1
  done
}
clean_candidate() {
  candidate=$1
  [ ! -e "$candidate" ] || {
    private_dir "$candidate" || return 1
    known_entries "$candidate" native-broadcast-packager "identity-$packager_id.pem" "run-$packager_id" "uninstall-$packager_id" "update-$packager_id" .migration-pending .maintenance.lock || return 1
    for name in native-broadcast-packager "identity-$packager_id.pem" "run-$packager_id" "uninstall-$packager_id" "update-$packager_id" .migration-pending .maintenance.lock; do
      [ ! -L "$candidate/$name" ] || return 1
      [ ! -e "$candidate/$name" ] || [ -f "$candidate/$name" ] || return 1
    done
    rm -f -- "$candidate/native-broadcast-packager" "$candidate/identity-$packager_id.pem" "$candidate/run-$packager_id" "$candidate/uninstall-$packager_id" "$candidate/update-$packager_id" "$candidate/.migration-pending" "$candidate/.maintenance.lock" || return 1
    rmdir -- "$candidate"
  }
}
clean_journal() {
  private_dir "$journal" || return 1
  known_entries "$journal" candidate discard unit launcher uninstall identity identity.sha256 binary.sha256 new-unit runtime-temp migration.sh prepared committed purging restored || return 1
  clean_candidate "$journal/candidate" || return 1
  clean_candidate "$journal/discard" || return 1
  for name in unit launcher uninstall identity identity.sha256 binary.sha256 new-unit runtime-temp migration.sh prepared committed purging restored; do
    [ ! -L "$journal/$name" ] || return 1
    [ ! -e "$journal/$name" ] || [ -f "$journal/$name" ] || return 1
  done
  rm -f -- "$journal/unit" "$journal/launcher" "$journal/uninstall" "$journal/identity" "$journal/identity.sha256" "$journal/binary.sha256" "$journal/new-unit" "$journal/runtime-temp" "$journal/migration.sh" "$journal/prepared" "$journal/committed" "$journal/purging" "$journal/restored" || return 1
  rmdir -- "$journal"
}
backups_valid() {
  private_dir "$journal" && regular "$journal/prepared" 0 || return 1
  regular "$old_identity" 32768 && [ "$(stat -c %a "$old_identity")" = 600 ] && regular "$old_binary" 134217728 || return 1
  for name in unit launcher uninstall identity identity.sha256 binary.sha256 new-unit; do regular "$journal/$name" 32768 || return 1; done
  same_text "$journal/unit" "$legacy_unit" && same_text "$journal/launcher" "$legacy_launcher" && same_text "$journal/uninstall" "$legacy_uninstall" && same_text "$journal/new-unit" "$new_unit" || return 1
  identity_hash=$(cat "$journal/identity.sha256"); binary_hash=$(cat "$journal/binary.sha256")
  printf '%s\n' "$identity_hash" | grep -Eq '^[a-f0-9]{64}$' || return 1
  printf '%s\n' "$binary_hash" | grep -Eq '^[a-f0-9]{64}$' || return 1
  [ "$(hash "$journal/identity")" = "$identity_hash" ] && [ "$(hash "$old_identity")" = "$identity_hash" ] && [ "$(hash "$old_binary")" = "$binary_hash" ]
}
candidate_valid() {
    regular "$root/identity-$packager_id.pem" 32768 && [ "$(hash "$root/identity-$packager_id.pem")" = "$identity_hash" ] || return 1
    regular "$root/native-broadcast-packager" 134217728 && [ "$(hash "$root/native-broadcast-packager")" = "$artifact_sha256" ] || return 1
    for name in "run-$packager_id" "uninstall-$packager_id" "update-$packager_id"; do regular "$root/$name" 131072 || return 1; done
    same_text "$root/run-$packager_id" "$new_launcher" && same_text "$root/uninstall-$packager_id" "$new_uninstall" && same_text "$root/update-$packager_id" "$new_updater" || return 1
}
recover() {
  if [ -e "$root" ] && [ "$root_locked" = 0 ]; then lock_root || return 1; fi
  backups_valid && check_unit || return 1
  if [ -e "$root" ]; then candidate_valid || return 1; fi
  same_text "$unit_file" "$legacy_unit" || same_text "$unit_file" "$new_unit" || return 1
  for source in "$old_launcher" "$old_uninstall"; do regular "$source" 32768 || return 1; done
  { same_text "$old_launcher" "$legacy_launcher" || same_text "$old_launcher" "$guard"; } && { same_text "$old_uninstall" "$legacy_uninstall" || same_text "$old_uninstall" "$guard"; } || return 1
  stop || return 1
  restore_runtime "$journal/launcher" "$old_launcher" && restore_runtime "$journal/uninstall" "$old_uninstall" || return 1
  replace_unit "$journal/unit" && systemd start "$unit" && stable || return 1
  : > "$journal/restored"
  cleanup_restored
}
restore_runtime() {
  [ ! -L "$journal/runtime-temp" ] || return 1
  cp -- "$1" "$journal/runtime-temp" && chmod 700 "$journal/runtime-temp" && mv -Tf -- "$journal/runtime-temp" "$2"
}
cleanup_restored() {
  regular "$old_launcher" 32768 && regular "$old_uninstall" 32768 || return 1
  check_unit && same_text "$unit_file" "$legacy_unit" && same_text "$old_launcher" "$legacy_launcher" && same_text "$old_uninstall" "$legacy_uninstall" || return 1
  regular "$old_identity" 32768 || return 1
  if [ -e "$journal/identity" ]; then regular "$journal/identity" 32768 && cmp -s "$journal/identity" "$old_identity" || return 1; fi
  if [ -e "$root" ]; then
    [ ! -e "$journal/discard" ] && [ ! -L "$journal/discard" ] && private_dir "$root" || return 1
    regular "$root/identity-$packager_id.pem" 32768 && cmp -s "$root/identity-$packager_id.pem" "$old_identity" || return 1
    mv -T -- "$root" "$journal/discard" || return 1
  fi
  if [ -e "$journal/discard/identity-$packager_id.pem" ]; then
    regular "$journal/discard/identity-$packager_id.pem" 32768 && cmp -s "$journal/discard/identity-$packager_id.pem" "$old_identity" || return 1
  fi
  clean_journal
}
write_guard() {
  [ ! -L "$journal/runtime-temp" ] || return 1
  printf '%s' "$guard" > "$journal/runtime-temp" && chmod 700 "$journal/runtime-temp" && mv -Tf -- "$journal/runtime-temp" "$1"
}
finish_commit() {
  regular "$old_launcher" 32768 && regular "$old_uninstall" 32768 || return 1
  backups_valid && check_unit && same_text "$unit_file" "$new_unit" && same_text "$old_launcher" "$guard" && same_text "$old_uninstall" "$guard" || return 1
  candidate_valid && stable || return 1
  [ ! -L "$root/.migration-pending" ] || return 1
  rm -f -- "$root/.migration-pending"
}

if [ "$action" != migrate ]; then
  private_dir "$journal" || die 'No safe migration journal.'
  if [ -e "$root" ]; then lock_root || die 'Another maintenance operation is active.'; fi
  if [ "$action" = purge ]; then
    check_unit && same_text "$unit_file" "$new_unit" && regular "$root/identity-$packager_id.pem" 32768 && regular "$old_identity" 32768 && cmp -s "$root/identity-$packager_id.pem" "$old_identity" || die 'Not an unchanged migrated identity; files preserved.'
    [ ! -e "$root/.migration-pending" ] && [ ! -L "$root/.migration-pending" ] || die 'Finish recovery before purge.'
    if rmdir -- "$journal" 2>/dev/null; then printf '%s\n' 'Empty backup journal removed.'; exit 0; fi
    if [ ! -e "$journal/purging" ]; then
      backups_valid && regular "$journal/committed" 0 || die 'Not a completed migration; files preserved.'
      : > "$journal/purging"
    fi
    regular "$journal/purging" 0 || die 'Invalid purge marker.'
    clean_journal || die 'Unexpected backup files; inspect locally.'
    printf '%s\n' 'Private migration backup removed. The original private key remains in the legacy base; remove it only after independent account confirmation.'
  elif [ -e "$journal/restored" ]; then
    regular "$journal/restored" 0 && cleanup_restored || die 'Interrupted cleanup requires inspection; files preserved.'
    printf '%s\n' 'Original user service restored; interrupted cleanup completed.'
  elif [ -e "$journal/committed" ]; then
    regular "$journal/committed" 0 && finish_commit || die 'Committed migration requires inspection; files preserved.'
    printf '%s\n' 'Migration completion recovered; verify in the app before explicit purge.'
  elif [ ! -e "$journal/prepared" ]; then
    [ ! -e "$root" ] && clean_journal || die 'Incomplete staging needs local inspection; files preserved.'
    printf '%s\n' 'Incomplete staging removed; legacy service was not changed.'
  else
    recover || die 'Recovery incomplete; all remaining files preserved for inspection.'
    printf '%s\n' 'Original user service restored. Identity unchanged.'
  fi
  exit 0
fi
[ ! -e "$root" ] && [ ! -L "$root" ] && [ ! -e "$journal" ] && [ ! -L "$journal" ] || die 'Destination or migration journal already exists; inspect or recover first.'
check_unit && same_text "$unit_file" "$legacy_unit" || die 'Custom or non-legacy unit; no migration.'
for file in "$old_launcher" "$old_uninstall" "$old_identity"; do regular "$file" 32768 || die 'Unsafe legacy file.'; done
regular "$old_binary" 134217728 && [ "$(stat -c %a "$old_identity")" = 600 ] || die 'Unsafe legacy binary or private key permissions.'
same_text "$old_launcher" "$legacy_launcher" && same_text "$old_uninstall" "$legacy_uninstall" || die 'Custom or non-legacy runtime; no migration.'
systemd is-active --quiet "$unit" || die 'Legacy service must be active before migration.'
regular "$0" 262144 || die 'Run the saved migration file, not a pipe or an inline shell.'
mkdir "$journal"
prepared=0
committed=0
finish() {
  outcome=$?; trap - EXIT HUP INT TERM
  if [ "$committed" = 0 ]; then
    if [ -e "$journal/committed" ]; then printf '%s\n' 'Commit marker retained; use recover to finish migration.' >&2
    elif [ "$prepared" = 1 ]; then recover || printf '%s\n' 'Recovery incomplete; run recover after inspecting the journal.' >&2
    else clean_journal || true; fi
  fi
  exit "$outcome"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
cp -- "$0" "$journal/migration.sh"; chmod 700 "$journal/migration.sh"
cp -- "$unit_file" "$journal/unit"; cp -- "$old_launcher" "$journal/launcher"; cp -- "$old_uninstall" "$journal/uninstall"; cp -- "$old_identity" "$journal/identity"
hash "$old_identity" > "$journal/identity.sha256"; hash "$old_binary" > "$journal/binary.sha256"
printf '%s' "$new_unit" > "$journal/new-unit"
mkdir "$journal/candidate"
cp -- "$old_identity" "$journal/candidate/identity-$packager_id.pem"
printf '%s' "$new_launcher" > "$journal/candidate/run-$packager_id"
printf '%s' "$new_uninstall" > "$journal/candidate/uninstall-$packager_id"
printf '%s' "$new_updater" > "$journal/candidate/update-$packager_id"
: > "$journal/candidate/.migration-pending"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 --max-filesize 134217728 --output "$journal/candidate/native-broadcast-packager" "$artifact_url"
[ "$(hash "$journal/candidate/native-broadcast-packager")" = "$artifact_sha256" ] || die 'Candidate hash mismatch; legacy service unchanged.'
chmod 700 "$journal/candidate/native-broadcast-packager" "$journal/candidate/run-$packager_id" "$journal/candidate/uninstall-$packager_id" "$journal/candidate/update-$packager_id"
export NATIVE_PACKAGER_IDENTITY_FILE="$journal/candidate/identity-$packager_id.pem"
timeout 15 "$journal/candidate/native-broadcast-packager" preflight >/dev/null 2>&1 || die 'Candidate preflight failed; legacy service unchanged.'
: > "$journal/prepared"
prepared=1
backups_valid || die 'Legacy files changed during staging.'
mv -T -- "$journal/candidate" "$root"
lock_root || die 'Candidate maintenance lock unavailable.'
stop && replace_unit "$journal/new-unit" && systemd start "$unit" && stable || die 'Candidate service failed; restoring legacy service.'
[ "$(hash "$root/identity-$packager_id.pem")" = "$identity_hash" ] || die 'Identity changed unexpectedly.'
write_guard "$old_launcher"
write_guard "$old_uninstall"
: > "$journal/committed"
committed=1
rm -f -- "$root/.migration-pending"
printf '%s\n' 'Local migration complete; verify the existing account in the app before purge. No enrollment occurred. Other legacy uninstallers remain unsafe and must not be run.'
