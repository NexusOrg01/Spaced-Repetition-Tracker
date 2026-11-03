# Store and distribution readiness

This document tracks distribution routes for Nexus without treating every directory as an app store. It is intentionally separate from the application's production deployment and does not authorize a production release.

## Current application shape

Nexus is a static JavaScript Progressive Web App (PWA). Its supported production URL is:

- https://spaced-repetition-tracker-delta.vercel.app/

The PWA already has a web app manifest, service worker, offline cache, 192px/512px icons, mobile and desktop screenshots, and a verified legacy Trusted Web Activity (TWA) association in `.well-known/assetlinks.json`.

The existing TWA association identifies package `app.vercel.spaced_repetition_tracker_delta.twa`. Do not silently replace this application ID or its signing certificate: Android updates must retain a consistent package ID and signing identity. The current Digital Asset Links fingerprint must match the certificate used to sign any TWA package distributed from this origin.

Vercel is the current web host. A store listing or TWA wrapper does not require moving the web app away from Vercel. A custom domain can be added later without changing the hosting platform, once domain ownership and DNS are available. The requested `nexus.is-an.org` subdomain is still a separate external approval step.

## Already listed

- PWAStore.io — already published.
- PWA Directory — already submitted/published.

Do not submit duplicate listings unless updating an existing listing.

## Priority 1: Store.app

**Type:** PWA/app discovery catalogue; it does not require an Android APK or AAB for a normal web-app listing.

1. Open https://store.app/list.
2. Create a free developer account and request developer access.
3. Use the developer dashboard to claim or add Nexus.
4. Complete the ownership-verification method offered by Store.app.
5. Use the production app URL above as the canonical destination. If ownership verification requires DNS control, use the approved `nexus.is-an.org` domain once it is issued and configured; do not claim ownership of that domain before approval.
6. Review the generated listing, screenshots, description, category and install instructions, then publish.

The free plan supports managing a listing, a developer profile and ratings/reviews. Paid verification is optional and is not required for a basic listing. See https://store.app/faq and https://store.app/pricing.

## Priority 2: Samsung Galaxy Store

There are two distinct routes; confirm which one Samsung currently supports for this app before preparing a binary.

### Route A — Samsung PWA onboarding

Samsung Internet's developer article describes a direct PWA onboarding route: email the public PWA URL to `pwasupport@samsung.com`. The article is dated 24 October 2019 and originally stated that PWA listings were visible only in the US Galaxy Store. Treat this as a request for confirmation, not a guarantee of current worldwide availability.

- Send: https://spaced-repetition-tracker-delta.vercel.app/
- Ask whether the PWA onboarding programme is still active and whether Nexus can be listed in Sri Lanka.
- Samsung may require a licence/permission to use the app name and icon in its catalogue.

Reference: https://samsunginternet.github.io/introducing-progressive-web-apps-to-samsung-galaxy-store/

### Route B — Seller Portal Android package

Samsung's current Seller Portal supports APK and AAB submissions. It requires a Samsung account, Seller Portal registration and commercial seller status to distribute apps, including free apps. Samsung currently states there is no sign-up or annual publishing fee. Seller Portal asks for app metadata, graphics, age rating, supported languages, legal/support URLs and a support email. If login is required, reviewers need a working test account.

Before submitting a binary:

- Preserve the existing package ID and signing identity if updating the existing TWA; otherwise establish a new, permanent application ID before the first public release.
- Verify the Digital Asset Links SHA-256 certificate fingerprint against the final signing certificate.
- Build and test a 64-bit Android package and satisfy Samsung's current target API requirements (the FAQ currently says target API 33 or higher).
- Check Samsung's 16 KB memory-page compatibility notices for the selected Android build and all native libraries.
- Test fresh install, update, offline startup, account sign-in, magic-link return, backup/restore, and app links on a Galaxy device.
- Provide privacy policy and support contact details.

References:
- https://developer.samsung.com/galaxy-store/prepare.html
- https://developer.samsung.com/galaxy-store/faq.html
- https://developer.samsung.com/galaxy-store/launch.html

## Priority 3: F-Droid and IzzyOnDroid

