# Judging System

Stack: HTML, CSS, JavaScript, Supabase (PostgreSQL, Auth, Edge Functions)

## What this version supports

### Admin
- Create and manage events.
- Contestants use unique numbers by default, so ordinary events require no extra setup.
- If an event needs separate numbering (for example, Mr./Ms.), switch **Numbering** to **Repeat by division**; only then is a division entered and the same number may be reused across different divisions.
- Edit or remove contestants while the event is not Active.
- Once an event is Active, contestant add/edit/remove controls are disabled and the database also blocks changes.
- Add judges, switch their event access on/off, or remove a judge from the event. Removing a judge does not delete their historical scores.
- Create any scoring categories needed for the event (the sample names Photogenic, Evening Wear, Opening Production, etc. are not hardcoded).
- Give each category one or more criteria and a maximum score.
- Mark any category as part of finalist selection and assign its own finalist weight. There are no hardcoded category names or percentages.
- Weighted finalist contribution is calculated as:

      (category score / category maximum) × category weight

  The 15%/50% examples are illustrative only. The admin-entered category weight is used dynamically for every event.
- View overall finalist rankings and each judge's detailed scores.
- Export overall results or an individual judge's results as PDF.

### Judge
- Score each criterion from 0 to its maximum.
- Values typed below 0 are automatically clamped to 0; values above the maximum are automatically clamped to the maximum.
- Finalize the scoresheet with a confirmation message: **"Once submitted, the scores can no longer be altered."**
- After finalization, scores are locked by the database, not only by the browser UI.

## Setup

1. Create a Supabase project.
2. Open the SQL Editor and run `schema.sql`. The script is written as a migration-friendly script for the existing MVP schema.
3. Rename `config.example.js` to `config.js` and paste your project URL and publishable/anon key. Never put the `service_role` key in browser code.
4. Create your admin user in Supabase Authentication, then run:

       insert into public.profiles (id, display_name, role, email)
       values ('YOUR-AUTH-USER-UUID', 'Admin', 'admin', 'your@email.com');

5. Deploy both Edge Functions with the Supabase CLI (they use the service role key server-side only):

       supabase functions deploy create-judge
       supabase functions deploy update-judge

   `update-judge` lives in `functions/update-judge/index.ts`. It powers the **Edit** button on the Judges tab (name, login email, password reset).
6. Serve the folder through a local web server. Do not open `index.html` with `file://`.

## Running a judging round

1. Create an event.
2. Add Miss/Mister contestants.
3. Create scoring categories and assign criteria to each category.
4. For whichever categories should contribute to finalist selection, enable **Count for finalists** and enter the percentage weight you want for that event.
5. Create judge accounts and assign access.
6. Set the event to **Active**. Contestant/scoring-setup changes are locked and judges can score.
7. Judges enter every score, then select **Finalize Score** and confirm.
8. Watch the weighted finalist results update in the admin Results tab.
9. Export overall or per-judge PDF results when needed.
10. Set the event to **Completed** when judging is finished.

## Important database rules

- Contestant numbering is controlled per event: `event + number` by default, or `event + division + number` when **Repeat by division** is enabled.
- Scores remain stored after a judge is removed from an event.
- Finalized judge scores cannot be updated because the score RLS policies check the finalization record.
- The finalization RPC requires every contestant/criterion combination to have a score before it will finalize.
- Score range validation is enforced server-side.
- Criteria must belong to a scoring category from the same event.
- Contestants and scoring setup are frozen once the event is Active.

## PDF libraries

The browser loads `jsPDF` and `jsPDF-AutoTable` from jsDelivr in `index.html` for PDF generation. An internet connection is required for those CDN assets unless you replace them with locally hosted copies.
