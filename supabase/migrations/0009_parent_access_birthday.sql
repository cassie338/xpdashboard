-- Parent dashboard access is verified server-side. The birthday is accepted
-- once during signup, removed from Auth metadata, and stored only as a hash.

create table public.parent_access_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_code_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.parent_access_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.parent_access_credentials enable row level security;
alter table public.parent_access_attempts enable row level security;
revoke all on public.parent_access_credentials from public, anon, authenticated;
revoke all on public.parent_access_attempts from public, anon, authenticated;

-- Preserve the previous access code for existing accounts. Individual account
-- changes are administrative data operations and are not embedded in migrations.
insert into public.parent_access_credentials (user_id, access_code_hash)
select id, extensions.crypt('1987', extensions.gen_salt('bf', 10))
from auth.users
on conflict (user_id) do nothing;

create function public.prepare_parent_access_for_signup()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  parent_birthday text := trim(coalesce(new.raw_user_meta_data ->> 'parent_birthday', ''));
begin
  if parent_birthday !~ '^(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/[0-9]{2}$'
    or to_char(to_date(parent_birthday, 'MM/DD/YY'), 'MM/DD/YY') <> parent_birthday then
    raise exception 'A valid parent birthday in MM/DD/YY format is required';
  end if;

  perform set_config(
    'unbound.parent_access_hash',
    extensions.crypt(parent_birthday, extensions.gen_salt('bf', 10)),
    true
  );
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'parent_birthday';
  return new;
end;
$$;

create trigger prepare_parent_access_before_signup
before insert on auth.users
for each row execute function public.prepare_parent_access_for_signup();

create function public.strip_parent_birthday_metadata()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'parent_birthday';
  return new;
end;
$$;

create trigger strip_parent_birthday_on_metadata_update
before update of raw_user_meta_data on auth.users
for each row execute function public.strip_parent_birthday_metadata();

create or replace function public.create_dashboard_for_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  new_learner_id uuid;
  parent_access_hash text := current_setting('unbound.parent_access_hash', true);
begin
  if parent_access_hash is null or parent_access_hash = '' then
    raise exception 'Parent access credential was not prepared';
  end if;

  insert into public.learners (user_id, display_name, is_default)
  values (new.id, 'My Learner', true)
  returning id into new_learner_id;
  insert into public.dashboard_settings (user_id, learner_id)
  values (new.id, new_learner_id);
  insert into public.parent_access_credentials (user_id, access_code_hash)
  values (new.id, parent_access_hash);
  return new;
end;
$$;

create function public.verify_parent_access(p_birthday text)
returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  stored_hash text;
  attempt_record public.parent_access_attempts%rowtype;
  attempt_count integer;
begin
  if current_user_id is null then return false; end if;

  select access_code_hash into stored_hash
  from public.parent_access_credentials
  where user_id = current_user_id;
  if not found then return false; end if;

  select * into attempt_record
  from public.parent_access_attempts
  where user_id = current_user_id
  for update;

  if found and attempt_record.locked_until > now() then return false; end if;

  if stored_hash = extensions.crypt(trim(coalesce(p_birthday, '')), stored_hash) then
    delete from public.parent_access_attempts where user_id = current_user_id;
    return true;
  end if;

  if not found or attempt_record.window_started_at < now() - interval '15 minutes' then
    attempt_count := 1;
    insert into public.parent_access_attempts (user_id, failed_attempts, window_started_at, locked_until)
    values (current_user_id, attempt_count, now(), null)
    on conflict (user_id) do update
      set failed_attempts = excluded.failed_attempts,
          window_started_at = excluded.window_started_at,
          locked_until = excluded.locked_until;
  else
    attempt_count := attempt_record.failed_attempts + 1;
    update public.parent_access_attempts
    set failed_attempts = attempt_count,
        locked_until = case when attempt_count >= 5 then now() + interval '15 minutes' else null end
    where user_id = current_user_id;
  end if;

  return false;
end;
$$;

revoke all on function public.prepare_parent_access_for_signup() from public, anon, authenticated, service_role;
revoke all on function public.strip_parent_birthday_metadata() from public, anon, authenticated, service_role;
revoke all on function public.verify_parent_access(text) from public, anon, authenticated, service_role;
grant execute on function public.verify_parent_access(text) to authenticated;
