#!/usr/bin/env bash
# Creates the Hetzner Cloud firewall and server with the hcloud CLI (https://github.com/hetznercloud/cli).
#   export HCLOUD_TOKEN=…                      # project API token (read & write)
#   SERVER_TYPE=<type> LOCATION=hel1 deploy/hcloud-setup.sh ~/.ssh/id_ed25519.pub
# Pick SERVER_TYPE from `hcloud server-type list` (2 vCPU / 4 GB is plenty to start).
set -Eeuo pipefail
KEY_FILE="${1:?usage: hcloud-setup.sh <ssh-public-key-file>}"
NAME="${NAME:-time2live}"
SERVER_TYPE="${SERVER_TYPE:?set SERVER_TYPE (see: hcloud server-type list)}"
LOCATION="${LOCATION:-hel1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! hcloud ssh-key describe "$NAME" >/dev/null 2>&1; then
  hcloud ssh-key create --name "$NAME" --public-key-from-file "$KEY_FILE"
fi

if ! hcloud firewall describe "$NAME" >/dev/null 2>&1; then
  rules="$(mktemp)"
  cat >"$rules" <<'JSON'
[
  {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ssh"},
  {"direction": "in", "protocol": "tcp", "port": "80", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http"},
  {"direction": "in", "protocol": "tcp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "https"},
  {"direction": "in", "protocol": "udp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http3"},
  {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ping"}
]
JSON
  hcloud firewall create --name "$NAME" --rules-file "$rules"
  rm -f "$rules"
fi

userdata="$(mktemp)"
"$HERE/make-cloud-init.sh" "$KEY_FILE" >"$userdata"
hcloud server create --name "$NAME" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION" \
  --ssh-key "$NAME" --firewall "$NAME" --user-data-from-file "$userdata"
rm -f "$userdata"
hcloud server describe "$NAME" -o format='IPv4: {{.PublicNet.IPv4.IP}}  IPv6: {{.PublicNet.IPv6.IP}}'
echo "Provisioning runs on first boot (a few minutes). Then check:"
echo "  ssh deploy@<ip> 'sudo tail -n 30 /var/log/time2live-provision.log && docker version'"
