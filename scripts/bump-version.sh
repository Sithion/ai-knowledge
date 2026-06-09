#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.8.0"
  exit 1
fi

VERSION="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Bumping all packages to v${VERSION}..."

# JSON package.json files (using node for reliable JSON editing)
JSON_FILES=(
  "$ROOT/package.json"
  "$ROOT/apps/dashboard/package.json"
  "$ROOT/apps/mcp-server/package.json"
  "$ROOT/packages/shared/package.json"
  "$ROOT/packages/sdk/package.json"
  "$ROOT/packages/core/package.json"
  "$ROOT/packages/config/package.json"
  "$ROOT/packages/embeddings/package.json"
)

for file in "${JSON_FILES[@]}"; do
  if [ -f "$file" ]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$file', 'utf8'));
      pkg.version = '$VERSION';
      fs.writeFileSync('$file', JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  Updated $(basename "$(dirname "$file")")/$(basename "$file")"
  fi
done

# Cargo.toml
CARGO="$ROOT/apps/dashboard/src-tauri/Cargo.toml"
if [ -f "$CARGO" ]; then
  sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$CARGO"
  echo "  Updated Cargo.toml"
fi

echo ""
echo "Done! All packages bumped to v${VERSION}"
echo ""
echo "Files changed:"
git -C "$ROOT" diff --name-only
