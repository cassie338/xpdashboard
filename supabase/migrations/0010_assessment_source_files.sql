-- Assessment files are raw source records. Uploading one does not create a
-- progress result, interpretation, standards mapping, mastery claim, or XP.

create table public.parent_access_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index parent_access_sessions_user_expiry_idx
  on public.parent_access_sessions(user_id, expires_at desc);

alter table public.parent_access_sessions enable row level security;
revoke all on public.parent_access_sessions from public, anon, authenticated;

create function public.open_parent_access_session(p_birthday text)
returns text
language plpgsql volatile security definer set search_path = public, extensions, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  stored_hash text;
  attempt_record public.parent_access_attempts%rowtype;
  attempt_count integer;
  raw_token text;
begin
  if current_user_id is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  select access_code_hash into stored_hash
  from public.parent_access_credentials
  where user_id = current_user_id;
  if not found then return null; end if;

  select * into attempt_record
  from public.parent_access_attempts
  where user_id = current_user_id
  for update;

  if found and attempt_record.locked_until > now() then return null; end if;

  if stored_hash = extensions.crypt(trim(coalesce(p_birthday, '')), stored_hash) then
    delete from public.parent_access_attempts where user_id = current_user_id;
    delete from public.parent_access_sessions where user_id = current_user_id;
    raw_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.parent_access_sessions (user_id, token_hash, expires_at)
    values (
      current_user_id,
      encode(extensions.digest(raw_token, 'sha256'), 'hex'),
      now() + interval '30 minutes'
    );
    return raw_token;
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

  return null;
end;
$$;

create function public.validate_parent_access_session(p_token text)
returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.parent_access_sessions session
    where session.user_id = auth.uid()
      and session.expires_at > now()
      and session.token_hash = encode(
        extensions.digest(coalesce(p_token, ''), 'sha256'),
        'hex'
      )
  );
$$;

revoke all on function public.open_parent_access_session(text) from public, anon, authenticated, service_role;
revoke all on function public.validate_parent_access_session(text) from public, anon, authenticated, service_role;
grant execute on function public.open_parent_access_session(text) to authenticated;
grant execute on function public.validate_parent_access_session(text) to authenticated;

create table public.assessment_source_files (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  source_label text not null check (length(trim(source_label)) between 1 and 120),
  assessment_date date,
  original_filename text not null check (length(trim(original_filename)) between 1 and 255),
  storage_path text not null unique,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz not null default now(),
  unique (id, learner_id, user_id),
  unique (learner_id, file_sha256),
  constraint assessment_source_files_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id)
);

create index assessment_source_files_learner_time_idx
  on public.assessment_source_files(user_id, learner_id, uploaded_at desc);

create function public.protect_assessment_source_file()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  raise exception 'Assessment source files are append-only';
end;
$$;

