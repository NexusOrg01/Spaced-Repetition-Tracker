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

## Cloud sync policy decision

Cloud sync is retained in the F-Droid build. F-Droid's Inclusion Policy does not categorically prohibit internet access or optional account-backed sync; it requires free software, transparent dependencies, and disclosure of relevant Anti-Features. Nexus must not ship an F-Droid edition with cloud sync silently disabled merely to simplify packaging.

- The Android manifest's INTERNET permission is required for the optional account, OAuth and sync features. Local study tracking, scheduling, history, Study Hub and backup/restore remain usable without an account or network access.
- Signing in is the opt-in point for account-backed cloud features. The Android build must not add analytics, advertising, crash reporting or background telemetry.
- The app distributes only the public Supabase anon/publishable client key. A service-role or secret key must never be embedded in an APK.
- The app currently targets the Nexus-hosted Supabase project. Since users cannot yet select another Supabase endpoint in the UI, this must be disclosed during F-Droid review. The fact that the service is optional and the app remains fully useful offline is relevant to Anti-Feature assessment, but F-Droid maintainers make the final classification. Do not claim that the hosted-service question is already cleared.
- F-Droid and Google Play should use the same feature-complete app bundle. Distribution-specific differences should be limited to package identity, signing, store metadata and any genuinely store-specific integration—not removal of cloud sync or study features.

## F-Droid policy controls

This implementation is designed around F-Droid's current Inclusion Policy and Reproducible Builds guidance:

- Keep the complete app source and FLOSS licence public; the app repository declares Apache-2.0.
- Keep all Android and JavaScript runtime dependencies free/open-source, with no proprietary tracking, advertising SDK or Google Play Services/Firebase dependency.
- Build all executable app code from public source. No executable JavaScript is downloaded at runtime.
- Keep cloud sync optional and preserve complete core offline operation. F-Droid maintainers determine whether the external hosted service requires an Anti-Feature.
- Do not implement an in-app binary auto-updater. F-Droid remains the update channel for F-Droid builds.
- Use stable, unique package identity and tagged source revisions for release.
- Submit a separate build recipe and metadata to F-Droid's fdroiddata repository. Its metadata file belongs in fdroiddata/metadata/, not this application repository.

The Android npm lockfile is stored as 12 Base64 fragments containing one gzip-compressed, minified JSON npm v3 lockfile under android/package-lock-source/. scripts/restore-android-lock.mjs joins the fragments, checks the compressed SHA-256 digest, and deterministically reconstructs the standard npm lockfile before npm ci. It does not resolve or change dependency versions. CI and the F-Droid build recipe must use this restore step before installing npm packages. The F-Droid-specific `android:sync:fdroid` command then uses `npm ci --omit=optional` and the pinned source-built esbuild executable.
F-Droid's source scanner runs before the `build` command, so the metadata `prebuild` step runs `python3 ../scripts/restore-android-lock.py` from the `android/` subdirectory. This reconstructs `android/package-lock.json` before scanning, using only the Python 3 standard library available in the buildserver. The root package has a committed, dependency-free `package-lock.json` alongside its `package.json`. Both npm manifests therefore have corresponding lockfiles when F-Droid scans the source; the later Node.js 22 build step still runs the normal SHA-256-verified JavaScript lockfile restoration before `npm ci`.

The current lock resolves 114 unique npm packages, all with declared MIT, ISC, 0BSD, Unlicense, BlueOak-1.0.0 or Apache-2.0 licence identifiers in the normal install. CI rejects missing/unknown licence identifiers. The F-Droid install omits optional platform binaries and runs the same licence scan against the installed package tree. The complete resolved Gradle/Maven dependency licence and binary scan remains a submission blocker.

The Android CI job also writes a machine-readable JSON and Markdown inventory for every installed npm package. Each row records the lockfile path, resolved package URL, integrity digest, declared licence, conventional licence files, repository/homepage and direct/transitive relationship. The report is attached to the CI validation artifact. It is an auditable dependency inventory, not a legal opinion or a substitute for the outstanding Gradle/Maven and final APK licence review.

F-Droid's scanner automatically removes the checked-in Gradle wrapper JAR before the build. Do not add a matching `scandelete` entry: the scanner has already removed the file, so the explicit entry is reported as unused and makes the build fail. The recipe selects `gradle: fdroid`, which invokes F-Droid's system Gradle; GitHub Actions and normal local builds retain the checked-in wrapper.

The F-Droid path now avoids npm's prebuilt esbuild platform binary. `android:sync:fdroid` installs Android dependencies with `--omit=optional`, requires `NEXUS_ESBUILD_BINARY`, and checks that the Linux x64 npm binary is absent. `scripts/build-esbuild-from-source.sh` builds esbuild 0.28.2 from source commit `609683d892977362a0f99026cb74b96263d728a9`, using `golang.org/x/sys` source commit `c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf`, with Go module network access disabled. GitHub Actions exercises this path. The actual fdroidserver buildserver recipe still needs a successful isolated buildserver run and a compatible Node 22+ toolchain. The pinned esbuild and golang/sys srclib YAML definitions are supplied under `contrib/fdroiddata/srclibs/`.

