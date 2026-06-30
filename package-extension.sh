#!/usr/bin/env bash
# Package only the runtime files into a Chrome Web Store upload zip.
# Dev/review docs (Agent.md, README, PRIVACY source, scripts) are EXCLUDED
# so they never ship inside the published package.
set -euo pipefail

cd "$(dirname "$0")"
OUT="figma-design-reviewer.zip"
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  content/content.js \
  content/content.css \
  panel/panel.html \
  panel/panel.js \
  panel/panel.css \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png \
  > /dev/null

echo "Created $OUT containing only runtime files:"
unzip -l "$OUT" | awk 'NR>3 && $4 {print "  " $4}'
echo "Excluded: Agent.md, README.md, PRIVACY.md, LICENSE, *.sh, scratch/test files."
