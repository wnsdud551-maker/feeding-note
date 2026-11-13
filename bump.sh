#!/bin/sh
# Stamp a new version into index.html, app.js and version.json before each release.
v=$(date -u +%Y%m%d%H%M%S)
sed -i -E "s/(app\.js\?v=)[^\"]*/\1$v/; s/(voice-parse\.js\?v=)[^\"]*/\1$v/" index.html
sed -i -E "s/(const APP_VERSION = \")[^\"]*/\1$v/" app.js
printf '{"v":"%s"}\n' "$v" > version.json
echo "$v"
