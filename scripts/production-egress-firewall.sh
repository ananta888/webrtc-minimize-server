#!/bin/sh
set -eu

chain_a=ANANTA-WRTC-EGRESS-A
chain_b=ANANTA-WRTC-EGRESS-B
control_subnet=${WEBRTC_CONTROL_EGRESS_SUBNET:-10.203.0.0/28}
packager_subnet=${WEBRTC_PACKAGER_EGRESS_SUBNET:-10.203.0.16/28}
control_https_hosts=${WEBRTC_CONTROL_EGRESS_HTTPS_HOSTS:-keycloak.ananta.de}
packager_https_hosts=${WEBRTC_PACKAGER_EGRESS_HTTPS_HOSTS:-webrtc.ananta.de}
packager_turn_hosts=${WEBRTC_PACKAGER_EGRESS_TURN_HOSTS:-webrtc.ananta.de,minipc.ananta.de}
refresh_seconds=${WEBRTC_EGRESS_REFRESH_SECONDS:-300}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

validate_subnet() {
  case "$1" in
    *[!0-9./]*|*.*.*.*/*) ipcalc -n "$1" >/dev/null 2>&1 || fail "invalid IPv4 egress subnet" ;;
    *) fail "invalid IPv4 egress subnet" ;;
  esac
}

validate_hosts() {
	case "$1" in
	  ""|,*|*,|*,,*|*[!A-Za-z0-9.,-]*) fail "invalid egress hostname set" ;;
	esac
  old_ifs=$IFS
  IFS=,
  set -f
  set -- $1
  set +f
  IFS=$old_ifs
  [ "$#" -gt 0 ] || fail "empty egress hostname set"
  for host in "$@"; do
    case "$host" in
      ""|*[!A-Za-z0-9.-]*|.*|*..*|*.) fail "invalid egress hostname" ;;
    esac
  done
}

resolve_hosts() {
  old_ifs=$IFS
  IFS=,
  set -f
  set -- $1
  set +f
  IFS=$old_ifs
  for host in "$@"; do
    getent ahostsv4 "$host" | awk '{ print $1 }'
  done | sort -u
}

active_chain() {
  if iptables -C DOCKER-USER -j "$chain_a" >/dev/null 2>&1; then
    printf '%s\n' "$chain_a"
  elif iptables -C DOCKER-USER -j "$chain_b" >/dev/null 2>&1; then
    printf '%s\n' "$chain_b"
  fi
}

remove_jumps() {
  chain=$1
  while iptables -C DOCKER-USER -j "$chain" >/dev/null 2>&1; do
    iptables -D DOCKER-USER -j "$chain"
  done
}

append_https_rules() {
  chain=$1
  hosts=$2
  comment=$3
  addresses=$(resolve_hosts "$hosts")
  [ -n "$addresses" ] || fail "an allowed HTTPS hostname did not resolve"
  for address in $addresses; do
    iptables -A "$chain" -s "$4" -d "$address/32" -p tcp --dport 443 \
      -m comment --comment "$comment" -j ACCEPT
  done
}

append_turn_rules() {
  chain=$1
  addresses=$(resolve_hosts "$2")
  [ -n "$addresses" ] || fail "an allowed TURN hostname did not resolve"
  for address in $addresses; do
    iptables -A "$chain" -s "$packager_subnet" -d "$address/32" -p udp --dport 3478 \
      -m comment --comment ananta-packager-turn-udp -j ACCEPT
    iptables -A "$chain" -s "$packager_subnet" -d "$address/32" -p tcp --dport 3478 \
      -m comment --comment ananta-packager-turn-tcp -j ACCEPT
    iptables -A "$chain" -s "$packager_subnet" -d "$address/32" -p tcp --dport 5349 \
      -m comment --comment ananta-packager-turn-tls -j ACCEPT
  done
}

apply_policy() {
  validate_subnet "$control_subnet"
  validate_subnet "$packager_subnet"
  validate_hosts "$control_https_hosts"
  validate_hosts "$packager_https_hosts"
  validate_hosts "$packager_turn_hosts"
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || fail "Docker DOCKER-USER chain unavailable"

  current=$(active_chain || true)
  if [ "$current" = "$chain_a" ]; then next=$chain_b; else next=$chain_a; fi
  remove_jumps "$next"
  iptables -N "$next" >/dev/null 2>&1 || true
  iptables -F "$next"

  iptables -A "$next" -s "$control_subnet" -m conntrack --ctstate ESTABLISHED,RELATED \
    -m comment --comment ananta-control-established -j ACCEPT
  append_https_rules "$next" "$control_https_hosts" ananta-control-https "$control_subnet"
  iptables -A "$next" -s "$control_subnet" -m comment --comment ananta-control-default-deny -j DROP

  iptables -A "$next" -s "$packager_subnet" -m conntrack --ctstate ESTABLISHED,RELATED \
    -m comment --comment ananta-packager-established -j ACCEPT
  append_https_rules "$next" "$packager_https_hosts" ananta-packager-https "$packager_subnet"
  append_turn_rules "$next" "$packager_turn_hosts"
  iptables -A "$next" -s "$packager_subnet" -m comment --comment ananta-packager-default-deny -j DROP
  iptables -A "$next" -j RETURN

  iptables -I DOCKER-USER 1 -j "$next"
  if [ -n "$current" ]; then
    remove_jumps "$current"
    iptables -F "$current"
  fi
}

verify_policy() {
  chain=$(active_chain || true)
  [ -n "$chain" ] || fail "production egress chain is not active"
  iptables -C "$chain" -s "$control_subnet" -m comment --comment ananta-control-default-deny -j DROP \
    >/dev/null 2>&1 || fail "control default-deny rule missing"
  iptables -C "$chain" -s "$packager_subnet" -m comment --comment ananta-packager-default-deny -j DROP \
    >/dev/null 2>&1 || fail "packager default-deny rule missing"
}

run_guard() {
  case "$refresh_seconds" in
    *[!0-9]*|"") fail "invalid egress refresh interval" ;;
  esac
  [ "$refresh_seconds" -ge 60 ] && [ "$refresh_seconds" -le 3600 ] \
    || fail "egress refresh interval must be between 60 and 3600 seconds"
  while :; do
    apply_policy
    verify_policy
    sleep "$refresh_seconds" &
    wait $!
  done
}

case ${1:-run} in
  apply) apply_policy ;;
  verify) verify_policy ;;
  run) run_guard ;;
  *) fail "usage: production-egress-firewall.sh {apply|verify|run}" ;;
esac
