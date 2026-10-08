#!/bin/bash
# EzBOM deploy - push to GitHub Pages & generate QR code
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PAGES_URL="https://not-3-robot.github.io/ezbom/"
QR_FILE="$HOME/Downloads/EzBOM-qrcode.png"

cd "$DIR"

echo "📦 submit and push..."
git add -A
git commit -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')" 2>/dev/null || echo "  (no changes, skip commit)"
git push origin main

echo ""
echo "⏳ waiting GitHub Pages deploy..."
for i in $(seq 1 30); do
  sleep 5
  LAST_MOD=$(curl -sI "$PAGES_URL" 2>/dev/null | grep "last-modified:" | awk -F': ' '{print $2}' | tr -d '\r')
  if [ -n "$LAST_MOD" ]; then
    echo "  ✅ deployed: $LAST_MOD"
    break
  fi
  echo -n "."
done

echo ""
echo "🔳 generate QR code..."
npx --yes qrcode -o "$QR_FILE" -t png "$PAGES_URL"

echo ""
echo "📱 open QR code..."
open "$QR_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ done!"
echo "  🌐 $PAGES_URL"
echo "  📱 QR: $QR_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
