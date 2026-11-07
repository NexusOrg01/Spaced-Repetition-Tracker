# F-Droid Android edition

This repository now includes a separate Android build intended for F-Droid. It packages the existing Nexus web application as local assets inside a native Android activity; it does not open the production Vercel site.

## Android edition scope

The F-Droid edition is deliberately offline-only:

- It does not request the Android `INTERNET` permission.
- It does not package `cloud-sync.js` or download the Supabase JavaScript SDK at runtime.
- It removes Vercel Web Analytics from the packaged HTML.
- It keeps study data in the local IndexedDB workspace.
- JSON backups and CSV exports are written to `Downloads/Nexus` through Android MediaStore.
- Backup and CSV import uses Android's system document picker.
- Android Back navigates WebView history before closing the app.
- External HTTPS and mail links open in the user's external handler.

The regular PWA build is not changed to this offline-only mode. Its existing cloud-sync configuration and hosting behavior remain separate.

## Licensing scope

The project's selected licence for original Nexus application source code is Apache License 2.0 (`Apache-2.0`), within the scope described in [the licensing and release policy](LICENSING.md). The root [LICENSE](../LICENSE) file is the full Apache-2.0 text.

This declaration does not automatically relicense third-party libraries, fonts, icons, artwork, screenshots, or curriculum material. Those items retain their own terms unless the relevant rights holder has granted compatible permission. The Android release must retain required notices and attributions, and the complete APK still needs a separate F-Droid licence/provenance review. CI can verify consistency of the project's own licence declarations; it cannot establish ownership or redistribution rights for every included asset.

## Build requirements

- JDK 17
- Gradle 8.13
- Android SDK Platform 36 and Build Tools 36.0.0
- Android Gradle Plugin 8.13.2
- AndroidX WebKit 1.18.0
- AndroidX Activity 1.13.0

From the repository root:

```sh
gradle -p android --no-daemon :app:assembleDebug :app:assembleRelease :app:verifyFdroidAssets
```

The release APK is created at:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

The asset-preparation task copies a curated list of source files into the APK at build time. It generates the Android-only build config, removes the Vercel Analytics block and PWA screenshot URLs, and excludes the online cloud-sync module. The task fails if those exclusions or the native bridge are missing.

## Package identity and version

- Application ID: `io.github.nexusorg01.nexus`
- Version name: `1.0.0`
- Version code: `1`
- Minimum Android version: Android 10 (API 29)
- Target SDK: 36

The package ID is intentionally separate from the older TWA package ID in `.well-known/assetlinks.json`.

## F-Droid submission remains a separate step

The app source repository must remain publicly accessible and carry a valid FOSS licence. The F-Droid metadata entry itself is submitted to the separate `fdroiddata` repository; the Fastlane description and changelog in this repository are upstream metadata, not that submission.

Before proposing inclusion, check:

1. All source files, icons and bundled curriculum data have compatible redistribution terms.
2. The first Android release can be built with F-Droid's build tooling and the pinned source revision.
3. The build produces the same app assets without requiring network access during the build step beyond dependencies fetched and cached by the build environment.
4. The APK installs and works offline on a physical Android device.
5. Export to Downloads, file import, local persistence, app restart and Android Back are tested.

This preparation does not guarantee F-Droid acceptance. F-Droid maintainers make the final inclusion decision, including whether this native integration provides sufficient value beyond a website wrapper.
