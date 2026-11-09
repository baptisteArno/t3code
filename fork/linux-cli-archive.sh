#!/bin/bash
# Build the fork's linux-x64 server archive (t3-<version>-linux-x64.tar.gz) from a pushed commit,
# replaying the per-target steps of upstream's release workflows. See fork/README.md.
# Runs on the home server (Linux x64); fork/nightly.sh pipes it there over SSH:
#
#   ssh nuc bash -s -- <commit> <version> < fork/linux-cli-archive.sh
#
# Logs go to stderr; the last stdout line is the archive's absolute path.
set -euo pipefail

# Read whole before running: the script arrives on stdin, which no build step may consume.
main() {
  exec </dev/null
  [ "$#" -eq 2 ] || { echo "Usage: linux-cli-archive.sh <commit> <version>" >&2; exit 64; }
  commit="$1"
  version="$2"
  checkout="$HOME/Dev/forks/t3code-fork"
  builder="$HOME/Dev/forks/t3code-fork-linux"
  releases="$HOME/Dev/forks/t3code-fork-linux-releases"
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/vite-plus/bin:$PATH"
  log() { printf '[fork-linux] %s\n' "$*" >&2; }

  [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { log "Run this on a Linux x64 host."; exit 1; }
  for tool in git node vp cargo patchelf; do
    command -v "$tool" >/dev/null || { log "Missing $tool (see fork/README.md)."; exit 1; }
  done

  # The fork's release tags reuse upstream's names on fork commits, so never fetch tags from origin.
  git -C "$checkout" fetch --quiet --no-tags origin
  git -C "$checkout" cat-file -e "$commit^{commit}" || { log "Commit $commit is not on origin."; exit 1; }
  if [ ! -d "$builder" ]; then
    git -C "$checkout" worktree add --quiet --detach "$builder" "$commit"
  fi
  cd "$builder"
  git checkout --quiet --force --detach "$commit"
  # Dependencies and the Rust build cache survive; every other untracked or ignored file goes.
  git clean --quiet -ffdx -e node_modules -e target
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$commit^{commit}")" ] || { log "Checkout is not $commit."; exit 1; }

  log "Building the linux-x64 server archive of $version from $(git rev-parse --short HEAD)."
  # Public T3 Connect identifiers of the production deployment, as fork/nightly.sh uses.
  cp .env.example .env
  vp i >&2
  node scripts/update-release-package-versions.ts "$version" >&2
  vp run build:desktop:bundle >&2
  brand=production
  if [[ "$version" =~ -nightly\.[0-9]{8}\.[0-9]+$ ]]; then brand=nightly; fi
  node scripts/apply-web-brand-assets.ts "$brand" apps/server/dist/client >&2

  vp run build:resource-monitor >&2
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$work/resource-monitor/linux-x64"
  cp native/resource-monitor/target/release/t3-resource-monitor "$work/resource-monitor/linux-x64/"

  # A target build embeds the exact engines.node release instead of this host's Node.
  node apps/server/scripts/cli.ts build-exe --target linux-x64 >&2
  out="$releases/$version"
  rm -rf "$out"
  mkdir -p "$out"
  node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
    --resource-monitor-dir "$work/resource-monitor" --output-dir "$out" >&2
  archive="$out/t3-$version-linux-x64.tar.gz"
  [ -f "$archive" ] || { log "No $archive was produced."; exit 1; }
  node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version" >&2
  log "Built and smoke-tested $archive ($(sha256sum "$archive" | cut -d' ' -f1))."

  # Keep the two newest builds.
  builds="$(ls -d "$releases"/*/ 2>/dev/null | sort -V)"
  count="$(printf '%s\n' "$builds" | grep -c . || true)"
  if [ "$count" -gt 2 ]; then
    printf '%s\n' "$builds" | head -n "$((count - 2))" | while read -r old; do rm -rf "$old"; done
  fi
  echo "$archive"
}
main "$@"
