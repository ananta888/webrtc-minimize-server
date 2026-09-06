# macOS implementation of the POSIX updater's OS port. Requires a GUI login.
init_platform() {
  for utility in curl shasum perl lockf launchctl; do command -v "$utility" >/dev/null || return 1; done
  service="de.ananta.native-packager.$packager_id"
  domain="gui/$(id -u)"
  plist_dir="$HOME/Library/LaunchAgents"
  plist="$plist_dir/$service.plist"
  [ -d "$plist_dir" ] && [ ! -L "$plist_dir" ] && [ -f "$plist" ] && [ ! -L "$plist" ]
}
maintenance_lock() { lockf -s -t 0 9; }
hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
replace_file() {
  [ ! -L "$2" ] && { [ ! -e "$2" ] || [ -f "$2" ]; } || return 1
  mv -f "$1" "$2"
}
preflight() { bounded 15 "$1" preflight >/dev/null 2>&1; }
service_state() {
  # Use documented PID / exit status / label columns, never debug-print output.
  listing=$(bounded 30 launchctl list 2>/dev/null) || return 1
  printf '%s\n' "$listing" | awk -v label="$service" '
    $3 == label { if (NF != 3 || found++) exit 1; state=$1 }
    END { if (found > 1) exit 1; if (found) print state; else print "absent" }'
}
service_running() {
  state=$(service_state) || return 1
  printf '%s\n' "$state" | grep -Eq '^[1-9][0-9]*$'
}
stop_service() {
  state=$(service_state) || return 1
  if [ "$state" = absent ]; then return 0; fi
  bounded 30 launchctl bootout "$domain/$service" >/dev/null 2>&1 || return 1
  state=$(service_state) || return 1
  [ "$state" = absent ]
}
start_service() {
  bounded 30 launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || return 1
  attempts=0
  while ! service_running; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 10 ] || return 1
    sleep 1
  done
  started_pid=$(service_state) || return 1
  observations=0
  while [ "$observations" -lt 5 ]; do
    sleep 2
    current_pid=$(service_state) || return 1
    [ "$current_pid" = "$started_pid" ] || return 1
    observations=$((observations + 1))
  done
}
