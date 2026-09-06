# Appended to the generated per-device updater; not a standalone installer.
die() { printf '%s\n' "$1" >&2; exit 1; }
action=${1:-}
case "$action:$#" in
  update:2) expected=$2; printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{64}$' || die 'Expected SHA-256 is invalid.' ;;
  rollback:1|recover:1) ;;
  *) die 'Usage: update-<id> update <verified-sha256> | rollback | recover' ;;
esac
base="$HOME/.local/share/ananta-native-packager"
root="$base/$packager_id"
binary="$root/native-broadcast-packager"
identity="$root/identity-$packager_id.pem"
export NATIVE_PACKAGER_IDENTITY_FILE="$identity"
for scope in "$base" "$root"; do [ -d "$scope" ] && [ ! -L "$scope" ] || die 'Unsafe installation directory.'; done
for file in "$binary" "$identity"; do [ -f "$file" ] && [ ! -L "$file" ] || die 'Existing binary and identity are required.'; done
init_platform || die 'Required maintenance utility or service configuration is unavailable.'
for file in "$root/.maintenance.lock" "$root/.update-active" "$root/.rollback-ref"; do
  [ ! -L "$file" ] || die 'Maintenance state cannot be a symlink.'
  [ ! -e "$file" ] || [ -f "$file" ] || die 'Invalid maintenance state.'
done
exec 9>"$root/.maintenance.lock"
maintenance_lock || die 'Another maintenance operation is active or FD locking is unavailable.'

safe_work() {
  printf '%s\n' "$1" | grep -Eq '^\.update-[A-Za-z0-9]{12}$' || return 1
  [ -d "$root/$1" ] && [ ! -L "$root/$1" ] || return 1
  for file in "$root/$1/old" "$root/$1/old.sha256"; do [ -f "$file" ] && [ ! -L "$file" ] || return 1; done
  [ "$(wc -c < "$root/$1/old.sha256")" -le 65 ] || return 1
  backup_expected=$(cat "$root/$1/old.sha256")
  printf '%s\n' "$backup_expected" | grep -Eq '^[a-f0-9]{64}$' || return 1
  [ "$(hash_file "$root/$1/old")" = "$backup_expected" ]
}
read_ref() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  [ "$(wc -c < "$1")" -le 32 ] || return 1
  ref=$(cat "$1")
  safe_work "$ref" || return 1
  printf '%s\n' "$ref"
}
clean_work() {
  # Delete only our known files; unknown contents are retained, never recursive.
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  for name in candidate old old.sha256 ref restore; do
    [ ! -L "$1/$name" ] || return 1
  done
  rm -f -- "$1/candidate" "$1/old" "$1/old.sha256" "$1/ref" "$1/restore" || return 1
  rmdir -- "$1"
}
clean_unreferenced() {
  if [ -f "$root/.rollback-ref" ] && [ "$(cat "$root/.rollback-ref")" = "$1" ]; then return 0; fi
  clean_work "$root/$1"
}
restore_work() {
  restore_ref=$1
  safe_work "$restore_ref" || return 1
  preflight "$root/$restore_ref/old" || return 1
  [ ! -L "$root/$restore_ref/restore" ] || return 1
  [ ! -e "$root/$restore_ref/restore" ] || [ -f "$root/$restore_ref/restore" ] || return 1
  stop_service || return 1
  rm -f -- "$root/$restore_ref/restore" || return 1
  cp -- "$root/$restore_ref/old" "$root/$restore_ref/restore" || return 1
  replace_file "$root/$restore_ref/restore" "$binary" || return 1
  start_service || return 1
  rm -f -- "$root/.update-active" || return 1
}

if [ "$action" = recover ]; then
  recovery_ref=$(read_ref "$root/.update-active") || die 'No valid interrupted transaction; files preserved.'
  restore_work "$recovery_ref" || die 'Recovery failed; backup and transaction marker preserved.'
  clean_unreferenced "$recovery_ref" || die 'Recovered, but unknown staging files require inspection.'
  printf '%s\n' 'Previous binary recovered. Identity unchanged; verify account connectivity in the app.'
  exit 0
fi
[ ! -e "$root/.update-active" ] || die 'Interrupted transaction exists; use recover before another operation.'
service_running || die 'The installed user service must be active before updating.'
old_ref=''
if [ -e "$root/.rollback-ref" ]; then old_ref=$(read_ref "$root/.rollback-ref") || die 'Invalid rollback backup; files preserved.'; fi
if [ "$action" = rollback ]; then [ -n "$old_ref" ] || die 'No rollback backup available.'; fi
work=$(mktemp -d "$root/.update-XXXXXXXXXXXX")
work_ref=${work##*/}
pending=0
committed=0
finish() {
  outcome=$?
  trap - EXIT HUP INT TERM
  if [ "$pending" = 1 ] && [ "$committed" = 0 ]; then
    if restore_work "$work_ref"; then
      printf '%s\n' 'Update failed; previous binary restored.' >&2
      clean_unreferenced "$work_ref" || true
    else
      printf '%s\n' 'Automatic recovery failed; use recover. Files preserved.' >&2
    fi
    exit 1
  fi
  if [ "$committed" = 0 ]; then clean_work "$work" || true; fi
  exit "$outcome"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
if [ "$action" = update ]; then
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 120 --max-filesize 134217728 --output "$work/candidate" "$artifact_url"
  [ "$(hash_file "$work/candidate")" = "$expected" ] || die 'SHA-256 mismatch; service unchanged.'
else
  cp -- "$root/$old_ref/old" "$work/candidate"
fi
chmod 700 "$work/candidate"
preflight "$work/candidate" || die 'Candidate preflight failed; service unchanged.'
cp -- "$binary" "$work/old"
hash_file "$work/old" > "$work/old.sha256"
safe_work "$work_ref" && preflight "$work/old" || die 'Current binary cannot be safely restored; service unchanged.'
pending=1
printf '%s\n' "$work_ref" > "$work/ref"
replace_file "$work/ref" "$root/.update-active"
stop_service
replace_file "$work/candidate" "$binary"
start_service || die 'Candidate service did not remain active.'
printf '%s\n' "$work_ref" > "$work/ref"
replace_file "$work/ref" "$root/.rollback-ref"
committed=1
rm -f -- "$root/.update-active"
if [ -n "$old_ref" ]; then clean_work "$root/$old_ref" || printf '%s\n' 'Old backup contains unexpected files; inspect locally.' >&2; fi
printf '%s\n' 'Binary switched; previous version retained. Identity unchanged. Verify account connectivity in the app.'
