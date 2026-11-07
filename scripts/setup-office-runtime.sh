#!/bin/sh
set -eu
# Provision dependencies outside the deployed checkout; model scripts stay offline.
source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime=/opt/rai/runtime/office-skills/1852
apt-get update -qq
apt-get install -y --no-install-recommends bubblewrap python3-venv libcairo2 fonts-noto-cjk libreoffice-writer libreoffice-impress libreoffice-calc
python3 "$source_root/scripts/prepare-office-resources.py" "$source_root/skills/office-resources" "$runtime"
python3 -m venv "$runtime/python"
"$runtime/python/bin/pip" install --disable-pip-version-check -r "$source_root/scripts/office-requirements.txt"
python_version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ln -sfn "python/lib/python$python_version/site-packages" "$runtime/python-libs"
mkdir -p "$runtime/bin"
case $(uname -m) in
  x86_64) platform=x64; digest=e540eacc28dff30a61d502d1a24b7ebde53586295fd5c6a213e74458c4a0ad92 ;;
  aarch64) platform=arm64; digest=68a91b828cd1f61cd67a254198dbbc6a421d99c950525fd9cfeb2bef956fa947 ;;
  *) echo 'docx_platform_unsupported' >&2; exit 1 ;;
esac
curl --fail --location --silent --show-error "https://github.com/kklimuk/docx-cli/releases/download/v0.28.0/docx-linux-$platform" -o "$runtime/bin/docx.download"
printf '%s  %s\n' "$digest" "$runtime/bin/docx.download" | sha256sum -c -
chmod 755 "$runtime/bin/docx.download"
mv "$runtime/bin/docx.download" "$runtime/bin/docx"
chmod -R a+rX "$runtime"
echo 'Office runtime ready: pinned docx-cli, PPT Master and Hermes/Bread resources'
