#!/usr/bin/env bash
# Builds an UNSIGNED TABLY.ipa on a GitHub macOS runner. Sideloadly signs it later with your free Apple ID.
# Called by .github/workflows/ios-unsigned.yml. Kept in the repo so it can be fixed with a normal push.
set -euxo pipefail

# Expo's iOS pieces need Swift 6.2, i.e. Xcode 26 or newer. Use the newest stable Xcode installed on the runner.
XCODE=$(ls -d /Applications/Xcode_*.app 2>/dev/null | grep -vi beta | sort -V | tail -1 || true)
if [ -n "$XCODE" ]; then
  sudo xcode-select -s "$XCODE/Contents/Developer"
fi
xcodebuild -version
swift --version

# Compiled output lives outside the generated ios/ folder so the CI cache can keep it between builds.
DERIVED="$HOME/tably-derived"

npm ci

cd apps/mobile
npx expo prebuild --platform ios --no-install

cd ios
pod install

# -quiet keeps the log readable: only warnings and errors are printed.
xcodebuild -quiet \
  -workspace TABLY.xcworkspace -scheme TABLY -configuration Release \
  -sdk iphoneos -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build

rm -rf Payload TABLY-unsigned.ipa
mkdir -p Payload
cp -R "$DERIVED/Build/Products/Release-iphoneos/TABLY.app" Payload/
zip -qr TABLY-unsigned.ipa Payload
ls -lh TABLY-unsigned.ipa
