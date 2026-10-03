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
  created_at timestamptz not null default now(),
  numbering_mode text not null default 'unique' check (numbering_mode in ('unique', 'by_division'))
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

create table if not exists public.scoring_categories (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  finalist_weight numeric(6,2) not null default 0 check (finalist_weight >= 0 and finalist_weight <= 100),
  counts_for_finalists boolean not null default false,
  sort_order integer not null default 0,
  unique (event_id, name)
);

alter table public.events add column if not exists numbering_mode text not null default 'unique';
alter table public.events drop constraint if exists events_numbering_mode_check;
alter table public.events add constraint events_numbering_mode_check check (numbering_mode in ('unique', 'by_division'));

alter table public.contestants add column if not exists division text;
alter table public.contestants alter column division drop not null;
alter table public.contestants alter column division drop default;
update public.contestants set division = null where division = 'General';

-- Numbering is controlled by the event. Normal events require unique numbers;
-- events using division-based numbering may reuse a number in different divisions.
alter table public.contestants drop constraint if exists contestants_event_id_number_key;
drop index if exists public.contestants_event_division_number_uidx;

create or replace function public.validate_contestant_numbering()
returns trigger language plpgsql as $$
declare
  mode text;
  duplicate_found boolean;
begin
  select numbering_mode into mode from public.events where id = new.event_id;
  if mode is null then
    raise exception 'Event not found for contestant';
  end if;
  if mode = 'by_division' then
    if nullif(trim(new.division), '') is null then
      raise exception 'A division is required for this event';
    end if;
    select exists(select 1 from public.contestants c where c.event_id = new.event_id and c.division = new.division and c.number = new.number and c.id <> new.id) into duplicate_found;
  else
    if new.division is not null and trim(new.division) <> '' then
      new.division := null;
    end if;
    select exists(select 1 from public.contestants c where c.event_id = new.event_id and c.number = new.number and c.id <> new.id) into duplicate_found;
  end if;
  if duplicate_found then
    if mode = 'by_division' then
      raise exception 'Contestant number % already exists in division %', new.number, new.division;
    else
      raise exception 'Contestant number % already exists in this event', new.number;
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists contestants_validate_numbering on public.contestants;
create trigger contestants_validate_numbering
before insert or update of event_id, number, division on public.contestants
for each row execute function public.validate_contestant_numbering();

create or replace function public.validate_event_numbering_mode()
returns trigger language plpgsql as $$
declare duplicate_found boolean;
begin
  if new.numbering_mode = 'unique' and old.numbering_mode is distinct from new.numbering_mode then
    select exists(
      select 1 from public.contestants c
      where c.event_id = new.id
      group by c.number having count(*) > 1
    ) into duplicate_found;
    if duplicate_found then
      raise exception 'Cannot switch to Unique numbers while duplicate contestant numbers exist. Edit the contestants first.';
    end if;
  end if;
  if new.numbering_mode = 'by_division' and old.numbering_mode is distinct from new.numbering_mode then
    if exists(select 1 from public.contestants c where c.event_id = new.id and nullif(trim(c.division), '') is null) then
      raise exception 'Add a division to every contestant before enabling Repeat by division.';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists events_validate_numbering_mode on public.events;
create trigger events_validate_numbering_mode
before update of numbering_mode on public.events
for each row execute function public.validate_event_numbering_mode();

create table if not exists public.criteria (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  category_id uuid references public.scoring_categories(id) on delete cascade,
  name text not null,
  max_score numeric(7,2) not null default 100
);

-- Existing databases already have a criteria table from the MVP, so add the
-- new category column explicitly when the table already exists.
alter table public.criteria add column if not exists category_id uuid references public.scoring_categories(id) on delete cascade;

