#!/usr/bin/env bash
# Refresh the vendored core from a local PlugMem checkout.
#
#   PLUGMEM_SRC=~/dev/PlugMem/plugmem-coding-core/src npm run sync-core
#
# Vendoring (rather than depending on @plugmem/coding-core) keeps this
# plugin installable from a single repository: the core is not published
# to npm yet. Review the diff before committing.
set -euo pipefail

SRC="${PLUGMEM_SRC:-$HOME/dev/PlugMem/plugmem-coding-core/src}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/vendor/core"

if [[ ! -d "$SRC" ]]; then
  echo "core source not found: $SRC" >&2
  echo "set PLUGMEM_SRC to the plugmem-coding-core/src directory" >&2
  exit 1
fi

count=0
for file in "$SRC"/*.ts; do
  cp "$file" "$DEST/"
  count=$((count + 1))
done

echo "synced $count files from $SRC -> $DEST"
echo "NOTE: upstream files do not contain the local patches listed in NOTICE."
echo "Re-apply them (client.ts health path, repo_id.ts graph names) before building."
echo "next: npm run typecheck && npm test"
