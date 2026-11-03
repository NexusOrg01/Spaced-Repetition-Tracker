# Nexus Android native test plan

Run these checks on both debug APKs. CI verifies static wiring and Gradle compilation; it cannot replace physical-device acceptance testing.

## Offline and tracker

- Install the APK, launch in airplane mode and confirm the app opens without requesting the hosted PWA.
- Create a stream, subject and topic; complete a review and confirm its schedule survives force-close/relaunch.
- Update a Study Hub planner or journal item and confirm it survives relaunch.
- Confirm the Android app does not register or depend on the PWA service worker.

## Backup import

- Use the existing Import Backup action and select a JSON file from Downloads through Android's system document picker.
- Test a valid full schema-4 backup, a legacy backup and malformed JSON.
- Confirm the existing REPLACE/MERGE confirmation flow is unchanged.
- Select a CSV topic file and confirm the current CSV importer handles it.
- Cancel the picker and confirm no data changes.

## Backup export and sharing

- Export a full JSON backup from the existing Backup action.
- Confirm Android's share sheet opens and offers available sharing targets.
- Save the file to Downloads or a documents provider and confirm it can be parsed as JSON.
- Export a Study Hub report and CSV and confirm the extension and content type.
- Dismiss the share sheet and confirm the app remains usable.

## Navigation and safety

- Open each main section and verify Android Back returns to Home.
- Open a dialog or overflow menu and verify Back closes it before leaving the section.
- Confirm app exit only occurs from Home with no dialog or menu open.
- In default CI APKs, confirm sign-in controls are disabled and no production Supabase request is made.
- Test account isolation and deletion only with staging, after allow-listing the callback URI.
