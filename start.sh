#!/usr/bin/env bash
# Start the WhatsApp Contact Sender with the correct Node version.
# Usage: ./start.sh
set -e

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# whatsapp-web.js / puppeteer require Node >= 18; use 20 if available.
nvm use 20 >/dev/null 2>&1 || true

echo "Node: $(node -v)"
echo "Starting WhatsApp Contact Sender on http://localhost:${PORT:-3000} ..."
exec node server.js