create trigger assessment_source_files_are_append_only
before update or delete on public.assessment_source_files
for each row execute function public.protect_assessment_source_file();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assessment-sources',
  'assessment-sources',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create function public.register_assessment_source(
  p_parent_token text,
  p_id uuid,
  p_learner_id uuid,
  p_source_label text,
  p_assessment_date date,
  p_original_filename text,
  p_storage_path text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text
)
returns uuid
language plpgsql volatile security definer set search_path = public, storage, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  object_metadata jsonb;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then
    raise exception 'Parent access required';
  end if;
  if not exists (
    select 1 from public.learners
    where id = p_learner_id and user_id = current_user_id
  ) then raise exception 'Learner not found'; end if;
  if p_id is null then raise exception 'Source identifier is required'; end if;
  if p_storage_path not like (
    current_user_id::text || '/' || p_learner_id::text || '/' || p_id::text || '/%'
  ) then raise exception 'Invalid assessment source path'; end if;
  if length(trim(coalesce(p_source_label, ''))) not between 1 and 120 then
    raise exception 'Source label is required';
  end if;
  if p_assessment_date > current_date then raise exception 'Assessment date cannot be in the future'; end if;
  if length(trim(coalesce(p_original_filename, ''))) not between 1 and 255 then
    raise exception 'Original filename is required';
  end if;
  if p_content_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'Unsupported assessment source type';
  end if;
  if p_byte_size not between 1 and 10485760 then raise exception 'Invalid assessment source size'; end if;
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid assessment source checksum'; end if;

  select metadata into object_metadata
  from storage.objects
  where bucket_id = 'assessment-sources' and name = p_storage_path;
  if not found then raise exception 'Stored assessment source not found'; end if;
  if coalesce(object_metadata ->> 'mimetype', '') <> p_content_type
    or coalesce((object_metadata ->> 'size')::bigint, 0) <> p_byte_size then
    raise exception 'Stored assessment source metadata does not match';
  end if;

  insert into public.assessment_source_files (
    id,
    user_id,
    learner_id,
    source_label,
    assessment_date,
    original_filename,
    storage_path,
    content_type,
    byte_size,
    file_sha256
  ) values (
    p_id,
    current_user_id,
    p_learner_id,
    trim(p_source_label),
    p_assessment_date,
    trim(p_original_filename),
    p_storage_path,
    p_content_type,
    p_byte_size,
    p_file_sha256
  );
  return p_id;
end;
$$;

alter table public.assessment_source_files enable row level security;
revoke all on public.assessment_source_files from anon, authenticated;
revoke all on function public.register_assessment_source(text, uuid, uuid, text, date, text, text, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_assessment_source(text, uuid, uuid, text, date, text, text, text, bigint, text)
  to authenticated;
revoke all on function public.protect_assessment_source_file() from public, anon, authenticated, service_role;

create function public.list_assessment_sources(p_parent_token text, p_learner_id uuid)
returns table (
  id uuid,
  learner_id uuid,
  source_label text,
  assessment_date date,
  original_filename text,
  content_type text,
  byte_size bigint,
  uploaded_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then
    raise exception 'Parent access required';
  end if;
  if not exists (
    select 1 from public.learners learner
    where learner.id = p_learner_id and learner.user_id = auth.uid()
  ) then raise exception 'Learner not found'; end if;

  return query
  select
    source.id,
    source.learner_id,
    source.source_label,
    source.assessment_date,
    source.original_filename,
    source.content_type,
    source.byte_size,
    source.uploaded_at
  from public.assessment_source_files source
  where source.user_id = auth.uid() and source.learner_id = p_learner_id
  order by source.uploaded_at desc;
end;
$$;

create function public.get_assessment_source_download(p_parent_token text, p_source_id uuid)
returns table (storage_path text, original_filename text, content_type text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then
    raise exception 'Parent access required';
  end if;

  return query
  select source.storage_path, source.original_filename, source.content_type
  from public.assessment_source_files source
  where source.id = p_source_id and source.user_id = auth.uid();
end;
$$;

create function public.find_assessment_source_by_checksum(
  p_parent_token text,
  p_learner_id uuid,
  p_file_sha256 text
)
returns table (id uuid)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then
    raise exception 'Parent access required';
  end if;
  if not exists (
    select 1 from public.learners learner
    where learner.id = p_learner_id and learner.user_id = auth.uid()
  ) then raise exception 'Learner not found'; end if;

  return query
  select source.id
  from public.assessment_source_files source
  where source.user_id = auth.uid()
    and source.learner_id = p_learner_id
    and source.file_sha256 = p_file_sha256;
end;
$$;

revoke all on function public.list_assessment_sources(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_assessment_source_download(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.find_assessment_source_by_checksum(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.list_assessment_sources(text, uuid) to authenticated;
grant execute on function public.get_assessment_source_download(text, uuid) to authenticated;
grant execute on function public.find_assessment_source_by_checksum(text, uuid, text) to authenticated;
