#!/bin/bash
# Run a local script on the lampac host:  ./remote-run.sh script.sh
# Password is taken from LAMPAC_PW (or defaults to the known lampac-user password).
set -o pipefail
cd "$(dirname "$0")"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
export LAMPAC_PW="$PW"
LAMPAC_PW="$PW" SSH_ASKPASS="$PWD/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
  exec timeout "${REMOTE_TIMEOUT:-180}" setsid -w ssh \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o NumberOfPasswordPrompts=1 -o PreferredAuthentications=password \
  -o ConnectTimeout=15 -o LogLevel=ERROR \
  lampac-user@lampac.example 'bash -s' < "$1"
