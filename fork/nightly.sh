#!/bin/bash
# Rebase the fork onto the newest upstream nightly, build the signed macOS app
# here and the linux-x64 server archive on the home server, both with that
# nightly's exact version, and publish them as one release of the fork.
# See fork/README.md. macOS only; bash 3.2 compatible.
#
#   fork/nightly.sh               release the newest upstream nightly if the fork lacks it
#   fork/nightly.sh --no-publish  build and verify, publish nothing
#
# Exit codes: 0 released or already up to date, 2 rebase stopped on a conflict,
# 3 checkout not ready (wrong branch, dirty tree, rebase in progress), other: failure.
set -euo pipefail

FORK_REPO=baptisteArno/t3code
UPSTREAM_REPO=pingdotgg/t3code
BRANCH=custom-nightly
SIGNING_ENV="${T3CODE_FORK_SIGNING_ENV:-$HOME/.config/t3code-fork/signing.env}"
LINUX_BUILDER="${T3CODE_FORK_LINUX_BUILDER:-nuc}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

publish=1
for arg in "$@"; do
  case "$arg" in
    --no-publish) publish=0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 64 ;;
  esac
done

# Always the main checkout (the builder), even when started from one of its worktrees.
root="$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")"
cd "$root"
log() { printf '[fork-nightly] %s\n' "$*"; }

git_dir="$(git rev-parse --git-dir)"
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
  log "A rebase is in progress: resolve it, run 'git rebase --continue', then rerun."
  exit 3
fi
if [ "$(git branch --show-current)" != "$BRANCH" ]; then
  log "Check out $BRANCH first."
  exit 3
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "Tracked files have uncommitted changes; commit or stash them first."
  exit 3
fi

# The fork's release tags reuse upstream's names on fork commits; only upstream's may exist locally.
git config remote.origin.tagOpt --no-tags
git fetch --quiet --force --tags upstream
git fetch --quiet --no-tags origin
# origin/custom-nightly is the source of truth: changes land there from any machine.
remote="origin/$BRANCH"
if git rev-parse --verify --quiet "$remote" >/dev/null; then
  if git merge-base --is-ancestor HEAD "$remote"; then
    git merge --quiet --ff-only "$remote"
  # A rerun after this script rebased the branch finds the tip of $remote in its reflog, not its history.
  elif ! git merge-base --is-ancestor "$remote" HEAD &&
    ! git reflog show --format=%H "$BRANCH" | grep -Fx "$(git rev-parse "$remote")" >/dev/null; then
    log "$BRANCH and $remote have diverged: rebase the local commits onto $remote, then rerun."
    exit 3
  fi
fi
tag="$(git tag -l 'v*-nightly.*' | awk -F'nightly.' '{print $2" "$0}' | sort -V | tail -1 | cut -d' ' -f2)"
[ -n "$tag" ] || { log "No upstream nightly tag found."; exit 1; }
version="${tag#v}"

if [ "$publish" = 1 ]; then
  # A run that died mid-publish leaves a draft; it does not count as released.
  draft="$(gh release view "$tag" --repo "$FORK_REPO" --json isDraft --jq .isDraft 2>/dev/null || true)"
  if [ "$draft" = false ]; then
    log "The fork already released $version."
    exit 0
  fi
  if [ "$draft" = true ]; then
    log "Deleting the unfinished draft of $version."
    gh release delete "$tag" --repo "$FORK_REPO" --yes
  fi
fi

if git merge-base --is-ancestor "$tag" HEAD; then
  log "Already based on $tag."
else
  log "Rebasing $BRANCH onto $tag."
  if ! git rebase --quiet "$tag"; then
    log "CONFLICT while rebasing onto $tag. Resolve it (see fork/README.md), run 'git rebase --continue', then rerun."
    exit 2
  fi
fi

log "Installing dependencies."
vp i >/dev/null
# Browser tests need the Chromium of the Playwright version upstream pins; a no-op once installed.
(cd apps/web && pnpm exec playwright install chromium >/dev/null)
# macOS temp dirs sit behind the /var -> /private/var symlink that git resolves; upstream tests compare both.
export TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)/"
log "Checking the fork's changes against $tag."
vp run check:changed "$tag"

# Public T3 Connect identifiers of the production deployment, kept in step with upstream.
cp .env.example .env

