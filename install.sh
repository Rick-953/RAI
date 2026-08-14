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
curl --fail --location --proto '=https' --tlsv1.2 "$CHANNEL_URL" -o "$TMP_DIR/channel.json"

json_value() {
  path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$TMP_DIR/channel.json" "$path" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
  elif command -v jq >/dev/null 2>&1; then
    jq -er ".${path}" "$TMP_DIR/channel.json"
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

case "$VERSION:$EXPECTED_SHA:$CHROME_ID:$EDGE_ID" in
  *[!A-Za-z0-9._:-]*) echo "Invalid release channel values" >&2; exit 1 ;;
esac
[ "$(expr "$EXPECTED_SHA" : '[a-f0-9]\{64\}$')" -eq 64 ] || { echo "Invalid release checksum" >&2; exit 1; }
[ "$(expr "$CHROME_ID" : '[a-p]\{32\}$')" -eq 32 ] || { echo "The Chrome extension ID is not configured in this release channel" >&2; exit 1; }
[ "$(expr "$EDGE_ID" : '[a-p]\{32\}$')" -eq 32 ] || { echo "The Edge extension ID is not configured in this release channel" >&2; exit 1; }

ARCHIVE="$TMP_DIR/rai-agent.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 "$URL" -o "$ARCHIVE"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
else
  ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
fi
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo "RAI Agent checksum mismatch" >&2; exit 1; }

if command -v gh >/dev/null 2>&1; then
  gh attestation verify "$ARCHIVE" --repo "$REPOSITORY" --signer-workflow "$REPOSITORY/.github/workflows/local-agent-release.yml" >/dev/null
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

find "$VERSIONS" -mindepth 1 -maxdepth 1 -type d -print | sort -r | tail -n +3 | while IFS= read -r old; do
  case "$old" in "$VERSIONS"/*) rm -rf "$old" ;; *) exit 1 ;; esac
done

"$INSTALL_ROOT/current" install --chrome-id "$CHROME_ID" --edge-id "$EDGE_ID"
echo "RAI Agent $VERSION installed. Confirm the extension installation in the browser, then bind this device in RAI Settings > Security."
