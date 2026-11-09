-- Member/Guest volunteer sign-up: database setup.
-- Paste this whole file into the Supabase SQL Editor and run it once,
-- then run seed.sql to load the shift list.
--
-- The tables are locked down (row level security with no policies), so the
-- public key on the website can't read emails or phone numbers. The page only
-- talks to the functions below.

create table if not exists public.shifts (
  id         text primary key,
  slots      int  not null check (slots > 0),
  admin_only boolean not null default false   -- filled only from the admin page (e.g. Game Day Coordinator)
);
alter table public.shifts add column if not exists admin_only boolean not null default false;

create table if not exists public.signups (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  shift_id    text not null references public.shifts (id),
  first_name  text not null,
  last_name   text not null,
  email       text not null,
  phone       text not null,
  token       text not null,
  agreed_at   timestamptz,          -- when the volunteer checked the disclaimer box; null if an admin added them
  status      text not null default 'active' check (status in ('active', 'cancelled')),
  changed_by  text not null default 'volunteer' check (changed_by in ('volunteer', 'admin')),
  changed_at  timestamptz not null default now()
);

create unique index if not exists signups_one_active_per_person
  on public.signups (shift_id, email) where status = 'active';
create index if not exists signups_token on public.signups (token);
create index if not exists signups_email on public.signups (email);

alter table public.shifts  enable row level security;
alter table public.signups enable row level security;
revoke all on public.shifts, public.signups from anon, authenticated;

-- Names shown on the public page: first name + last initial, per shift.
create or replace function public.list_filled()
returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_object_agg(shift_id, names), '{}'::json)
  from (
    select shift_id,
           json_agg(first_name || ' ' || left(last_name, 1) || '.' order by created_at) as names
    from signups
    where status = 'active'
    group by shift_id
  ) t;
$$;

-- Sign up for one or more shifts. Shifts that filled up in the meantime are
-- returned in "full" rather than failing the whole request.
create or replace function public.signup(
  p_first text, p_last text, p_email text, p_phone text, p_agreed boolean, p_shift_ids text[]
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_first   text := left(trim(coalesce(p_first, '')), 40);
  v_last    text := left(trim(coalesce(p_last, '')), 40);
  v_email   text := left(lower(trim(coalesce(p_email, ''))), 100);
  v_phone   text := left(trim(coalesce(p_phone, '')), 20);
  v_token   text;
  v_id      text;
  v_slots   int;
  v_taken   int;
  v_added   text[] := '{}';
  v_full    text[] := '{}';
  v_already text[] := '{}';
begin
  if v_first = '' or v_last = '' then
    raise exception 'Please enter your first and last name.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Please enter a valid email address.';
  end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'Please enter a 10-digit phone number.';
  end if;
  if p_agreed is not true then
    raise exception 'Please confirm you understand this is a member-run site.';
  end if;
  if p_shift_ids is null or cardinality(p_shift_ids) = 0 or cardinality(p_shift_ids) > 20 then
    raise exception 'Please pick at least one shift.';
  end if;

  -- One personal link per email address, reused on later sign-ups.
  select token into v_token from signups where email = v_email limit 1;
  if v_token is null then
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  -- Sorted so two people signing up at once always lock shifts in the same order.
  foreach v_id in array (select array_agg(distinct x order by x) from unnest(p_shift_ids) x) loop
    -- Admin-only shifts can't be taken from the public page.
    select slots into v_slots from shifts where id = v_id and not admin_only for update;
    if not found then
      continue;
    end if;
    if exists (select 1 from signups where shift_id = v_id and email = v_email and status = 'active') then
      v_already := v_already || v_id;
      continue;
    end if;
    select count(*) into v_taken from signups where shift_id = v_id and status = 'active';
    if v_taken >= v_slots then
      v_full := v_full || v_id;
      continue;
    end if;
    insert into signups (shift_id, first_name, last_name, email, phone, token, agreed_at)
    values (v_id, v_first, v_last, v_email, v_phone, v_token, now());
    v_added := v_added || v_id;
  end loop;

  return json_build_object('token', v_token, 'added', v_added, 'full', v_full, 'already', v_already);
end;
$$;

-- Shifts for a personal link. Returns null if the link is unknown.
create or replace function public.my_shifts(p_token text)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object(
    'firstName', (array_agg(first_name order by created_at))[1],
    'shiftIds', coalesce(array_agg(shift_id order by created_at) filter (where status = 'active'), '{}')
  )
  from signups
  where token = p_token
  having count(*) > 0;
$$;

create or replace function public.cancel_shift(p_token text, p_shift_id text)
returns boolean
language sql security definer set search_path = public
as $$
  with c as (
    update signups set status = 'cancelled', changed_by = 'volunteer', changed_at = now()
    where token = p_token and shift_id = p_shift_id and status = 'active'
    returning 1
  )
  select count(*) > 0 from c;
$$;

-- "Look up my shifts": the email or the phone number used to sign up.
-- Phones compare on the last 10 digits, so "+1 (541) 555-0100" matches "5415550100".
drop function if exists public.find_link(text, text);
create or replace function public.find_link(p_contact text)
returns text
language sql stable security definer set search_path = public
as $$
  select token from signups
  where case
    when position('@' in coalesce(p_contact, '')) > 0 then email = lower(trim(p_contact))
    else length(regexp_replace(coalesce(p_contact, ''), '\D', '', 'g')) >= 10
     and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(p_contact, '\D', '', 'g'), 10)
  end
  order by created_at
  limit 1;
