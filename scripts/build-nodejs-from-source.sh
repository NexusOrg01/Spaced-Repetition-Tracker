#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="\${1:?Usage: build-nodejs-from-source.sh <pinned-node-source-dir> <install-prefix>}"
INSTALL_PREFIX="\${2:?Usage: build-nodejs-from-source.sh <pinned-node-source-dir> <install-prefix>}"
EXPECTED_COMMIT="27f213124280b4db4cd1e3dd42f6f8afd01ceff7"
EXPECTED_VERSION="v22.23.4"
EXPECTED_NPM_VERSION="10.9.9"

SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
mkdir -p "$INSTALL_PREFIX"
INSTALL_PREFIX="$(cd "$INSTALL_PREFIX" && pwd)"

if [[ -d "$SOURCE_DIR/.git" ]]; then
  actual_commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
  if [[ "$actual_commit" != "$EXPECTED_COMMIT" ]]; then
    echo "Unexpected Node.js source commit: $actual_commit" >&2
    exit 1
  fi
fi

version_header="$SOURCE_DIR/src/node_version.h"
npm_package="$SOURCE_DIR/deps/npm/package.json"
test -f "$version_header"
test -f "$npm_package"

grep -Eq '^#define NODE_MAJOR_VERSION 22$' "$version_header"
grep -Eq '^#define NODE_MINOR_VERSION 23$' "$version_header"
grep -Eq '^#define NODE_PATCH_VERSION 4$' "$version_header"
node_npm_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$npm_package")"
if [[ "$node_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then
  echo "Unexpected bundled npm version: $node_npm_version" >&2
  exit 1
fi

jobs="\${NEXUS_NODE_BUILD_JOBS:-2}"
case "$jobs" in
  ''|*[!0-9]*) echo "NEXUS_NODE_BUILD_JOBS must be a positive integer." >&2; exit 1 ;;
esac
if (( jobs < 1 )); then
  echo "NEXUS_NODE_BUILD_JOBS must be at least 1." >&2
  exit 1
fi

echo "Building Node.js $EXPECTED_VERSION from pinned source with $jobs parallel job(s)."
cd "$SOURCE_DIR"
./configure --prefix="$INSTALL_PREFIX"
make -j"$jobs"
make install

export PATH="$INSTALL_PREFIX/bin:$PATH"
actual_node_version="$(node --version)"
actual_npm_version="$(npm --version)"
if [[ "$actual_node_version" != "$EXPECTED_VERSION" ]]; then
  echo "Built Node version mismatch: $actual_node_version" >&2
  exit 1
fi
if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then
  echo "Bundled npm version mismatch: $actual_npm_version" >&2
  exit 1
fi

echo "Verified source-built $actual_node_version with npm $actual_npm_version."
