#!/usr/bin/env bash
set -euo pipefail

ESBUILD_SOURCE_DIR="${1:?Usage: build-esbuild-from-source.sh <esbuild-source-dir> <golang-sys-source-dir> <output-path>}"
GO_SYS_SOURCE_DIR="${2:?Usage: build-esbuild-from-source.sh <esbuild-source-dir> <golang-sys-source-dir> <output-path>}"
OUTPUT_PATH="${3:?Usage: build-esbuild-from-source.sh <esbuild-source-dir> <golang-sys-source-dir> <output-path>}"

EXPECTED_ESBUILD_COMMIT="609683d892977362a0f99026cb74b96263d728a9"
EXPECTED_GO_SYS_COMMIT="c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf"
EXPECTED_ESBUILD_VERSION="0.28.2"
EXPECTED_GO_SYS_VERSION="v0.0.0-20220715151400-c0bba94af5f8"

ESBUILD_SOURCE_DIR="$(cd "$ESBUILD_SOURCE_DIR" && pwd)"
GO_SYS_SOURCE_DIR="$(cd "$GO_SYS_SOURCE_DIR" && pwd)"
case "$OUTPUT_PATH" in
  /*) ;;
  *) OUTPUT_PATH="$PWD/$OUTPUT_PATH" ;;
esac
mkdir -p "$(dirname "$OUTPUT_PATH")"

if ! command -v go >/dev/null 2>&1; then
  echo "Go compiler is required to build esbuild from source; install the Debian golang-go package." >&2
  exit 1
fi
go version

actual_esbuild_commit="$(git -C "$ESBUILD_SOURCE_DIR" rev-parse HEAD)"
actual_go_sys_commit="$(git -C "$GO_SYS_SOURCE_DIR" rev-parse HEAD)"
if [[ "$actual_esbuild_commit" != "$EXPECTED_ESBUILD_COMMIT" ]]; then
  echo "Unexpected esbuild source commit: $actual_esbuild_commit" >&2
  exit 1
fi
if [[ "$actual_go_sys_commit" != "$EXPECTED_GO_SYS_COMMIT" ]]; then
  echo "Unexpected golang.org/x/sys source commit: $actual_go_sys_commit" >&2
  exit 1
fi
grep -Fq '"version": "0.28.2"' "$ESBUILD_SOURCE_DIR/npm/esbuild/package.json"
grep -Fq "golang.org/x/sys $EXPECTED_GO_SYS_VERSION" "$ESBUILD_SOURCE_DIR/go.mod"
grep -Fq 'module golang.org/x/sys' "$GO_SYS_SOURCE_DIR/go.mod"
test -f "$ESBUILD_SOURCE_DIR/LICENSE.md"
test -f "$GO_SYS_SOURCE_DIR/LICENSE"

(
  cd "$ESBUILD_SOURCE_DIR"
  go mod edit -replace="golang.org/x/sys=$GO_SYS_SOURCE_DIR"
  GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOWORK=off \
    go build -trimpath -buildvcs=false -ldflags='-buildid=' \
    -o "$OUTPUT_PATH" ./cmd/esbuild
)

actual_version="$("$OUTPUT_PATH" --version)"
if [[ "$actual_version" != "$EXPECTED_ESBUILD_VERSION" ]]; then
  echo "Built esbuild version $actual_version; expected $EXPECTED_ESBUILD_VERSION." >&2
  exit 1
fi
echo "Built esbuild $actual_version from pinned source with Go module network access disabled."