$$;

revoke execute on function public.list_filled(), public.signup(text, text, text, text, boolean, text[]),
  public.my_shifts(text), public.cancel_shift(text, text), public.find_link(text) from public;
grant execute on function public.list_filled(), public.signup(text, text, text, text, boolean, text[]),
  public.my_shifts(text), public.cancel_shift(text, text), public.find_link(text) to anon, authenticated;

-- Coordinator roster (Supabase dashboard → Table Editor → roster, or export as CSV).
create or replace view public.roster with (security_invoker = true) as
  select s.shift_id, s.first_name, s.last_name, s.phone, s.email, s.created_at
  from signups s
  where s.status = 'active'
  order by s.shift_id, s.created_at;
revoke all on public.roster from anon, authenticated;

-- ============================================================
-- Admin page (admin.html): protected by one shared passcode.
-- Set or change the passcode in the SQL Editor (see README):
--   select public.set_admin_passcode('your-passcode-here');
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_settings (
  id            int primary key default 1 check (id = 1),
  passcode_hash text not null
);

-- Wrong passcodes, for the lockout (10 wrong tries in 15 minutes).
create table if not exists public.admin_failures (
  at timestamptz not null default now()
);

alter table public.admin_settings enable row level security;
alter table public.admin_failures enable row level security;
revoke all on public.admin_settings, public.admin_failures from anon, authenticated;

