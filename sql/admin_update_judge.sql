-- ADMIN: EDIT A JUDGE (name, login email, password)
-- Paste this whole file into Supabase -> SQL Editor -> Run. Safe to run again.
--
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
