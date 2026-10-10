#!/bin/bash
# upload-lampac.sh <local-file> <remote-path> [owner:group]
# Кладёт файл на lampac-хост через ssh (файл едет base64 в stdin, а не в heredoc).
set -euo pipefail
cd "$(dirname "$0")"
LOCAL="$1"; REMOTE="$2"; OWNER="${3:-root:lampac-editors}"
PW="${LAMPAC_PW:-${LAMPAC_PW:?}}"
TMP=/tmp/dsh-upload.b64

ssh_run() {
  PW="$PW" SSH_ASKPASS="$PWD/askpass-lampac.sh" SSH_ASKPASS_REQUIRE=force \
    setsid -w ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o NumberOfPasswordPrompts=1 -o PreferredAuthentications=password \
    -o ConnectTimeout=15 -o LogLevel=ERROR lampac-user@lampac.example "$@"
}

base64 -w0 "$LOCAL" | ssh_run "cat > $TMP"
ssh_run "echo '$PW' | sudo -S -p '' bash -c 'base64 -d $TMP > \"$REMOTE\" && chown $OWNER \"$REMOTE\" && chmod 644 \"$REMOTE\" && md5sum \"$REMOTE\"'"
md5sum "$LOCAL"
