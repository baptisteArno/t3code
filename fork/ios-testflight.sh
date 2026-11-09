#!/bin/bash
# Build the fork's iOS app, signed by the user's Apple team, and upload it to TestFlight.
# Runs on the checkout it lives in. See fork/README.md. macOS only; bash 3.2 compatible.
# Signs with the Apple account signed in to Xcode, so it needs the GUI login session (the T3 Code
# app's shells); over SSH codesign cannot reach the login keychain (errSecInternalComponent).
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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
log_file="$root/release/ios/build-$T3CODE_IOS_BUILD_NUMBER.log"
mkdir -p "$root/release/ios"
# Keep the four previous build logs next to this one.
ls -t "$root"/release/ios/build-*.log 2>/dev/null | tail -n +5 | while read -r old; do rm -f "$old"; done

cd "$root/apps/mobile"
# -allowProvisioningUpdates registers the App IDs, App Group, profiles and distribution certificate.
# The fork's App Store Connect API key cannot: Xcode's provisioning rejects it as unauthorized.
log "Generating the iOS project for $T3CODE_IOS_BUNDLE_ID, build $T3CODE_IOS_BUILD_NUMBER."
pnpm exec expo prebuild --clean --platform ios >"$log_file" 2>&1 ||
  { log "Prebuild failed; see $log_file."; exit 1; }

log "Archiving (output in $log_file)."
xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
  -destination generic/platform=iOS -archivePath "$work/T3Code.xcarchive" \
  -allowProvisioningUpdates archive >>"$log_file" 2>&1 ||
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
  -exportOptionsPlist "$work/ExportOptions.plist" -allowProvisioningUpdates >>"$log_file" 2>&1 ||
  { tail -30 "$log_file"; log "Export failed; see $log_file."; exit 1; }

if [ "$destination" = upload ]; then
  log "Uploaded build $T3CODE_IOS_BUILD_NUMBER; TestFlight offers it once Apple has processed it."
else
  cp "$work"/export/*.ipa "$root/release/ios/T3Code-$T3CODE_IOS_BUILD_NUMBER.ipa"
  log "Built $root/release/ios/T3Code-$T3CODE_IOS_BUILD_NUMBER.ipa."
fi
