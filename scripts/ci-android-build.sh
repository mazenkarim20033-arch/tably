#!/usr/bin/env bash
# Builds an installable TABLY.apk on a GitHub Linux runner (free, no Mac needed). The APK is signed with the standard
# Android debug key, which is fine for installing on your own phone (not for the Play Store).
# Called by .github/workflows/android-apk.yml. Kept in the repo so it can be fixed with a normal push.
set -euxo pipefail

java -version
npm ci

cd apps/mobile
npx expo prebuild --platform android --no-install

cd android
chmod +x gradlew
# arm64 covers every phone made in the last several years; building one architecture is much faster and the APK is smaller.
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a \
  -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g"

cp app/build/outputs/apk/release/app-release.apk TABLY.apk
ls -lh TABLY.apk