[ -f "$SIGNING_ENV" ] || { log "Missing signing env $SIGNING_ENV."; exit 1; }
set -a
# shellcheck disable=SC1090
. "$SIGNING_ENV"
set +a
export APPLE_API_KEY="$APPLE_API_KEY_PATH"
export T3CODE_MACOS_SIGN_WITHOUT_PASSKEYS=1
export T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPO"

out="$root/release/$version"
rm -rf "$out"
log "Building, signing and notarizing T3 Code $version."
vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version "$version" --signed --output-dir "$out"

feed="$out/nightly-mac.yml"
[ -f "$feed" ] || { log "No nightly-mac.yml in $out."; exit 1; }
grep -q "^version: $version$" "$feed" || { log "nightly-mac.yml does not announce $version."; exit 1; }
zip="$(ls "$out"/*.zip | head -1)"
check_dir="$(mktemp -d)"
trap 'rm -rf "$check_dir"' EXIT
ditto -x -k "$zip" "$check_dir"
app="$(ls -d "$check_dir"/*.app | head -1)"
codesign --verify --deep --strict "$app"
spctl --assess --type execute "$app"
xcrun stapler validate "$app" >/dev/null
grep -q "owner: ${FORK_REPO%/*}" "$app/Contents/Resources/app-update.yml" ||
  { log "The app does not update from $FORK_REPO."; exit 1; }
log "Verified signature, notarization and update feed."

if [ "$publish" = 0 ]; then
  log "Built $out without publishing; the linux-x64 server archive needs a pushed commit."
  exit 0
fi

# The Linux builder fetches the commit from origin.
git push --quiet --force-with-lease origin "$BRANCH"
log "Building the linux-x64 server archive on $LINUX_BUILDER."
remote_archive="$(ssh -o BatchMode=yes "$LINUX_BUILDER" bash -s -- "$(git rev-parse HEAD)" "$version" \
  <fork/linux-cli-archive.sh | tail -1)"
linux_archive="t3-$version-linux-x64.tar.gz"
[ "$(basename "$remote_archive")" = "$linux_archive" ] ||
  { log "The Linux build returned '$remote_archive'."; exit 1; }
scp -q -o BatchMode=yes "$LINUX_BUILDER:$remote_archive" "$out/$linux_archive"
remote_sum="$(ssh -o BatchMode=yes "$LINUX_BUILDER" sha256sum "$remote_archive" | cut -d' ' -f1)"
# Names without a directory: servers look the archive up by its bare file name.
(cd "$out" && shasum -a 256 "$linux_archive" >SHA256SUMS)
[ "$(cut -d' ' -f1 "$out/SHA256SUMS")" = "$remote_sum" ] ||
  { log "The copied Linux archive does not match the one built."; exit 1; }

notes="$check_dir/notes.md"
{
  echo "Fork build of [$tag](https://github.com/$UPSTREAM_REPO/releases/tag/$tag) with these changes:"
  echo
  git log --reverse --format='- %s' "$tag..HEAD"
  echo
  gh release view "$tag" --repo "$UPSTREAM_REPO" --json body --jq .body 2>/dev/null || true
} >"$notes"
files=()
for file in "$out"/*.dmg "$out"/*.zip "$out"/*.blockmap "$out"/*-mac.yml "$out/$linux_archive" \
  "$out/SHA256SUMS"; do
  [ -f "$file" ] && files+=("$file")
done
# Drafts are invisible to the desktop updater and to servers: publish once every asset is up.
gh release create "$tag" "${files[@]}" --repo "$FORK_REPO" --target "$(git rev-parse HEAD)" \
  --draft --prerelease --title "T3 Code $version (fork)" --notes-file "$notes"
gh release edit "$tag" --repo "$FORK_REPO" --draft=false >/dev/null
log "Released $version: https://github.com/$FORK_REPO/releases/tag/$tag"

# Keep the two newest local builds.
builds="$(ls -d "$root"/release/*-nightly.* 2>/dev/null | sort -V)"
count="$(printf '%s\n' "$builds" | grep -c . || true)"
if [ "$count" -gt 2 ]; then
  printf '%s\n' "$builds" | head -n "$((count - 2))" | while read -r old; do rm -rf "$old"; done
fi
