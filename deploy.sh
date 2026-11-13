#!/bin/bash
# EzBOM deploy - push to GitHub Pages & generate QR code
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PAGES_URL="https://not-3-robot.github.io/ezbom/"
QR_FILE="$HOME/Downloads/EzBOM-qrcode.png"

cd "$DIR"

# 资产版本号：每次部署自动 stamp viewer.css / viewer.js 的 ?v=，
# 否则 GitHub Pages 的快取会让使用者续拿旧 CSS/JS（实测改样式后
# 浏览器仍套用旧值，伺服器却已在送新档）。
STAMP="$(date '+%Y%m%d%H%M%S')"
sed -i '' -E "s/(viewer\.(css|js))\?v=[A-Za-z0-9]+/\1?v=${STAMP}/g" viewer.html
echo "🏷  asset version: ${STAMP}"

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
