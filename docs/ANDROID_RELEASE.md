# Nexus Android release foundation

This document describes the in-progress shared Android project for F-Droid and Google Play. It is a build and testing foundation, not a claim that either store has approved the app.

## Architecture

- The Android app embeds the static Nexus application bundle. It does not point its WebView at the production Vercel website.
- The PWA source and normal `npm run build` path remain unchanged. Android-only changes are applied to generated `dist/` files by `scripts/build-android-assets.mjs`.
- One Capacitor Android project builds two product flavours: `fdroid` and `play`. Application IDs in this branch are temporary development IDs, not release identities.
- Both flavours use the same Nexus app code, file picker, share sheet and Android navigation.
- Android's system document picker imports JSON and CSV files without broad storage permissions.
- Backup exports are written to the app cache and passed to Android's system share sheet. The FileProvider exposes only the cache directory.
- The packaged Android app skips the PWA service worker so browser caches cannot shadow assets installed with an APK update.
- Native Google OAuth uses an app-owned Capacitor auth-session plugin with AndroidX Custom Tabs. It validates the requested deep-link target, returns the callback URI to the waiting app call, and handles cancellation/timeouts without relying on `Browser.close()` (which is unavailable on Android).

## Store separation

The Android web bundle excludes Vercel Web Analytics and uses a locally packaged copy of the exact Supabase JavaScript version already used by the web app. No JavaScript executable is fetched from a CDN at runtime in Android builds.

Both flavours use the same reviewed runtime dependencies. No Google Play Services SDK or Google Services Gradle plugin is added. The Play flavour is not a separate proprietary codebase.

The hosted Supabase service remains optional. The app can run offline without signing in. F-Droid eligibility and any appropriate Anti-Feature disclosure still require review by F-Droid maintainers.

## Preview cloud safety

CI and the default Android asset build use `NEXUS_ANDROID_CLOUD_MODE=staging`. This keeps sign-in and cloud sync available for testing against the isolated staging Supabase project; it does not contact or modify the production backend. Use `NEXUS_ANDROID_CLOUD_MODE=disabled` only for explicit offline-only tests, not for a feature-parity release.

To build a cloud-enabled internal test APK intentionally, set `NEXUS_ANDROID_CLOUD_MODE=enabled`, `NEXUS_SUPABASE_URL` and `NEXUS_SUPABASE_ANON_KEY` during `npm run android:sync`. The asset builder rejects the production Supabase project in this mode and rejects secret/service-role keys. Use a separate staging project and never use production for destructive Android testing. The preview OAuth callback is `org.nexus.tracker.preview://auth-callback`; it must be allow-listed in the test project's redirect URLs before OAuth testing. This PR changes no Supabase configuration.

Example custom staging build: `NEXUS_ANDROID_CLOUD_MODE=enabled NEXUS_SUPABASE_URL=https://YOUR-STAGING-REF.supabase.co NEXUS_SUPABASE_ANON_KEY=YOUR-STAGING-PUBLISHABLE-KEY npm run android:sync`. The values are embedded as client-visible publishable configuration, so never pass a service-role/secret key.

The callback scheme and package IDs are temporary. Final values must be selected after the project has an approved, project-controlled domain and the store-signing strategy is decided.

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
- CI JDK: 21; CI Node: 22 (Capacitor 8.6.0's Android module compiles with Java source release 21).

Android-only npm dependencies are isolated in `android/package.json`, so the existing root PWA build does not install Capacitor. Direct Android npm dependencies are pinned to exact versions. A committed Android npm lockfile and full Gradle dependency-verification metadata are still required before claiming a fully reproducible source build. F-Droid submission must independently verify the final build recipe and APK.

## Build locally

Install Node.js 22, JDK 21, Android SDK Platform 36 and Build Tools 36.0.0:

```sh
npm run android:sync
npm run test:android
cd android
./gradlew assembleFdroidDebug assemblePlayDebug
```

The default Android asset build uses the isolated staging cloud configuration so the F-Droid and Play variants can be tested with sign-in and sync. Set `NEXUS_ANDROID_CLOUD_MODE=disabled` only when you explicitly need an offline-only test build. CI uploads installable debug APK previews, an unsigned F-Droid release APK, and unsigned release AAB validation outputs. The release artifacts are not store-ready and must not be submitted.

## Outstanding before store submission

1. Finalize the permanent F-Droid and Play application IDs after the project-controlled domain and store strategy are confirmed.
2. Decide whether both stores use separate IDs (allowing independent signing and coexistence) or share one ID with an explicit migration/reinstall policy.
3. Configure and test the final OAuth callback and verified app links on the selected Supabase project. This PR has not configured them.
4. Install and test both APK variants on physical devices, including backup import/export, offline use and account isolation.
5. Complete the source, binary, font, icon, curriculum and dependency licence audit.
6. Commit an npm lockfile, verify Gradle dependency versions and complete F-Droid reproducibility verification.
7. Complete F-Droid metadata and review the hosted cloud-service Anti-Feature question with maintainers.
8. Configure secure release signing and key custody separately for each distribution channel.
9. Complete Google Play Data Safety declarations, app content forms, listing, internal testing and release review.
