#!/bin/sh
set -eu

CHANNEL_URL="${RAI_AGENT_CHANNEL_URL:-https://github.com/Rick-953/RAI/releases/latest/download/local-agent-channel.json}"
REPOSITORY="Rick-953/RAI"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rai-agent-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "RAI Agent installer requires $1" >&2
    exit 1
  }
}

need curl
need tar
need unzip
curl --fail --location --proto '=https' --tlsv1.2 "$CHANNEL_URL" -o "$TMP_DIR/channel.json"

json_value() {
  path="$1"
  file="${2:-$TMP_DIR/channel.json}"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$path" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -er ".${path}" "$file"
  else
    echo "RAI Agent installer requires python3 or jq to parse the signed channel" >&2
    exit 1
  fi
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="macos-aarch64" ;;
  Darwin-x86_64) PLATFORM="macos-x86_64" ;;
  Linux-x86_64) PLATFORM="linux-x86_64" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

VERSION="$(json_value version)"
URL="$(json_value "artifacts.${PLATFORM}.url")"
EXPECTED_SHA="$(json_value "artifacts.${PLATFORM}.sha256")"
CHROME_ID="$(json_value extensions.chrome)"
EDGE_ID="$(json_value extensions.edge)"
EXTENSION_ID="$(json_value extensions.id)"
EXTENSION_DISTRIBUTION="$(json_value extensions.distribution)"
EXTENSION_URL="$(json_value extensions.artifact.url)"
EXTENSION_SHA="$(json_value extensions.artifact.sha256)"

case "$VERSION:$EXPECTED_SHA:$EXTENSION_SHA:$CHROME_ID:$EDGE_ID:$EXTENSION_ID:$EXTENSION_DISTRIBUTION" in
  *[!-A-Za-z0-9._:]*) echo "Invalid release channel values" >&2; exit 1 ;;
esac
[ "$(expr "$EXPECTED_SHA" : '[a-f0-9]\{64\}$')" -eq 64 ] || { echo "Invalid release checksum" >&2; exit 1; }
[ "$(expr "$EXTENSION_SHA" : '[a-f0-9]\{64\}$')" -eq 64 ] || { echo "Invalid extension checksum" >&2; exit 1; }
[ "$EXTENSION_DISTRIBUTION" = "github-unpacked" ] || { echo "Unsupported extension distribution" >&2; exit 1; }
[ "$CHROME_ID" = "$EXTENSION_ID" ] && [ "$EDGE_ID" = "$EXTENSION_ID" ] || { echo "Extension origin mismatch" >&2; exit 1; }
[ "$(expr "$EXTENSION_ID" : '[a-p]\{32\}$')" -eq 32 ] || { echo "Invalid RAI Connect extension ID" >&2; exit 1; }
case "$URL:$EXTENSION_URL" in https://*:https://*) ;; *) echo "Release artifacts must use HTTPS" >&2; exit 1 ;; esac

ARCHIVE="$TMP_DIR/rai-agent.tar.gz"
EXTENSION_ARCHIVE="$TMP_DIR/rai-connect-extension.zip"
curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$ARCHIVE"
curl --fail --location --proto '=https' --tlsv1.2 "$EXTENSION_URL" -o "$EXTENSION_ARCHIVE"

verify_sha256() {
  file="$1"
  expected="$2"
  label="$3"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  [ "$actual" = "$expected" ] || { echo "$label checksum mismatch" >&2; exit 1; }
}

verify_sha256 "$ARCHIVE" "$EXPECTED_SHA" "RAI Agent"
verify_sha256 "$EXTENSION_ARCHIVE" "$EXTENSION_SHA" "RAI Connect"

if command -v gh >/dev/null 2>&1; then
  gh attestation verify "$ARCHIVE" --repo "$REPOSITORY" --signer-workflow "$REPOSITORY/.github/workflows/local-agent-release.yml" >/dev/null
  gh attestation verify "$EXTENSION_ARCHIVE" --repo "$REPOSITORY" --signer-workflow "$REPOSITORY/.github/workflows/local-agent-release.yml" >/dev/null
