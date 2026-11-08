# Nexus Android F-Droid and direct-release preparation

This document describes the Android build path for the official F-Droid repository, with GitHub Releases as the primary direct-download channel and Uptodown as a possible fallback. It is a build and testing foundation, not a claim that any store has approved the app.

## Architecture

- The Android app embeds the locally generated static Nexus application bundle. It does not point its WebView at the production Vercel website.
- The PWA source and normal `npm run build` path remain unchanged. Android-only changes are applied to generated `dist/` files by `scripts/build-android-assets.mjs`.
- The Android project has one distribution flavour: `fdroid`. The same feature-complete application code is used for F-Droid and direct-download builds; there is no separate Play Store flavour or reduced-feature edition.
- Android's system document picker imports JSON and CSV files without broad storage permissions.
- Backup exports are written to the app cache and passed to Android's system share sheet. The FileProvider exposes only the cache directory.
- The packaged Android app skips the PWA service worker so browser caches cannot shadow assets installed with an APK update.
- Native OAuth uses an app-owned Capacitor auth-session plugin with AndroidX Custom Tabs. It validates the requested deep-link target, returns the callback URI to the waiting app call, and handles cancellation/timeouts without relying on `Browser.close()` (which is unavailable on Android).

## Distribution plan

- **F-Droid:** priority repository. The submitted recipe must build from the public source using the F-Droid buildserver; metadata, Anti-Feature classification and reproducibility remain subject to maintainer review.
- **GitHub Releases:** primary direct-download fallback. Publish a stable, release-signed APK with its version, SHA-256 checksum and release notes. Do not publish a CI debug APK as a public release.
- **Uptodown:** possible secondary mirror if its current submission requirements accept the app. Use the same approved package identity and release process as the GitHub release, not a separately modified build.

F-Droid may sign repository builds differently from developer-distributed APKs. Before public release, decide and verify the signing arrangement so that users can receive updates without uninstalling or losing local data when moving between distribution channels. Do not assume that two APKs with the same package ID can update one another unless their signing certificates match.

## Runtime and cloud separation

The Android web bundle excludes Vercel Web Analytics and uses a locally packaged copy of the exact Supabase JavaScript version already used by the web app. No JavaScript executable is fetched from a CDN at runtime in Android builds.

The Android app does not include Google Play Services SDKs, Firebase, Google Analytics or advertising SDKs. OAuth uses the system browser; email authentication remains available independently of Google Play Services.

The hosted Supabase service remains optional. The app can run offline without signing in. F-Droid eligibility and any appropriate Anti-Feature disclosure still require review by F-Droid maintainers.

## Preview cloud safety

CI and the default Android asset build use `NEXUS_ANDROID_CLOUD_MODE=staging`. This keeps sign-in and cloud sync available for testing against the isolated staging Supabase project; it does not contact or modify the production backend. Use `NEXUS_ANDROID_CLOUD_MODE=disabled` only for explicit offline-only tests, not for a feature-parity release.

To build a cloud-enabled internal test APK intentionally, set `NEXUS_ANDROID_CLOUD_MODE=enabled`, `NEXUS_SUPABASE_URL` and `NEXUS_SUPABASE_ANON_KEY` during `npm run android:sync`. The asset builder rejects the production Supabase project in this mode and rejects secret/service-role keys. Use a separate staging project and never use production for destructive Android testing. The preview OAuth callback is `org.nexus.tracker.preview://auth-callback`; it must be allow-listed in the test project's redirect URLs before OAuth testing. This PR changes no Supabase configuration.

Example custom staging build: `NEXUS_ANDROID_CLOUD_MODE=enabled NEXUS_SUPABASE_URL=https://YOUR-STAGING-REF.supabase.co NEXUS_SUPABASE_ANON_KEY=YOUR-STAGING-PUBLISHABLE-KEY npm run android:sync`. The values are embedded as client-visible publishable configuration, so never pass a service-role/secret key.

The callback scheme and package ID are temporary. Final values must be selected after the project has an approved, project-controlled domain and the release-signing strategy is decided.

## Toolchain pins

- Capacitor core, Android platform and CLI: 8.6.0
- Capacitor App: 8.1.2
- Capacitor Browser: 8.0.5
- Capacitor Filesystem: 8.1.5
- Capacitor Share: 8.0.1
- Capawesome File Picker: 8.1.1
- Supabase JS: 2.117.3
- esbuild: 0.28.2
- Android min SDK: 24
- Android compile and target SDK: 36
- Android Gradle Plugin: 8.13.0
- Gradle wrapper: 8.14.3
- CI JDK: 21; CI Node: 22.

Android-only npm dependencies are isolated in `android/package.json`, so the existing root PWA build does not install Capacitor. Direct Android npm dependencies are pinned to exact versions. The Android npm lockfile is reconstructed from checked-in, SHA-256-verified fragments; Gradle dependency verification is enforced in CI. The final F-Droid buildserver run and reproducibility comparison are still required before claiming a fully reproducible release.

## Build locally

Install Node.js 22, JDK 21, Android SDK Platform 36 and Build Tools 36.0.0:

```sh
npm run android:sync
npm run test:android
cd android
./gradlew assembleFdroidDebug
```

The default Android asset build uses the isolated staging cloud configuration so the F-Droid debug APK can be tested with sign-in and sync. Set `NEXUS_ANDROID_CLOUD_MODE=disabled` only when you explicitly need an offline-only test build. CI uploads the installable F-Droid debug APK and an unsigned F-Droid release APK, together with dependency and verification reports. Neither CI APK is ready for public distribution.

The F-Droid source recipe uses `npm run android:sync:fdroid`, a source-built pinned esbuild binary and the pinned source libraries defined under `contrib/fdroiddata/`.

## Outstanding before public distribution

1. Finalize the permanent application ID, versioning and OAuth callback. The current preview identity and debug suffix must not be used for public releases.
2. Verify the final staging and release OAuth redirect behaviour without exposing production credentials or changing production Supabase settings during preview testing.
3. Complete physical-device acceptance on the current F-Droid APK, including sign-in, account separation, offline persistence, backup import/export, CSV sharing, PDF printing, Back navigation and startup/icon presentation.
4. Complete the full source, binary, font, icon, curriculum, npm and Gradle/Maven licence review.
5. Pass the F-Droid buildserver recipe and reproducibility checks; complete metadata and Anti-Feature review with F-Droid maintainers.
6. Choose and securely store the developer release signing key for GitHub Releases and any Uptodown mirror. Verify whether the F-Droid signing model permits compatible upgrades across channels; document any unavoidable migration/reinstall policy.
7. Prepare signed release artifacts, SHA-256 checksums, release notes, privacy information and store-specific screenshots. Do not reuse the debug APK for this purpose.
