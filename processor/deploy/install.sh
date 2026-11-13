#!/usr/bin/env bash
# Idempotent installer for l1-image-processor. Run as root from the repo checkout:
#   sudo bash processor/deploy/install.sh
# Never creates or prints secrets.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$SRC/processor/package.json" ] && [ -d "$SRC/shared" ] || { echo "Run from a repo checkout containing processor/ and shared/." >&2; exit 1; }
DEST=/opt/l1-image-processor
ETC=/etc/l1-image-processor
NPM="npx -y npm@11.6.2"

id l1img >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin l1img

install -d -m 0755 -o root -g root "$DEST"
rsync -a --delete --exclude node_modules --exclude '.git' --exclude test "$SRC/processor/" "$DEST/processor/"
rsync -a --delete "$SRC/shared/" "$DEST/shared/"
(cd "$DEST/processor" && $NPM ci --omit=dev --no-audit --no-fund)
chown -R root:root "$DEST"
chmod -R go-w,a+rX "$DEST"

install -d -m 0750 -o root -g l1img "$ETC"
if [ -f "$ETC/env" ]; then
  mode="$(stat -c '%a %U:%G' "$ETC/env")"
  if [ "$mode" != "640 root:l1img" ]; then
    echo "ERROR: $ETC/env must be 0640 root:l1img (found $mode). Fix with: sudo chown root:l1img $ETC/env && sudo chmod 0640 $ETC/env" >&2
    exit 1
  fi
else
  cat >&2 <<MSG
$ETC/env does not exist. Create it as the owner WITHOUT putting values in argv or shell history (see docs/ops/aiw-image-processor.md):
  sudo install -m 0640 -o root -g l1img /dev/null $ETC/env
  { printf 'L1_API_BASE='; read -r v; printf '%s\n' "\$v"; } | sudo tee -a $ETC/env >/dev/null   # repeat per variable; names in processor/deploy/env.example
Then re-run this installer.
MSG
  exit 1
fi

install -m 0644 "$DEST/processor/deploy/l1-image-processor.service" /etc/systemd/system/l1-image-processor.service
systemctl daemon-reload
systemctl enable l1-image-processor.service
systemctl restart l1-image-processor.service

sleep 2
( cd "$DEST/processor" && setpriv --reuid=l1img --regid=l1img --clear-groups /usr/bin/node --env-file="$ETC/env" src/index.js --health ) \
  || { echo "Health check FAILED. See: journalctl -u l1-image-processor -n 50" >&2; exit 1; }
echo "l1-image-processor installed and healthy."