elif [ "${RAI_REQUIRE_ATTESTATION:-0}" = "1" ]; then
  echo "gh is required when RAI_REQUIRE_ATTESTATION=1" >&2
  exit 1
fi

INSTALL_ROOT="${RAI_AGENT_INSTALL_ROOT:-$HOME/.local/share/rai-agent}"
VERSIONS="$INSTALL_ROOT/versions"
TARGET="$VERSIONS/$VERSION"
mkdir -p "$TARGET" "$HOME/.local/bin"
tar -xzf "$ARCHIVE" -C "$TARGET"
chmod 700 "$TARGET/rai-agent"
ln -sfn "$TARGET/rai-agent" "$INSTALL_ROOT/current.tmp"
mv -f "$INSTALL_ROOT/current.tmp" "$INSTALL_ROOT/current"
ln -sfn "$INSTALL_ROOT/current" "$HOME/.local/bin/rai-agent.tmp"
mv -f "$HOME/.local/bin/rai-agent.tmp" "$HOME/.local/bin/rai-agent"

EXTENSION_TARGET="$INSTALL_ROOT/extension"
EXTENSION_STAGING="$INSTALL_ROOT/.extension-$VERSION-$$"
EXTENSION_BACKUP="$INSTALL_ROOT/.extension-previous-$$"
mkdir -p "$EXTENSION_STAGING"
unzip -q "$EXTENSION_ARCHIVE" -d "$EXTENSION_STAGING"
[ -f "$EXTENSION_STAGING/manifest.json" ] || { echo "RAI Connect manifest missing from archive" >&2; exit 1; }
[ "$(json_value version "$EXTENSION_STAGING/manifest.json")" = "$VERSION" ] || { echo "RAI Connect version mismatch" >&2; exit 1; }
if [ -e "$EXTENSION_TARGET" ]; then mv "$EXTENSION_TARGET" "$EXTENSION_BACKUP"; fi
if ! mv "$EXTENSION_STAGING" "$EXTENSION_TARGET"; then
  if [ -e "$EXTENSION_BACKUP" ]; then mv "$EXTENSION_BACKUP" "$EXTENSION_TARGET"; fi
  exit 1
fi
if [ -e "$EXTENSION_BACKUP" ]; then rm -rf "$EXTENSION_BACKUP"; fi

find "$VERSIONS" -mindepth 1 -maxdepth 1 -type d -print | sort -r | tail -n +3 | while IFS= read -r old; do
  case "$old" in "$VERSIONS"/*) rm -rf "$old" ;; *) exit 1 ;; esac
done

"$INSTALL_ROOT/current" install --chrome-id "$CHROME_ID" --edge-id "$EDGE_ID" --open-store=false

case "$(uname -s)" in
  Darwin)
    if open -Ra "Google Chrome" >/dev/null 2>&1; then open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true; fi
    if open -Ra "Microsoft Edge" >/dev/null 2>&1; then open -a "Microsoft Edge" "edge://extensions" >/dev/null 2>&1 || true; fi
    open "https://rai.rick.sarl/?local-agent=connect" >/dev/null 2>&1 || true
    ;;
  Linux)
    if command -v google-chrome >/dev/null 2>&1; then google-chrome "chrome://extensions" >/dev/null 2>&1 & fi
    if command -v microsoft-edge >/dev/null 2>&1; then microsoft-edge "edge://extensions" >/dev/null 2>&1 & fi
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "https://rai.rick.sarl/?local-agent=connect" >/dev/null 2>&1 & fi
    ;;
esac

echo "RAI Agent $VERSION and RAI Connect were downloaded and verified."
echo "In chrome://extensions or edge://extensions, enable Developer mode, choose Load unpacked, and select:"
echo "  $EXTENSION_TARGET"
echo "Then bind this device in RAI Settings > Security."
