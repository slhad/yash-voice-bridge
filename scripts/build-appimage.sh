#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"
APPDIR="${APPDIR:-$ROOT_DIR/AppDir}"
VERSION="${VERSION:-dev}"
APP_NAME="yash-voice-bridge"
APP_ID="io.github.slhad.yash-voice-bridge"
APPIMAGE_NAME="${APPIMAGE_NAME:-${APP_NAME}-${VERSION}-x86_64.AppImage}"

mkdir -p "$DIST_DIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/scalable/apps"
mkdir -p "$APPDIR/usr/share/metainfo"

bun build --compile --target=bun-linux-x64 "$ROOT_DIR/src/index.ts" --outfile "$DIST_DIR/$APP_NAME"

cp "$DIST_DIR/$APP_NAME" "$APPDIR/usr/bin/$APP_NAME"

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/yash-voice-bridge" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

cp "$ROOT_DIR/packaging/yash-voice-bridge.desktop" "$APPDIR/$APP_ID.desktop"
printf '\nX-AppImage-Version=%s\n' "$VERSION" >> "$APPDIR/$APP_ID.desktop"
cp "$APPDIR/$APP_ID.desktop" "$APPDIR/usr/share/applications/$APP_ID.desktop"
cp "$ROOT_DIR/packaging/yash-voice-bridge.svg" "$APPDIR/$APP_NAME.svg"
cp "$ROOT_DIR/packaging/yash-voice-bridge.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/$APP_NAME.svg"
cp "$ROOT_DIR/packaging/yash-voice-bridge.appdata.xml" "$APPDIR/usr/share/metainfo/$APP_ID.appdata.xml"
ln -sf "$APP_NAME.svg" "$APPDIR/.DirIcon"

if [[ ! -x "${APPIMAGETOOL:-}" ]]; then
  APPIMAGETOOL="${APPIMAGETOOL:-$ROOT_DIR/appimagetool}"
  if [[ ! -x "$APPIMAGETOOL" ]]; then
    wget -q -O "$APPIMAGETOOL" \
      https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
    chmod +x "$APPIMAGETOOL"
  fi
fi

APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$APPIMAGETOOL" "$APPDIR" "$ROOT_DIR/$APPIMAGE_NAME"
echo "Built $ROOT_DIR/$APPIMAGE_NAME"
