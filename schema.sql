create extension if not exists "pgcrypto";

--table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('admin', 'judge')),
  created_at timestamptz not null default now()
);

-- NEW: store the login email so the admin can see which account is which.
alter table public.profiles add column if not exists email text;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'completed', 'archived')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.event_judges (
  event_id uuid not null references public.events(id) on delete cascade,
  judge_id uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  primary key (event_id, judge_id)
);

create table if not exists public.contestants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  number integer not null,
  name text not null,
  unique (event_id, number)
);

create table if not exists public.criteria (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  max_score numeric(7,2) not null default 100,
  unique (event_id, name)
);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  judge_id uuid not null references public.profiles(id) on delete restrict,
  contestant_id uuid not null references public.contestants(id) on delete cascade,
  criterion_id uuid not null references public.criteria(id) on delete cascade,
  score numeric(7,2),
  submitted_at timestamptz,
  unique (event_id, judge_id, contestant_id, criterion_id)
);

-- Existing databases: change scores.judge_id from CASCADE to RESTRICT so that
-- deleting a judge account can never silently wipe their scores.
alter table public.scores drop constraint if exists scores_judge_id_fkey;
alter table public.scores
  add constraint scores_judge_id_fkey
  foreign key (judge_id) references public.profiles(id) on delete restrict;

create index if not exists scores_event_idx on public.scores(event_id);
create index if not exists scores_judge_idx on public.scores(judge_id);

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_judges enable row level security;
alter table public.contestants enable row level security;
alter table public.criteria enable row level security;
alter table public.scores enable row level security;

-- ---------------------------------------------------------------
-- HELPER FUNCTIONS
-- ---------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Judge is assigned to the event and their assignment is switched on.
create or replace function public.judge_assigned(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.event_judges ej
    where ej.event_id = p_event
      and ej.judge_id = auth.uid()
      and ej.active = true
  )
$$;

-- Same as above AND the event is 'active'. This is the "temporary access" switch:
-- mark the event completed and every judge of it is locked out of scoring.
create or replace function public.judge_can_score(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.event_judges ej
    join public.events e on e.id = ej.event_id
    where ej.event_id = p_event
      and ej.judge_id = auth.uid()
      and ej.active = true
      and e.status = 'active'
  )
$$;

-- ---------------------------------------------------------------
-- POLICIES
-- ---------------------------------------------------------------

-- Profiles: read your own; admins read all. (Profiles are created only by the
-- create-judge Edge Function, which uses the service role.)
drop policy if exists "profile self read" on public.profiles;
create policy "profile self read"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.current_user_role() = 'admin');

-- Events
drop policy if exists "admins manage events" on public.events;
create policy "admins manage events"
on public.events for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "judges read assigned events" on public.events;
create policy "judges read assigned events"
on public.events for select
to authenticated
using (public.judge_assigned(id));

-- Event judges
drop policy if exists "admins manage event judges" on public.event_judges;
create policy "admins manage event judges"
on public.event_judges for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "judges read own assignment" on public.event_judges;
create policy "judges read own assignment"
on public.event_judges for select
to authenticated
using (judge_id = auth.uid());

-- Contestants (judges see them only while the event is active)
drop policy if exists "admins manage contestants" on public.contestants;
create policy "admins manage contestants"
on public.contestants for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "assigned judges read contestants" on public.contestants;
create policy "assigned judges read contestants"
on public.contestants for select
to authenticated
using (public.judge_can_score(event_id));

-- Criteria
drop policy if exists "admins manage criteria" on public.criteria;
create policy "admins manage criteria"
on public.criteria for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "assigned judges read criteria" on public.criteria;
create policy "assigned judges read criteria"
on public.criteria for select
to authenticated
using (public.judge_can_score(event_id));

-- Scores
drop policy if exists "admins manage scores" on public.scores;
create policy "admins manage scores"
on public.scores for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "judges read own scores" on public.scores;
create policy "judges read own scores"
on public.scores for select
to authenticated
using (judge_id = auth.uid() and public.judge_assigned(event_id));

drop policy if exists "judges insert own scores" on public.scores;
create policy "judges insert own scores"
on public.scores for insert
to authenticated
with check (judge_id = auth.uid() and public.judge_can_score(event_id));

drop policy if exists "judges update own scores" on public.scores;
create policy "judges update own scores"
on public.scores for update
to authenticated
using (judge_id = auth.uid() and public.judge_can_score(event_id))
with check (judge_id = auth.uid() and public.judge_can_score(event_id));

-- ---------------------------------------------------------------
-- SERVER-SIDE SCORE VALIDATION
-- The browser check (0..max) can be bypassed, so enforce it here too.
-- ---------------------------------------------------------------
create or replace function public.validate_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contestant_event uuid;
  v_criterion_event uuid;
  v_max numeric;
begin
  select event_id into v_contestant_event
    from public.contestants where id = new.contestant_id;
  select event_id, max_score into v_criterion_event, v_max
    from public.criteria where id = new.criterion_id;

  if v_contestant_event is distinct from new.event_id
     or v_criterion_event is distinct from new.event_id then
    raise exception 'Contestant and criterion must belong to the same event as the score.';
  end if;

  if new.score is not null and (new.score < 0 or new.score > v_max) then
    raise exception 'Score must be between 0 and %.', v_max;
  end if;

  return new;
end;
$$;

drop trigger if exists scores_validate on public.scores;
create trigger scores_validate
before insert or update on public.scores
for each row execute function public.validate_score();

-- IMPORTANT:
-- Never put the service_role key in the browser.
-- Judge accounts are created by the `create-judge` Edge Function
-- (supabase/functions/create-judge/index.ts).
-- Never delete judge accounts: disable them (event_judges.active = false)
-- or complete the event. Scores are kept either way.
