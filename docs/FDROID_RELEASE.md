# F-Droid release preparation

Nexus is being prepared for the official F-Droid repository first. The F-Droid flavour must retain the same user-facing study features as the Google Play flavour. It is not an offline-only or reduced-feature edition.

## Feature parity

The F-Droid release is intended to keep:

- Local streams, subjects, topics, review history and FSRS scheduling.
- Study Hub planning, journals, goals, papers and progress views.
- Offline operation and queued local changes.
- JSON/CSV export and restore through Android's system document picker and share sheet.
- Optional account sign-in, cloud sync, account recovery and cross-device sync.
- Email sign-in and browser-based OAuth where the account provider supports it.
- PWA installation-related in-app navigation, Android Back handling and app-link callbacks.

Cloud sync is optional; local study and review features do not require an account. The Android build bundles the Supabase JavaScript client inside the APK and must not load executable JavaScript from a CDN at runtime. The bundled Supabase client is distributed under its MIT licence, copied into the Android web assets.

The Android build removes Vercel Analytics. It does not include Google Play Services, Firebase, Google Analytics or advertising SDKs. OAuth uses the system browser rather than a Google Play Services SDK. Email authentication remains available without Google Play Services.

## Cloud modes and data safety

| Mode | Purpose |
| --- | --- |
| disabled | Explicit offline-only test build. Do not use for a feature-parity release. |
| staging | Default Android development/CI build. It injects the isolated staging Supabase project's publishable key and preserves sign-in/sync without touching production. |
| source | Release build using the default Supabase URL and publishable key in cloud-sync.js; requires NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD=true. |
| enabled | Custom cloud build requiring NEXUS_SUPABASE_URL and NEXUS_SUPABASE_ANON_KEY. |

Never embed a Supabase service_role or secret key in an Android application. Only the publishable/anon client key may be distributed. Backend access must continue to be protected by owner-scoped Row Level Security. Android previews and CI builds use staging; no release validation job contacts or modifies the production backend.

The default NEXUS_ANDROID_APPLICATION_ID is a temporary preview identity. For release, supply the same lowercase final application ID through NEXUS_ANDROID_APPLICATION_ID (web OAuth redirect scheme) and Gradle -PnexusApplicationId (native package and intent-filter scheme). Also supply -PnexusVersionCode and -PnexusVersionName.

## F-Droid policy controls

This implementation is designed around F-Droid's current Inclusion Policy and Reproducible Builds guidance:

- Keep the complete app source and FLOSS licence public; the app repository declares Apache-2.0.
- Keep all Android and JavaScript runtime dependencies free/open-source, with no proprietary tracking, advertising SDK or Google Play Services/Firebase dependency.
- Build all executable app code from public source. No executable JavaScript is downloaded at runtime.
- Keep cloud sync optional and preserve complete core offline operation. F-Droid maintainers determine whether the external hosted service requires an Anti-Feature.
- Do not implement an in-app binary auto-updater. F-Droid remains the update channel for F-Droid builds.
- Use stable, unique package identity and tagged source revisions for release.
- Submit a separate build recipe and metadata to F-Droid's fdroiddata repository. Its metadata file belongs in fdroiddata/metadata/, not this application repository.

The Android npm lockfile is stored as 12 Base64 fragments containing one gzip-compressed, minified JSON npm v3 lockfile under android/package-lock-source/. scripts/restore-android-lock.mjs joins the fragments, checks the compressed SHA-256 digest, and deterministically reconstructs the standard npm lockfile before npm ci. It does not resolve or change dependency versions. CI and the F-Droid build recipe must use this restore step before installing npm packages.

The current lock resolves 114 unique packages, all with declared MIT, ISC, 0BSD, Unlicense, BlueOak-1.0.0 or Apache-2.0 licence identifiers. CI rejects missing/unknown licence identifiers. The complete resolved Gradle/Maven dependency licence and binary scan remains a submission blocker.

The F-Droid build recipe must build the esbuild executable from source rather than trust npm's prebuilt native binary, and replace android/node_modules/@esbuild/linux-x64/bin/esbuild with that source-built executable before building assets. Adapt the exact commands to the current locked esbuild version and verify them in the F-Droid buildserver.

## Release build outline

    node scripts/restore-android-lock.mjs
    npm ci --prefix android --ignore-scripts --no-audit --no-fund
    # F-Droid buildserver: build the locked esbuild source and replace the npm binary here.
    npm run build
    NEXUS_ANDROID_APPLICATION_ID=REPLACE_WITH_FINAL_ID NEXUS_ANDROID_CLOUD_MODE=source NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD=true node scripts/build-android-assets.mjs
    cd android
    ./node_modules/.bin/cap telemetry off
    ./node_modules/.bin/cap sync android
    ./gradlew --no-daemon -PnexusApplicationId=REPLACE_WITH_FINAL_ID -PnexusVersionCode=RELEASE_CODE -PnexusVersionName=RELEASE_VERSION assembleFdroidRelease

## Release blockers

Do not submit until:

1. Final package ID, release version and signing approach are selected; create a matching signed Git tag.
2. The full npm and Gradle/Maven dependency licence and binary scan is complete.
3. Gradle dependency-verification checksums generated in CI are reviewed and committed; strict dependency verification is enabled for release builds.
4. F-Droid's buildserver successfully builds the APK from the tagged public source, including the esbuild-from-source recipe where required, and the build passes F-Droid metadata/lint and binary checks. Run an APK reproducibility comparison and investigate unexplained differences. Reproducible builds are strongly recommended, but F-Droid's Inclusion How-To describes them as best practice rather than an absolute inclusion requirement.
5. A cloud-enabled F-Droid APK is physically tested for fresh install, offline use, email sign-in, browser OAuth if configured, cloud sync, sign-out, account switching, account deletion, backup/restore, file picker and sharing.
6. Final screenshots and release metadata are published, including a changelog. F-Droid Anti-Feature classification is agreed with maintainers.
7. Privacy policy, account deletion, store identity and final package signing have been checked.

The preview APKs and unsigned release APK/AAB files are validation artefacts, not store-ready releases.
