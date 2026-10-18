# Nexus: Spaced Repetition Tracker (Netlify bundle)

A mobile-friendly, offline-first study tracker packaged as an installable Progressive Web App (PWA). The bundle is static and does not need a build command. Optional cloud sync is preconfigured to use the Nexus Supabase project.

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

Use this workflow for a community request:

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

If a cloud backup already exists at sign-in, Nexus asks you to type RESTORE or UPLOAD; cancel leaves both copies untouched. A newer remote backup is protected from silent overwrite. Restore cloud backup replaces this device’s local data after confirmation. Keep JSON backups as an independent recovery option.


## One-time authentication setup for the deployed site

The database and client connection are configured. To allow authentication redirects for the GitHub Pages deployment:

1. Open the [Nexus Supabase Auth URL Configuration](https://supabase.com/dashboard/project/txugbdavblpettcnhcxl/auth/url-configuration).
2. Set **Site URL** to `https://kkmalithmalshan2000-png.github.io/Spaced-Repetition-Tracker/`.
3. Add that same URL to **Redirect URLs** and save.
4. Email magic-link sign-in can then be used. For Google sign-in, open [Auth Providers](https://supabase.com/dashboard/project/txugbdavblpettcnhcxl/auth/providers), enable Google, and enter the OAuth Client ID and Client Secret from a Google Cloud OAuth web application. Add the Supabase callback URL shown on that provider page to the Google OAuth client's authorized redirect URIs.

The Supabase project-management connection available here does not expose Auth URL/provider settings, and Google OAuth requires credentials from your Google account. Those settings must be completed in the dashboard before sign-in can be fully verified. The app will continue to work offline and keep local data while cloud sign-in is not configured.

## Community syllabus requests (Vercel)

The Explore Curriculum view includes a request form and community wishlist. The API route is `/api/syllabus-requests`.

To persist submissions and populate the shared wishlist, configure the following in **Vercel → Project → Settings → Environment Variables**, then redeploy:

- `GITHUB_TOKEN` — a fine-grained GitHub token with **Issues: Read and write** permission for this repository. The API creates one issue per request and lists those issues in the wishlist.
- `GITHUB_REPOSITORY` — optional; defaults to `kkmalithmalshan2000-png/Spaced-Repetition-Tracker`.
- `SYLLABUS_REQUEST_WEBHOOK_URL` — optional private HTTPS webhook for notifications. If configured, it receives the submitted fields including the optional email address. Email addresses are deliberately excluded from public GitHub issues.

Without `GITHUB_TOKEN` or `SYLLABUS_REQUEST_WEBHOOK_URL`, the API returns a clear unavailable response; the app keeps an offline request draft in that user's browser, but it is not shared with other users until successfully submitted. Configure secrets only in Vercel environment variables, never in client-side code.


## Community syllabus wishlist setup (upvotes and owner-only deletion)

The community wishlist uses the app's existing Supabase authentication. Users must sign in to submit a request, upvote it, or delete a request they own. Each account can upvote a request once; no downvotes are available. Supabase Row Level Security (RLS) enforces ownership and vote uniqueness on the database, not just in the UI.

### One-time Supabase setup

1. Open the Supabase project used by Nexus: https://supabase.com/dashboard/project/txugbdavblpettcnhcxl
2. Open **SQL Editor** and create a new query.
3. Open `supabase/syllabus-community.sql` in this repository, copy its full contents into the SQL Editor, and run it.
4. Confirm that the `nexus_syllabus_requests` and `nexus_syllabus_votes` tables were created.

**For an existing live installation:** do not rerun the entire setup SQL to apply the privacy fix. Use the staged migrations in this order:

1. Apply `supabase/migrations/20261016_hide_syllabus_vote_identities.sql` and `supabase/migrations/20261018_hide_syllabus_request_owner_ids.sql`. These add restricted RPCs without revoking the current table grants, so the existing Production API remains compatible.
2. Test the Preview API against those RPCs: signed-out wishlist, vote totals, signed-in owner status, own-vote status, request submission, owner-only deletion, upvote and remove-upvote.
3. Merge the reviewed PR and wait until the updated API is deployed to Production.
4. Only then apply `supabase/migrations/20261017_revoke_public_syllabus_vote_reads.sql` and `supabase/migrations/20261019_revoke_public_syllabus_request_reads.sql`.

**Do not run either revoke migration before Production is using the updated API.** The additive migrations do not modify existing table grants; the revoke migrations do.

### Vercel environment variables

The API uses the same public Supabase project as Nexus. In the Vercel project settings, add these variables for **Preview** and **Production** if they are not already present:

- `SUPABASE_URL` = `https://txugbdavblpettcnhcxl.supabase.co`
- `SUPABASE_ANON_KEY` = the project's **publishable/anon key** (never use a service-role or secret key here).

Redeploy the preview after adding environment variables. No service-role key is required; requests are made with each user's session token and database RLS policies.

### Manual test checklist

- Sign in as Account A and submit a request.
- Sign in as Account B (preferably in a separate browser profile) and confirm the request appears.
- Account B upvotes it; the count increases by one. Repeated clicks must not create additional votes.
- Account B must not see a delete button for Account A's request. Even a crafted API call must be rejected by RLS.
- Account A sees **Delete my request** and can delete it; its votes are removed automatically.
- Verify signed-out users can browse the wishlist but are prompted to sign in before submitting or upvoting.


## Public request tracker and administrator controls

Nexus mirrors community curriculum requests to the public GitHub Issues tracker at https://github.com/kkmalithmalshan2000-png/Spaced-Repetition-Tracker/issues. New submissions are saved to the shared Supabase wishlist and mirrored to GitHub. Existing wishlist items can be synchronised in batches using the administrator-only **Sync existing requests to GitHub** button in Explore Curriculum. Each mirrored issue contains a stable Nexus request ID so it can be found and closed later.

### Vercel environment variables for the public request tracker

Set these in Vercel Project → Settings → Environment Variables for Preview and Production, then redeploy the matching deployment:

- `GITHUB_TOKEN`: a fine-grained GitHub token with **Issues: Read and write** access to this repository.
- `GITHUB_REPOSITORY`: optional; defaults to `kkmalithmalshan2000-png/Spaced-Repetition-Tracker`.
- `NEXUS_ADMIN_USER_ID`: the UUID of the owner's Nexus Supabase Auth user. Find it in Supabase Dashboard → Authentication → Users. Only this authenticated account receives administrator controls and can remove any community request.
- `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key for this project. It is used only inside the Vercel serverless function for administrator deletion and administrator-only request synchronisation. **Never add this key to browser code, GitHub, or any public file.**

Regular users can still delete only requests they created. The configured Nexus administrator can mark any request fulfilled and remove it from the in-app wishlist; the corresponding GitHub issue is closed as completed. The administrator sync action mirrors pre-existing requests in batches, avoiding a large single serverless request. If the GitHub mirror is temporarily unavailable, a newly submitted request remains saved in the shared Supabase wishlist and can be synced later.
