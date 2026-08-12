#!/bin/sh
# Azure installer — downloads the latest Bun-compiled binary for your OS/arch.
#
#   curl -fsSL https://raw.githubusercontent.com/ATruePerson/azure/main/scripts/install.sh | sh
#
# Installs to ~/.local/bin/azure (no sudo, no Go toolchain needed).
set -eu

REPO="ATruePerson/azure"
BINDIR="${AZURE_BINDIR:-$HOME/.local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin | linux) ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

asset="azure-${os}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset ..."
if ! curl -fsSL "$url" -o "$tmp/$asset"; then
  echo "Download failed. Build from source with: bun run build" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$BINDIR"
mv "$tmp/azure-${os}-${arch}" "$BINDIR/azure"
chmod +x "$BINDIR/azure"

echo "Installed azure to $BINDIR/azure"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "NOTE: $BINDIR is not on your PATH. Add this to your shell profile:"
     echo "      export PATH=\"$BINDIR:\$PATH\"" ;;
esac
echo
echo "Next: run  azure setup"
