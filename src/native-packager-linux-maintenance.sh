# Linux implementation of the POSIX updater's OS port.
init_platform() {
  for utility in curl sha256sum timeout flock systemctl; do command -v "$utility" >/dev/null || return 1; done
  service="ananta-native-packager-$packager_id.service"
}
maintenance_lock() { flock -n 9; }
hash_file() { sha256sum "$1" | awk '{print $1}'; }
replace_file() { mv -Tf -- "$1" "$2"; }
preflight() { timeout 15 "$1" preflight >/dev/null 2>&1; }
stop_service() { timeout 30 systemctl --user stop "$service"; }
service_running() { systemctl --user is-active --quiet "$service"; }
start_service() {
  timeout 30 systemctl --user start "$service" || return 1
  observations=0
  while [ "$observations" -lt 5 ]; do
    sleep 2
    service_running || return 1
    observations=$((observations + 1))
  done
}
