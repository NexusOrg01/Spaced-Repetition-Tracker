# Store screenshots

The first Nexus store screenshot pair has been prepared in a local package using Fastlane's Android metadata layout. The binary images are not yet committed to this branch; copy the package's `fastlane/` directory into the repository before treating these assets as part of the source release:

| File | Purpose | Dimensions | Suggested listing text |
| --- | --- | ---: | --- |
| `fastlane/metadata/android/en-US/images/phoneScreenshots/1.jpg` | Portrait phone overview: navigation, review summary, exam reminder and review analytics entry point | 1080 × 1920 | Nexus home overview showing review status, exam planning and access to review analytics |
| `fastlane/metadata/android/en-US/images/tenInchScreenshots/1.jpg` | Wide-screen overview: desktop/tablet responsive layout with navigation, review summary and upcoming calendar | 1920 × 1080 | Nexus wide-screen overview showing study progress, review analytics and upcoming review calendar |

The portrait image was proportionally enlarged and padded to 9:16; the wide image was proportionally enlarged and padded to 16:9. Neither image was cropped or stretched. Both files are JPEGs in RGB mode. The wide capture is a responsive wide-screen view, not a separately verified physical 10-inch tablet capture.

## Adding more screenshots

Keep screenshots in the same locale directory, numbered consecutively within each device category:

- Phone: `phoneScreenshots/2.jpg`, `phoneScreenshots/3.jpg`, …
- 7-inch tablet: `sevenInchScreenshots/1.jpg`, …
- 10-inch tablet: `tenInchScreenshots/2.jpg`, …

Use actual Nexus screens and avoid mock device frames, marketing text overlays or altered UI. Google Play's large-screen section asks for at least four screenshots and recommends 16:9 landscape or 9:16 portrait images in the 1080–7680px range. These are only the initial pair, so the gallery is not yet complete for submission. Keep the screenshot dimensions within store limits and provide concise alt text in Google Play Console (maximum 140 characters per graphic).

## Store ingestion

- **F-Droid:** these files follow the Fastlane metadata path supported by F-Droid. They are picked up from the upstream source repository version used for the F-Droid metadata/build process; adding them to an unmerged pull-request branch alone does not publish them.
- **Google Play:** Fastlane-compatible paths make the assets available to an authenticated `fastlane supply` upload workflow. They do not, by themselves, upload screenshots to Play Console. A release operator must upload them through Play Console or a separately configured authenticated workflow.

These are initial overview screenshots, not the complete store gallery. Add Analytics and other feature screens as they are captured; use real app captures for each supported device category. Final store submission remains blocked by the separate package identity, signing, compliance and release checks in the Android release documents.