create or replace function public.set_admin_passcode(p_new text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
begin
  if length(coalesce(p_new, '')) < 8 then
    raise exception 'Use a passcode of at least 8 characters.';
  end if;
  insert into admin_settings (id, passcode_hash) values (1, crypt(p_new, gen_salt('bf')))
  on conflict (id) do update set passcode_hash = excluded.passcode_hash;
  delete from admin_failures;
  return 'Admin passcode set.';
end;
$$;

-- Returns null when the passcode is right, otherwise a message to show.
-- Callers return that message instead of raising, so the failure record is kept.
create or replace function public.admin_check_(p_code text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  delete from admin_failures where at < now() - interval '1 day';
  if (select count(*) from admin_failures where at > now() - interval '15 minutes') >= 10 then
    return 'Too many wrong passcodes. Please wait 15 minutes and try again.';
  end if;
  select passcode_hash into v_hash from admin_settings where id = 1;
  if v_hash is null then
    return 'No admin passcode has been set yet.';
  end if;
  if crypt(coalesce(p_code, ''), v_hash) = v_hash then
    return null;
  end if;
  insert into admin_failures default values;
  return 'Wrong passcode.';
end;
$$;

create or replace function public.admin_roster(p_code text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_err text := admin_check_(p_code);
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  return json_build_object('ok', true, 'signups', coalesce((
    select json_agg(json_build_object(
      'id', id, 'shiftId', shift_id, 'firstName', first_name, 'lastName', last_name,
      'email', email, 'phone', phone, 'createdAt', created_at, 'changedBy', changed_by
    ) order by created_at)
    from signups where status = 'active'
  ), '[]'::json));
end;
$$;

create or replace function public.admin_move(p_code text, p_signup_id bigint, p_shift_id text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_err   text := admin_check_(p_code);
  v_row   signups%rowtype;
  v_slots int;
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  select * into v_row from signups where id = p_signup_id and status = 'active' for update;
  if not found then
    return json_build_object('ok', false, 'error', 'That sign-up no longer exists. Refresh the page.');
  end if;
  if v_row.shift_id = p_shift_id then
    return json_build_object('ok', true);
  end if;
  select slots into v_slots from shifts where id = p_shift_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'Unknown shift.');
  end if;
  if exists (select 1 from signups where shift_id = p_shift_id and email = v_row.email and status = 'active') then
    return json_build_object('ok', false, 'error', v_row.first_name || ' is already on that shift.');
  end if;
  if (select count(*) from signups where shift_id = p_shift_id and status = 'active') >= v_slots then
    return json_build_object('ok', false, 'error', 'That shift is full. Refresh to see the latest openings.');
  end if;
  update signups set shift_id = p_shift_id, changed_by = 'admin', changed_at = now() where id = p_signup_id;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.admin_cancel(p_code text, p_signup_id bigint)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_err text := admin_check_(p_code);
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  update signups set status = 'cancelled', changed_by = 'admin', changed_at = now()
  where id = p_signup_id and status = 'active';
  return json_build_object('ok', true);
end;
$$;

-- For volunteers who call or email instead of using the site.
create or replace function public.admin_add(
  p_code text, p_first text, p_last text, p_email text, p_phone text, p_shift_id text
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_err   text := admin_check_(p_code);
  v_first text := left(trim(coalesce(p_first, '')), 40);
  v_last  text := left(trim(coalesce(p_last, '')), 40);
  v_email text := left(lower(trim(coalesce(p_email, ''))), 100);
  v_phone text := left(trim(coalesce(p_phone, '')), 20);
  v_slots int;
  v_token text;
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  if v_first = '' or v_last = '' then
    return json_build_object('ok', false, 'error', 'Enter a first and last name.');
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return json_build_object('ok', false, 'error', 'Enter a valid email address.');
  end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    return json_build_object('ok', false, 'error', 'Enter a 10-digit phone number.');
  end if;
  select slots into v_slots from shifts where id = p_shift_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'Unknown shift.');
  end if;
  if exists (select 1 from signups where shift_id = p_shift_id and email = v_email and status = 'active') then
    return json_build_object('ok', false, 'error', v_first || ' is already on that shift.');
  end if;
  if (select count(*) from signups where shift_id = p_shift_id and status = 'active') >= v_slots then
    return json_build_object('ok', false, 'error', 'That shift is full. Refresh to see the latest openings.');
  end if;
  select token into v_token from signups where email = v_email limit 1;
  if v_token is null then
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;
  insert into signups (shift_id, first_name, last_name, email, phone, token, agreed_at, changed_by)
  values (p_shift_id, v_first, v_last, v_email, v_phone, v_token, null, 'admin');
  return json_build_object('ok', true);
end;
$$;

revoke execute on function public.set_admin_passcode(text), public.admin_check_(text),
  public.admin_roster(text), public.admin_move(text, bigint, text), public.admin_cancel(text, bigint),
  public.admin_add(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_roster(text), public.admin_move(text, bigint, text),
  public.admin_cancel(text, bigint), public.admin_add(text, text, text, text, text, text) to anon, authenticated;
