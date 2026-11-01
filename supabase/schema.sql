-- Member/Guest volunteer sign-up: database setup.
-- Paste this whole file into the Supabase SQL Editor and run it once,
-- then run seed.sql to load the shift list.
--
-- The tables are locked down (row level security with no policies), so the
-- public key on the website can't read emails or phone numbers. The page only
-- talks to the functions below.

create table if not exists public.shifts (
  id    text primary key,
  slots int  not null check (slots > 0)
);

create table if not exists public.signups (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  shift_id    text not null references public.shifts (id),
  first_name  text not null,
  last_name   text not null,
  email       text not null,
  phone       text not null,
  token       text not null,
  agreed_at   timestamptz not null,
  status      text not null default 'active' check (status in ('active', 'cancelled'))
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
    select slots into v_slots from shifts where id = v_id for update;
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
    update signups set status = 'cancelled'
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
