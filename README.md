# Judging System MVP

Stack: HTML, CSS, JavaScript, Supabase (PostgreSQL, Auth, Row Level Security, Edge Functions)

## How it works

- The admin creates an event, adds contestants and criteria, and creates judge accounts for that event.
- A judge can log in and score **only while their event's status is `active`** and their own access switch is on.
- Judge scores appear on the admin page, which ranks contestants live (refreshes every 3 seconds).
- Scores are never deleted when access ends. The admin can switch between events at any time and all scores stay.

## Setup

1. Create a Supabase project.
2. Open the SQL Editor, paste and run `schema.sql`. It is safe to run again on an existing project (it adds the `email` column, switches `scores.judge_id` to `on delete restrict`, and updates the policies).
3. Rename `config.example.js` to `config.js` and paste your project URL and publishable/anon key. Never put the `service_role` key in it, and don't commit `config.js` to a public repo.
4. Create your admin user in Supabase Authentication, then run:

       insert into public.profiles (id, display_name, role, email)
       values ('YOUR-AUTH-USER-UUID', 'Admin', 'admin', 'your@email.com');

5. Deploy the judge-creation function (needs the Supabase CLI, run inside this folder):

       supabase login
       supabase link --project-ref YOUR-PROJECT-REF
       supabase functions deploy create-judge

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically.
6. Serve the folder through a local web server. Do not open `index.html` with `file://`.

## Running a judging round

1. Create the event, then add contestants and criteria.
2. Create the judge accounts (name, email, password) and give each judge their login.
3. Set the event status to **Active**. Judges can now score.
4. Watch the Results section rank contestants as judges finish.
5. Set the event to **Completed**. Judges are locked out immediately; scores stay.

## Rules built into the database

- Judges see only their own scores and only their assigned event.
- Contestants and criteria are visible to judges only while the event is active.
- Scores must be between 0 and the criterion's max, checked server-side by a trigger.
- A score's contestant and criterion must belong to the same event.
- Deleting a judge account is blocked while they have scores. Turn access off instead.

## Notes

- Ranking uses the average of each judge's total, counting only judges who scored every criterion for that contestant. Ties share a rank.
- Supabase returns at most 1000 rows per request by default. The scores query asks for up to 10,000, but your project's API "max rows" setting is the real cap.

## Next phase

- Delete/edit contestants and criteria
- Weighted criteria
- Printable final results
- Judge password reset from the admin page
