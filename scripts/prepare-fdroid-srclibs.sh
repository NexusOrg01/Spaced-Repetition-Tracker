#!/usr/bin/env bash
set -euo pipefail

DEST_ROOT="${1:?Usage: prepare-fdroid-srclibs.sh <build/srclib-directory>}"
mkdir -p "$DEST_ROOT"
DEST_ROOT="$(cd "$DEST_ROOT" && pwd)"

stage_srclib() {
  local name="$1"
  local repository="$2"
  local revision="$3"
  local destination="$DEST_ROOT/$name"

  if [[ -e "$destination" ]]; then
    echo "Refusing to replace existing source-library checkout: $destination" >&2
    exit 1
  fi

  echo "Staging $name at $revision"
  git init --quiet "$destination"
  git -C "$destination" remote add origin "$repository"
  git -C "$destination" fetch --quiet --depth=1 --no-tags origin "$revision"
  git -C "$destination" checkout --quiet --detach FETCH_HEAD

  local actual_revision
  actual_revision="$(git -C "$destination" rev-parse HEAD)"
  if [[ "$actual_revision" != "$revision" ]]; then
    echo "Unexpected $name source revision: $actual_revision" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
    echo "$name source checkout is not clean." >&2
    exit 1
  fi
}

stage_srclib "nodejs" "https://github.com/nodejs/node.git" "27f213124280b4db4cd1e3dd42f6f8afd01ceff7"
stage_srclib "esbuild" "https://github.com/evanw/esbuild.git" "609683d892977362a0f99026cb74b96263d728a9"
stage_srclib "golang-sys" "https://github.com/golang/sys.git" "c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf"

echo "All pinned F-Droid source libraries are staged and verified."