## Release build outline

    # fdroiddata srclibs must provide the exact esbuild and golang/sys source commits documented in contrib/fdroiddata/.
    ESBUILD_SOURCE_DIR=$esbuild$ GO_SYS_SOURCE_DIR=$golang-sys$ NEXUS_ESBUILD_BINARY=.build/bin/esbuild NEXUS_ANDROID_APPLICATION_ID=REPLACE_WITH_FINAL_ID NEXUS_ANDROID_CLOUD_MODE=source NEXUS_ANDROID_ALLOW_PRODUCTION_CLOUD=true npm run android:sync:fdroid
    cd android
    ./node_modules/.bin/cap telemetry off
    ./node_modules/.bin/cap sync android
    ./gradlew --no-daemon -PnexusApplicationId=REPLACE_WITH_FINAL_ID -PnexusVersionCode=RELEASE_CODE -PnexusVersionName=RELEASE_VERSION assembleFdroidRelease

## Project maturity and eligibility timing

F-Droid's current Inclusion Policy says an app should have been actively developed for at least three months unless it can be shown to have users (or another stated exception applies). The public GitHub repository history currently begins on 2026-10-09, so that history alone does not establish three months of development. Before submission, either document the earlier public development history and evidence of existing users (for example, a verifiable public release/listing and genuine usage evidence), or plan for submission no earlier than 2027-01-09 if continuous development is maintained. F-Droid maintainers make the final eligibility decision.

## Release blockers

Do not submit until:

1. Final package ID, release version and signing approach are selected; create a matching signed Git tag.
2. The full npm and Gradle/Maven dependency licence and binary scan is complete.
3. Gradle dependency verification is committed and strict mode is enforced in CI. The initial SHA-256 values are generated by Gradle (`origin="Generated by Gradle"`) and are trust-on-first-use, not independent upstream authentication. Independently verify upstream checksums/signatures where available before submission; do not regenerate existing entries without reviewing the diff.
4. F-Droid's buildserver successfully builds the APK from the tagged public source using the pinned esbuild/golang-sys source libraries, and the build passes F-Droid metadata/lint and binary checks. Run an APK reproducibility comparison and investigate unexplained differences. Reproducible builds are strongly recommended, but F-Droid's Inclusion How-To describes them as best practice rather than an absolute inclusion requirement.
5. A cloud-enabled F-Droid APK is physically tested for fresh install, offline use, email sign-in, browser OAuth if configured, cloud sync, sign-out, account switching, account deletion, backup/restore, file picker and sharing.
6. Final store assets and release metadata are complete. The 512x512 icon and English short/full descriptions are included under `fastlane/metadata/android/en-US/`. An initial portrait phone screenshot and a wide-screen overview screenshot are prepared in a local package for `phoneScreenshots/1.jpg` and `tenInchScreenshots/1.jpg`; copy these files into the repository before source release. Add further feature screenshots as consecutive numbered files (for example, `phoneScreenshots/2.jpg` for Analytics), and add a release changelog before submission. Provide suitable screenshot alt text in the Google Play listing. F-Droid Anti-Feature classification is still pending maintainer review.
7. Privacy policy, account deletion, store identity and final package signing have been checked.

The preview APKs and unsigned release APK/AAB files are validation artefacts, not store-ready releases.

## Official policy references

- [F-Droid Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/)
- [F-Droid Anti-Features](https://f-droid.org/en/docs/Anti-Features/)
- [F-Droid Reproducible Builds](https://f-droid.org/en/docs/Reproducible_Builds/)
- [Submitting to F-Droid: Quick Start Guide](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/)


## Toolchain compatibility and source-build requirements

The current native project uses Capacitor 8.6.0, which requires Node.js 22 or newer. Debian Trixie provides Node.js 20.19.2, so the metadata now references the signed upstream Node.js 22.23.4 source release (commit `27f213124280b4db4cd1e3dd42f6f8afd01ceff7`) and compiles it within the build before using its bundled npm 10.9.9. The source-build script verifies Node and npm versions and is wired into GitHub Actions. This resolves the identified version mismatch at the recipe-design level, but the full compilation has not yet been validated on F-Droid's isolated buildserver. Do not treat the recipe as submission-ready until that server-side build passes. The F-Droid build block installs Debian's `golang-go` package as well, because esbuild 0.28.2 is compiled from its pinned source using `go build`; GitHub Actions' Go setup does not provision the separate F-Droid buildserver.

The latest GitHub Android CI job now emits a Gradle/Maven buildscript and runtime licence inventory alongside the npm package inventory. It resolves both root and app `buildEnvironment` classpaths in addition to F-Droid debug/release runtime dependencies, covering the Android Gradle Plugin and other build plugins.  Node.js is now a pinned source-built build dependency, not a downloaded prebuilt binary. It records the resolved F-Droid debug/release modules, cached POM licence declarations, project/SCM links and licence/notice file names found in cached JAR/AAR archives. Modules without metadata or archive notices remain explicit review items. This is still not a complete audit of build plugins, test-only dependencies, SDK tooling, Go, or all assets.
