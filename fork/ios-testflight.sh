#!/bin/bash
# Build the fork's iOS app, signed by the user's Apple team, and upload it to TestFlight.
# Runs on the checkout it lives in. See fork/README.md. macOS only; bash 3.2 compatible.
# Signs through the Admin App Store Connect API key of the signing env, not the Apple account signed in
# to Xcode, whose session Apple expires every few days. Needs the GUI login session (the T3 Code app's
# shells); over SSH codesign cannot reach the login keychain (errSecInternalComponent).
#
#   fork/ios-testflight.sh              build, sign and upload to App Store Connect
#   fork/ios-testflight.sh --no-upload  build and sign an .ipa into release/ios, upload nothing
set -euo pipefail

export T3CODE_IOS_TEAM_ID="${T3CODE_IOS_TEAM_ID:-YJ5SMWX927}"
export T3CODE_IOS_BUNDLE_ID="${T3CODE_IOS_BUNDLE_ID:-com.baptistearno.t3code}"
# TestFlight refuses a build number it already has; a UTC minute stamp only grows.
export T3CODE_IOS_BUILD_NUMBER="${T3CODE_IOS_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
export APP_VARIANT=production
export EXPO_NO_GIT_STATUS=1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

destination=upload
for arg in "$@"; do
  case "$arg" in
    --no-upload) destination=export ;;
    *) echo "Unknown argument: $arg" >&2; exit 64 ;;
  esac
done

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
log() { printf '[fork-ios] %s\n' "$*"; }

if [ -z "${APPLE_API_KEY_PATH:-}" ]; then
  signing_env="${T3CODE_FORK_SIGNING_ENV:-$HOME/.config/t3code-fork/signing.env}"
  [ -f "$signing_env" ] || { log "Missing signing env $signing_env."; exit 1; }
  # shellcheck disable=SC1090
  . "$signing_env"
fi
# Cloud signing for App Store distribution only accepts a key with the Admin role.
auth=(-allowProvisioningUpdates -authenticationKeyPath "$APPLE_API_KEY_PATH"
  -authenticationKeyID "$APPLE_API_KEY_ID" -authenticationKeyIssuerID "$APPLE_API_ISSUER")

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
log_file="$root/release/ios/build-$T3CODE_IOS_BUILD_NUMBER.log"
mkdir -p "$root/release/ios"
# Keep the four previous build logs next to this one.
{ ls -t "$root"/release/ios/build-*.log 2>/dev/null || true; } | tail -n +5 | while read -r old; do rm -f "$old"; done

cd "$root/apps/mobile"
# -allowProvisioningUpdates registers the App IDs, App Group, profiles and distribution certificate.
log "Generating the iOS project for $T3CODE_IOS_BUNDLE_ID, build $T3CODE_IOS_BUILD_NUMBER."
pnpm exec expo prebuild --clean --platform ios >"$log_file" 2>&1 ||
  { log "Prebuild failed; see $log_file."; exit 1; }

log "Archiving (output in $log_file)."
xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
  -destination generic/platform=iOS -archivePath "$work/T3Code.xcarchive" \
  "${auth[@]}" archive >>"$log_file" 2>&1 ||
  { tail -30 "$log_file"; log "Archive failed; see $log_file."; exit 1; }

cat >"$work/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$T3CODE_IOS_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

if [ "$destination" = upload ]; then
  log "Signing and uploading to App Store Connect."
else
  log "Signing the .ipa."
fi
xcodebuild -exportArchive -archivePath "$work/T3Code.xcarchive" -exportPath "$work/export" \
  -exportOptionsPlist "$work/ExportOptions.plist" "${auth[@]}" >>"$log_file" 2>&1 ||
  { tail -30 "$log_file"; log "Export failed; see $log_file."; exit 1; }

if [ "$destination" = upload ]; then
  log "Uploaded build $T3CODE_IOS_BUILD_NUMBER; TestFlight offers it once Apple has processed it."
else
  cp "$work"/export/*.ipa "$root/release/ios/T3Code-$T3CODE_IOS_BUILD_NUMBER.ipa"
  log "Built $root/release/ios/T3Code-$T3CODE_IOS_BUILD_NUMBER.ipa."
fi