-- Existing criteria are placed into a neutral category. New criteria must
-- belong to a scoring category through the admin UI.
create or replace function public.ensure_general_categories()
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  event_row record;
begin
  -- Never modify scoring setup for an event that is already active.
  for event_row in
    select ev.id
    from public.events ev
    where ev.status <> 'active'
  loop
    insert into public.scoring_categories(
      event_id,
      name,
      finalist_weight,
      counts_for_finalists,
      sort_order
    )
    values(
      event_row.id,
      'General',
      0,
      false,
      0
    )
    on conflict (event_id, name) do nothing;
  end loop;

  -- Only assign General to criteria in events whose scoring setup is not locked.
  update public.criteria c
  set category_id = sc.id
  from public.scoring_categories sc
  where c.category_id is null
    and sc.event_id = c.event_id
    and sc.name = 'General'
    and exists (
      select 1
      from public.events ev
      where ev.id = sc.event_id
        and ev.status <> 'active'
    );
end;
$$;

select public.ensure_general_categories();

alter table public.criteria alter column category_id set not null;
alter table public.criteria drop constraint if exists criteria_event_id_name_key;
create unique index if not exists criteria_category_name_uidx
  on public.criteria(category_id, name);

drop function if exists public.ensure_general_categories();


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

create table if not exists public.judge_submissions (
  event_id uuid not null references public.events(id) on delete cascade,
  judge_id uuid not null references public.profiles(id) on delete restrict,
  finalized_at timestamptz not null default now(),
  primary key (event_id, judge_id)
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
alter table public.scoring_categories enable row level security;
alter table public.judge_submissions enable row level security;
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
      and not exists (
        select 1 from public.judge_submissions js
        where js.event_id = p_event and js.judge_id = auth.uid()
      )
  )
$$;

