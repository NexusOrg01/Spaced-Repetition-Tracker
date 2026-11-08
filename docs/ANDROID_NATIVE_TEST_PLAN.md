# Nexus Android native test plan

Run these checks on the F-Droid debug APK. CI verifies static wiring and Gradle compilation; it cannot replace physical-device acceptance testing.

## Offline and tracker

- Install the APK, launch in airplane mode and confirm the app opens without requesting the hosted PWA.
- Create a stream, subject and topic; complete a review and confirm its schedule survives force-close/relaunch.
- Update a Study Hub planner or journal item and confirm it survives relaunch.
- Confirm the Android app does not register or depend on the PWA service worker.

## Backup import

- Use the existing Import Backup action and select a JSON file from Downloads through Android's system document picker.
- Test a valid full schema-4 backup, a legacy backup and malformed JSON.
- Confirm the existing REPLACE/MERGE confirmation flow is unchanged.
- Cancel the picker and confirm no data changes.
- Force the native picker to fail or become unavailable and confirm the WebView's ordinary file chooser is used as a fallback.

## Backup export and sharing

- Export a full JSON backup from the existing Backup action.
- Confirm Android's share sheet opens and offers available sharing targets.
- Save the file to Downloads or a documents provider and confirm it can be parsed as JSON.
- Export a Study Hub report and CSV and confirm the extension and content type.
- Dismiss the share sheet and confirm the app remains usable.

## Analytics PDF export

- Open Study Hub → Analytics → Export detailed PDF in the F-Droid debug APK.
- Confirm the Android system print interface opens directly; Nexus must not navigate to a second report page or remain in a browser-style report WebView.
- Choose **Save as PDF**, save the report, and open it from Downloads.
- Verify the A4 layout, Nexus cover artwork, charts, tables, review history and page breaks. Check both a small dataset and a large history.
- Cancel the print interface, return to Nexus, and repeat the export to confirm the app remains responsive.
- Test while offline; the report is generated from local Nexus data and must not require external assets or a network connection.

## Navigation and safety

- Open each main section and verify Android Back returns to Home.
- Open a dialog or overflow menu and verify Back closes it before leaving the section.
- Confirm app exit only occurs from Home with no dialog or menu open.
- Confirm the CI APK is configured for the isolated staging Supabase project, never the production project.
- Confirm optional sign-in controls and cloud sync are available in the F-Droid build; no Google Play Services installation should be required.
- Verify the staging callback URI (`org.nexus.tracker.preview://auth-callback` for the default preview ID) is allow-listed before testing email or OAuth sign-in.
- In the staging Supabase dashboard, add `org.nexus.tracker.preview://auth-callback` under Authentication → URL Configuration → Additional Redirect URLs. This is the app's final redirect target, not Google's OAuth client callback.
- Keep the Google OAuth provider's authorised redirect URI pointed at the staging Supabase Auth callback: `https://xuwfzibxhxzxxupprxsq.supabase.co/auth/v1/callback`. Do not substitute the custom Android URI in Google Cloud Console.
- Expected successful flow: Google sign-in opens an Android Custom Tab; the native auth-session plugin captures the exact custom URI callback and returns it to the waiting app call; Nexus exchanges the returned code for a session. Returning to Nexus without a callback cancels the sign-in instead of leaving an unresolved browser session.
- Test sign-in, account isolation, offline queued changes, sync, sign-out and account deletion only with staging accounts. Do not use production accounts in preview APKs.
- For release testing, ensure the Supabase redirect allow-list contains the exact final URI derived from the final application ID, and test the F-Droid APK with that same ID.

## Physical-device acceptance report — 2026-11-04

A maintainer tested an installed Android debug APK on a Samsung Galaxy A32. The distribution flavour was not recorded in the test report, so this result does not establish acceptance of the current F-Droid-only build.

### Passed on device

- Google sign-in completed and returned to Nexus; cloud sync completed successfully.
- Created test streams and subjects, marked items reviewed, force-closed the app and relaunched it; the changes remained.
- Exported the Analytics detailed PDF, opened the resulting PDF and confirmed the PDF flow and output worked.
- Privacy-policy pages and Gmail redirections opened successfully.
- Made changes to Account A while offline, closed and relaunched the app offline, and confirmed the changes remained locally.
- While Account A had pending offline changes, signed out, restored connectivity and signed into Account B. Account B loaded its own data without Account A's data appearing.
- Signed back into Account A; its offline changes synchronised successfully and Account B's data was no longer shown in the active workspace.

### Still requiring explicit verification

- Repeat the relevant acceptance checks on the current F-Droid-only APK; the previous report used a build whose flavour was not recorded and predates the current changes.
- Complete backup import, backup export/share-sheet, CSV export and Android Back-navigation checks if not already covered separately.
- Exercise PDF cancellation, a large report and PDF export while offline. The successful PDF export above confirms the normal on-device print path but does not by itself establish these edge cases.
- Complete release-identity, licence/SBOM, dependency-verification enforcement, F-Droid buildserver/reproducibility and store-signing work described in the release documentation.

This report records user-observed physical-device results. CI success and manual acceptance are separate evidence; neither is a store approval. Only staging/test accounts were used for this Android preview test. No production configuration or data was changed.
