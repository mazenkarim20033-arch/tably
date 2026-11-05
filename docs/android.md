# TABLY on Android

- **Build**: GitHub Actions workflow "Build Android APK" (`.github/workflows/android-apk.yml`, `scripts/ci-android-build.sh`).
  It runs `expo prebuild`, then Gradle `assembleRelease` for arm64, and uploads `TABLY-android-apk`. The APK is signed with
  the Android debug key, which is enough to install on your own phone.
- **Install**: download the artifact, send `TABLY.apk` to the phone, allow "install unknown apps" for the app you open it from.
- **Text reading**: `apps/mobile/modules/tably-vision/android` uses Google ML Kit (Latin model bundled, offline). It reads
  English letters and digits (including Western digits on Arabic receipts). **ML Kit does not read Arabic script**, so
  Arabic item names and labels come back as noise on Android; the engine can still find totals from the arithmetic.
  A PaddleOCR Arabic model (ONNX, about 8 MB) is the candidate to add later, after measuring it on real receipts.
- **Same as iPhone**: camera and photos (`expo-image-picker`), saving, the QR code, Arabic switch, share, payments.
- **Differences**: no runner-up readings from ML Kit (the engine treats them as optional), so the "maybe misread" hints
  are weaker than on iPhone.