Apache-2.0 is an accepted FOSS licence, but the licence alone does not make the current app eligible. F-Droid checks the complete application, its dependencies, assets and build toolchain. It builds from public source and rejects proprietary tracking/analytics libraries and non-free dependencies. Its policy also expects a website wrapper to provide native features and enhancements.

The current TWA is not the F-Droid release artifact. A separate Android build must be prepared and reviewed for:
- a stable, unique Android application ID;
- fully FOSS runtime and build dependencies;
- no Google Play Services, Firebase, proprietary analytics or tracking SDKs;
- redistribution rights for every bundled icon, font and other asset;
- command-line build instructions and a build process F-Droid can reproduce;
- meaningful Android integration beyond a thin website wrapper;
- an authentication design that works without requiring proprietary Google Play Services.

Do not submit the TWA AAB to F-Droid as-is. The next technical phase should prepare a dedicated FOSS-compatible Android package (the earlier architecture review favoured a Capacitor-based Android project for this route), then validate it against F-Droid's build environment before requesting inclusion. IzzyOnDroid can be evaluated after the same signed, source-linked Android release exists.

References:
- https://f-droid.org/docs/Inclusion_Policy/
- https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/
- https://f-droid.org/docs/Reproducible_Builds/

## Other previously shortlisted channels

| Channel | Distribution type | Required next step |
|---|---|---|
| Huawei AppGallery | Android app marketplace | Prepare and test an Android APK/AAB; verify AppGallery signing and split/universal package behaviour. |
| Microsoft Store | Windows PWA package | Generate a package with PWABuilder, provide accurate store metadata and a public privacy-policy URL, then submit through Partner Center. |
| GitHub Releases | Direct download | Publish a versioned, signed APK/AAB with checksums and source tag after the Android build is stable. |
| Obtainium | Android update discovery | Publish a stable GitHub release and document the official release feed; it is not an app-store review service. |
| AlternativeTo, SaaSHub, AppDirectory | Software directories | Submit a listing with canonical URL, accurate features and screenshots. |
| Product Hunt | Launch/discovery platform | Prepare a launch page and screenshots after the store links are real; no app-package changes are required. |

Huawei supports AAB distribution, but both split APKs and the universal package must be tested. Microsoft Store packages are separate from Android packages.

References:
- https://developer.huawei.com/consumer/en/doc/AppGallery-connect-Guides/agc-appsigning-aabtest-0000001059321484
- https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store

## Android developer verification outside Google Play

Android's developer-verification rollout is separate from each store's own seller review. The current Android Developers guidance says the first regional enforcement phase began on 30 September 2026 in Brazil, Indonesia, Singapore and Thailand for selected partner stores, including Samsung Galaxy Store. Sri Lanka is not in that initial country list; Android says the rollout is intended to expand globally in 2027.

Before broad Android distribution, monitor the official guidance and be prepared to:
- create an Android Developer Console account for distribution outside Google Play;
- verify the developer's identity;
- register the permanent Android package name(s) and prove signing-key ownership.

This makes the package ID and signing-key custody decisions especially important. Do not publish a temporary package ID and then expect to rename it later.

Reference: https://developer.android.com/developer-verification/guides

## Release blockers to resolve before a public native-store submission

1. Publish a public privacy policy that accurately describes local storage, optional Supabase cloud sync, authentication, data retention and contact details.
2. Provide a reliable account/data deletion request path. Do not claim users can delete their Supabase Auth account until a secure deletion implementation exists and is tested.
3. Decide the permanent Android application ID and signing-key custody before the first native-store release. Never commit signing keys or passwords.
4. Confirm the public support/privacy contact address and the approved custom-domain status.
5. Complete Android packaging and device testing. A successful web preview is not evidence that an Android package is installable or store-compliant.
6. Obtain explicit owner approval before submitting listings, accepting store agreements, changing production hosting, deploying production code, or changing the live Supabase project.

## Scope of this PR

This PR improves the PWA's catalogue metadata and adds a maintained distribution checklist. It does not create an Android binary, register developer accounts, submit any store application, change production hosting, deploy production, or modify live Supabase.