create or replace function public.judge_is_finalized(p_event uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (select 1 from public.judge_submissions where event_id=p_event and judge_id=auth.uid());
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
using (public.judge_assigned(event_id));

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
using (public.judge_assigned(event_id));

-- Scoring categories
drop policy if exists "admins manage scoring categories" on public.scoring_categories;
create policy "admins manage scoring categories"
on public.scoring_categories for all
to authenticated
using (public.current_user_role() = 'admin')
with check (public.current_user_role() = 'admin');

drop policy if exists "assigned judges read scoring categories" on public.scoring_categories;
create policy "assigned judges read scoring categories"
on public.scoring_categories for select
to authenticated
using (public.judge_assigned(event_id));

-- Judge finalization records
drop policy if exists "admins read judge submissions" on public.judge_submissions;
create policy "admins read judge submissions"
on public.judge_submissions for select
to authenticated
using (public.current_user_role() = 'admin');

drop policy if exists "judges read own submission" on public.judge_submissions;
create policy "judges read own submission"
on public.judge_submissions for select
to authenticated
using (judge_id = auth.uid());

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

-- Finalize a judge's complete scoresheet. This is intentionally a function so
-- the client cannot bypass the completion/locking rules with direct inserts.
create or replace function public.finalize_judge_scores(p_event uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_scored integer;
  v_finalized timestamptz;
begin
  if not public.judge_can_score(p_event) then
    raise exception 'Scoring is closed or this judge is not assigned to the event.';
  end if;

  select count(*) into v_total
  from public.contestants c
  cross join public.criteria k
  where c.event_id = p_event and k.event_id = p_event;

  select count(*) into v_scored
  from public.scores s
  where s.event_id = p_event and s.judge_id = auth.uid() and s.score is not null;

  if v_scored <> v_total then
    raise exception 'Please enter a score for every contestant and criterion before finalizing.';
  end if;

  v_finalized := now();
  insert into public.judge_submissions(event_id, judge_id, finalized_at)
  values(p_event, auth.uid(), v_finalized)
  on conflict (event_id, judge_id) do nothing;

  return v_finalized;
end;
$$;

revoke all on function public.finalize_judge_scores(uuid) from public;
grant execute on function public.finalize_judge_scores(uuid) to authenticated;

-- Scoring setup is also frozen while judging is active so historical scores
-- cannot change meaning after judges have started.
create or replace function public.prevent_active_scoring_setup_changes()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_event uuid; v_status text;
begin
  v_event := coalesce(new.event_id, old.event_id);
  select status into v_status from public.events where id=v_event;
  if v_status = 'active' then
    raise exception 'Scoring setup cannot be changed while the event is Active.';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end; $$;

drop trigger if exists scoring_categories_lock_active on public.scoring_categories;
create trigger scoring_categories_lock_active
before insert or update or delete on public.scoring_categories
for each row execute function public.prevent_active_scoring_setup_changes();

drop trigger if exists criteria_lock_active on public.criteria;
create trigger criteria_lock_active
before insert or update or delete on public.criteria
for each row execute function public.prevent_active_scoring_setup_changes();

create or replace function public.validate_criterion_category_event()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_category_event uuid;
begin
  select event_id into v_category_event from public.scoring_categories where id=new.category_id;
  if v_category_event is distinct from new.event_id then
    raise exception 'Criterion category must belong to the same event.';
  end if;
  return new;
end; $$;

drop trigger if exists criteria_category_event_check on public.criteria;
create trigger criteria_category_event_check
before insert or update on public.criteria
for each row execute function public.validate_criterion_category_event();

-- Contestant records are frozen once judging is active. This protects the
-- contestant list even if the browser-side disabled controls are bypassed.
create or replace function public.prevent_active_contestant_changes()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_event uuid; v_status text;
begin
  v_event := coalesce(new.event_id, old.event_id);
  select status into v_status from public.events where id=v_event;
  if v_status = 'active' then
    raise exception 'Contestants cannot be changed while the event is Active.';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end; $$;

drop trigger if exists contestants_lock_active on public.contestants;
create trigger contestants_lock_active
before insert or update or delete on public.contestants
for each row execute function public.prevent_active_contestant_changes();

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
-- Removing a judge from an event should delete only the event assignment;
-- historical scores remain because scores reference the judge profile directly.

-- ---------------------------------------------------------------
-- ADMIN: EDIT A JUDGE (name / login email / password)
-- ---------------------------------------------------------------
-- Nothing to deploy: this is a database function.
-- Only a signed-in ADMIN can call it, and it only works on judge accounts.

create or replace function public.admin_update_judge(
  p_judge_id uuid,
  p_display_name text default null,   -- null = leave unchanged
  p_email text default null,          -- null = leave unchanged
  p_password text default null        -- null = leave unchanged
)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_name   text := btrim(coalesce(p_display_name, ''));
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_target public.profiles%rowtype;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only admins can edit judge accounts.';
  end if;

  select * into v_target from public.profiles where id = p_judge_id;
  if not found or v_target.role <> 'judge' then
    raise exception 'Judge account not found.';
  end if;

  if p_display_name is not null and v_name = '' then
    raise exception 'Name can''t be empty.';
  end if;
  if p_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;
  if p_password is not null and length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;

  -- Login email (auth.users + the email identity)
  if p_email is not null and v_email <> lower(coalesce(v_target.email, '')) then
    if exists (select 1 from auth.users u where lower(u.email) = v_email and u.id <> p_judge_id) then
      raise exception 'That email is already used by another account.';
    end if;
    update auth.users
       set email = v_email,
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = p_judge_id;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)),
           updated_at = now()
     where user_id = p_judge_id and provider = 'email';
  end if;

  -- Password reset
  if p_password is not null then
    update auth.users
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           updated_at = now()
     where id = p_judge_id;
  end if;

  -- Name / email shown in the admin pages
  update public.profiles
     set display_name = case when p_display_name is not null then v_name else display_name end,
         email        = case when p_email is not null then v_email else email end
   where id = p_judge_id;
end;
$$;

revoke all on function public.admin_update_judge(uuid, text, text, text) from public, anon;
grant execute on function public.admin_update_judge(uuid, text, text, text) to authenticated;
