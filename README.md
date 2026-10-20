# Nexus: Spaced Repetition Tracker (Netlify bundle)

A mobile-friendly, offline-first study tracker packaged as an installable Progressive Web App (PWA). The bundle is static and does not need a build command. Optional cloud sync is preconfigured to use the Nexus Supabase project.


## Support Nexus

Nexus is free to use, and its features are not locked behind payments. If Nexus helps you organise your studies and manage your revision schedule, you can optionally support its continued development and maintenance through [GitHub Sponsors](https://github.com/sponsors/kkmalithmalshan2000-png).

Contributions are entirely voluntary. There are no paid tiers, subscriptions, or supporter-only features, and you do not need to donate to use Nexus.

## Deploy free with Netlify

1. Download and extract `nexus-netlify-bundle.zip`.
2. In Netlify, choose **Add new site → Deploy manually** (wording may vary).
3. Upload the extracted `nexus-netlify-bundle` folder, or drag its contents into the deploy drop zone. `index.html`, `manifest.webmanifest`, `sw.js`, icons, and `netlify.toml` must be at the published root.
4. Open the resulting HTTPS URL in Chrome on Android.
5. In Chrome's menu, choose **Install app** or **Add to Home screen**.

You can also deploy from GitHub by pushing these files to a repository and connecting that repository to Netlify with the publish directory set to `.` and no build command.

## Included features

- Existing tracker functionality: custom streams/subjects/topics, review ratings, custom due dates, review history, exams/countdowns, themes, undo, and CSV/JSON import/export.
- Daily study planner based on due/overdue topics, recent ratings, weakness, and a configurable time budget.
- Focus-session timer and logged study time; weekly review target and goals/milestones.
- 14-day due/exam calendar, backlog recovery, and workload balancing over a selected number of days.
- Final-revision mode that raises the priority of non-mastered topics.
- Subject-neutral theory recall log: choose your own method (blank-page recall, verbal explanation, written outline, calculation/formula derivation, timed response, etc.) and record recall quality and gaps. No built-in quizzes or flashcards are included.
- Estimated mastery and weak-topic detection; per-subject syllabus coverage using tracked topics and optional expected topic counts.
- Analytics including review activity, 12-week heatmap, rating trends, subject activity, study time, and streaks.
- Mistake/concept-gap journal, past-paper and mock-exam tracking, timed sections, calculation drills, theory-recall logs, score/error tracking, and weak-area notes.
- Global search, bulk topic rescheduling/archive actions, topic CSV import/template, and CSV exports for journal, papers, selected topics, and study time.
- Full JSON backup including Study Hub data, plus restore/merge options for transferring data between devices.
- Optional Supabase cloud sync with Google OAuth or email magic-link sign-in, manual restore, and automatic uploads after local changes.
- Installable PWA shell with service-worker caching for offline use after the first successful visit.

## Data, sync, and notification limits

- Data is stored locally in the browser profile on each device. Export full JSON backups regularly and store a copy somewhere safe.
- Cloud sync is preconfigured to use the Nexus Supabase project and its public publishable key. Email magic-link sign-in and Google sign-in require the deployed GitHub Pages URL to be allowed in Supabase Auth. Never put a service_role/secret key in the app.
- In Supabase → Authentication → URL Configuration, add your deployed app URL to the allowed redirect URLs. In Authentication → Providers, enable Google and configure its OAuth client. Email sign-in uses a magic link.
- Browser notifications can be checked while the app is open and permission is granted. Reliable scheduled push notifications while the browser is fully closed require push infrastructure and a server.
- The app includes the FSRS-6 scheduler in fsrs-bundle.js; this update leaves the scheduler bundle and its integration unchanged.
- The syllabus coverage percentage reflects topics you have entered, or your optional expected topic count; it cannot independently know the complete official syllabus.

## Adding new curriculum packs (data-only workflow)

All available syllabi are defined in `curricula/catalog.json`. The Explore page and installation logic are generic: adding a new syllabus normally requires editing this JSON file only, not `index.html`, the installer, the database schema, or the service worker.

Each entry in `packs` describes one installable collection:

- `id`: permanent, unique, lowercase slug such as `lk-al-biology-si`.
- `title`, `country`, `exam`, `language`, `streamName`: catalogue and workspace labels.
- `description` and `keywords`: searchable catalogue text.
- `subjects`: an array of subjects. Each subject has a unique `id`, a `name`, and a `topics` array containing plain text strings.
- Optional `streamId` and `workspaceId` retain stable workspace IDs. Optional `legacyIdPrefix` is only for maintaining the original IDs of migrated starter topics; omit it for new packs.

Use this workflow for a curriculum suggestion received through the request form:

1. Confirm the syllabus and source/edition, then arrange its official sections into subjects and ordered topic names.
2. Add a new pack object to `curricula/catalog.json`; keep existing pack IDs and subject IDs stable. Do not duplicate topic names within one subject.
3. Run `node scripts/validate-curricula.mjs`. The GitHub Actions check also validates pull requests, including the syntax of inline scripts in `index.html`.
4. Review the Vercel preview on desktop and mobile before merging. Test installing a whole pack, one subject, one topic, and repeating each action.

Users can install a whole pack, an individual subject, or a single topic. Matching topics already in the selected stream/subject are skipped, including archived matches, so a repeat install will not duplicate them. Existing topic IDs, due dates, review intervals, FSRS-related fields, notes, and history are not reset. Renaming an installed topic is treated as a new topic, so retain official topic names where possible.

The catalogue JSON is included in the PWA cache. When online, the service worker checks the network for catalogue updates and refreshes its cached copy; when offline, the last cached catalogue remains available. The app also has the existing Commerce data as a fallback if the catalogue file cannot be read.

## Updating an existing deployment

Deploy the entire bundle, not only `index.html`. Keep the same Netlify site/domain when possible so the browser origin and its locally stored data remain the same. Before changing domains or replacing devices, download a full JSON backup and restore it on the new site/device.


## Cloud sync setup

Cloud sync uses the live `nexus-spaced-repetition` project in the Mumbai region (`ap-south-1`). Its API URL is `https://txugbdavblpettcnhcxl.supabase.co`; the app already contains its public publishable key. The `public.nexus_user_data` table and owner-only RLS policies have been created in that project. The SQL below documents the schema for reference or a separate environment.

Cloud sync uses one row per authenticated user and relies on Row Level Security (RLS).

```sql
create table if not exists public.nexus_user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.nexus_user_data enable row level security;
drop policy if exists "Users can read own Nexus backup" on public.nexus_user_data;
drop policy if exists "Users can insert own Nexus backup" on public.nexus_user_data;
drop policy if exists "Users can update own Nexus backup" on public.nexus_user_data;
create policy "Users can read own Nexus backup" on public.nexus_user_data for select using (auth.uid() = user_id);
create policy "Users can insert own Nexus backup" on public.nexus_user_data for insert with check (auth.uid() = user_id);
create policy "Users can update own Nexus backup" on public.nexus_user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

If local and cloud data differ at sign-in, Nexus offers **Merge offline data**, **Use cloud data on this device**, or **Replace cloud data with offline data**. Cancel leaves local data untouched and pauses sync. Merge combines tracker records and preserves non-conflicting Study Hub records. Cloud writes compare the last observed `updated_at` value before updating; if another device changed the backup, Nexus pauses automatic writes. Reload to compare and merge the latest data before syncing again. Keep JSON backups as an independent recovery option.


## One-time authentication setup for the deployed site

The database and client connection are configured. To allow authentication redirects for the deployed Vercel site:

1. Open the [Nexus Supabase Auth URL Configuration](https://supabase.com/dashboard/project/txugbdavblpettcnhcxl/auth/url-configuration).
2. Set **Site URL** to `https://spaced-repetition-tracker-delta.vercel.app/`.
3. Add that same URL to **Redirect URLs** and save. If you also actively use the GitHub Pages deployment, keep its URL as a separate allowed redirect rather than replacing the Vercel URL.
4. Email magic-link sign-in can then be used. For Google sign-in, open [Auth Providers](https://supabase.com/dashboard/project/txugbdavblpettcnhcxl/auth/providers), enable Google, and enter the OAuth Client ID and Client Secret from a Google Cloud OAuth web application. Add the Supabase callback URL shown on that provider page to the Google OAuth client's authorized redirect URIs.

The Supabase project-management connection available here does not expose Auth URL/provider settings, and Google OAuth requires credentials from your Google account. Those settings must be completed in the dashboard before sign-in can be fully verified. The app will continue to work offline and keep local data while cloud sign-in is not configured.

## Curriculum requests (Google Forms)

The Explore page uses a simple external Google Form link for curriculum suggestions. Nexus does not create a public wishlist, accept in-app submissions, store votes, or mirror new submissions to GitHub.

### Configure the request link

1. Create a Google Form using your Google account.
2. Copy the **responder link** (the link people use to fill out the form), not the owner's edit link.
3. Send that responder link to the maintainer to add it to the `CURRICULUM_REQUEST_FORM_URL` setting in the `curriculumRequestFormLink` script in `index.html`.
4. Verify the link in the Vercel Preview on a phone and desktop before merging.
5. The public Google Forms responder URL is not a secret. Do not put any edit link, account password, or secret credential in the app.

Suggested fields are curriculum/subject name, country, exam board or qualification, language, official syllabus/source URL, topics or chapters, and an optional contact email. Keep contact information optional and do not collect more personal information than needed.

### Retiring the old community backend

The old community request API has been removed from the application branch. Existing Supabase request and vote rows are preserved as a historical archive, but must no longer be publicly accessible.

**For an existing live installation, do not revoke the old table access until the replacement app is deployed and verified in Production.** After confirming that the Production app uses the Google Form and the old `/api/syllabus-requests` endpoint is gone, open the Supabase SQL Editor and run `supabase/migrations/20261018_retire_community_wishlist.sql` once. This migration revokes direct access from anonymous and signed-in client roles, removes the old wishlist policies, disables access to known legacy RPCs if present, and preserves stored rows.

Do not run `supabase/syllabus-community.sql` or `supabase/harden-syllabus-community-privileges.sql`; both are now marked deprecated and would not be part of the supported setup. The remaining cloud-sync setup uses `public.nexus_user_data` and is separate from the retired wishlist.

Any historical GitHub issues created by the previous wishlist are not automatically deleted. They can be retained as a record or manually closed later. The current application source no longer requires `NEXUS_ADMIN_USER_ID`, `SUPABASE_SERVICE_ROLE_KEY`, community-only `GITHUB_TOKEN` / `GITHUB_REPOSITORY` overrides, or `Nexus_KV_REST_API_URL` / `Nexus_KV_REST_API_TOKEN`. Before removing those variables from Vercel, check whether any unrelated deployed function still uses them. Never expose their values in frontend code or commit them to the repository, and never remove credentials used by an unrelated service.
