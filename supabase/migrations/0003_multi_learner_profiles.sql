-- One authenticated family account may own multiple learner profiles. Existing
-- account data is attached to one default learner without changing history.

create table public.learners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index learners_one_default_per_user_idx
  on public.learners(user_id) where is_default;
create index learners_user_created_idx on public.learners(user_id, created_at);

insert into public.learners (user_id, display_name, is_default)
select u.id, coalesce(nullif(trim(s.learner_name), ''), 'My Learner'), true
from auth.users u
left join public.dashboard_settings s on s.user_id = u.id;

alter table public.dashboard_settings add column learner_id uuid;
alter table public.weekly_plans add column learner_id uuid;
alter table public.tasks add column learner_id uuid;
alter table public.xp_events add column learner_id uuid;

alter table public.weekly_plans disable trigger protect_weekly_plan_history;
alter table public.tasks disable trigger protect_task_history;
alter table public.xp_events disable trigger protect_xp_ledger;

update public.dashboard_settings s set learner_id = l.id
from public.learners l where l.user_id = s.user_id and l.is_default;
update public.weekly_plans p set learner_id = l.id
from public.learners l where l.user_id = p.user_id and l.is_default;
update public.tasks t set learner_id = l.id
from public.learners l where l.user_id = t.user_id and l.is_default;
update public.xp_events e set learner_id = l.id
from public.learners l where l.user_id = e.user_id and l.is_default;

alter table public.weekly_plans enable trigger protect_weekly_plan_history;
alter table public.tasks enable trigger protect_task_history;
alter table public.xp_events enable trigger protect_xp_ledger;

alter table public.dashboard_settings alter column learner_id set not null;
alter table public.weekly_plans alter column learner_id set not null;
alter table public.tasks alter column learner_id set not null;
alter table public.xp_events alter column learner_id set not null;

alter table public.dashboard_settings drop constraint dashboard_settings_pkey;
alter table public.dashboard_settings add primary key (learner_id);
alter table public.dashboard_settings add constraint dashboard_settings_learner_owner_fk
  foreign key (learner_id, user_id) references public.learners(id, user_id);

alter table public.weekly_plans drop constraint weekly_plans_user_id_week_start_key;
alter table public.weekly_plans add constraint weekly_plans_learner_week_key
  unique (learner_id, week_start);
alter table public.weekly_plans add constraint weekly_plans_id_learner_owner_key
  unique (id, learner_id, user_id);
alter table public.weekly_plans add constraint weekly_plans_learner_owner_fk
  foreign key (learner_id, user_id) references public.learners(id, user_id);

alter table public.tasks add constraint tasks_id_learner_owner_key
  unique (id, learner_id, user_id);
alter table public.tasks add constraint tasks_learner_owner_fk
  foreign key (learner_id, user_id) references public.learners(id, user_id);
alter table public.tasks add constraint tasks_plan_learner_owner_fk
  foreign key (weekly_plan_id, learner_id, user_id)
  references public.weekly_plans(id, learner_id, user_id);
alter table public.tasks add constraint tasks_copy_learner_owner_fk
  foreign key (copied_from_task_id, learner_id, user_id)
  references public.tasks(id, learner_id, user_id);

alter table public.xp_events add constraint xp_events_learner_owner_fk
  foreign key (learner_id, user_id) references public.learners(id, user_id);
alter table public.xp_events add constraint xp_events_task_learner_owner_fk
  foreign key (task_id, learner_id, user_id)
  references public.tasks(id, learner_id, user_id);
alter table public.xp_events add constraint xp_events_plan_learner_owner_fk
  foreign key (weekly_plan_id, learner_id, user_id)
  references public.weekly_plans(id, learner_id, user_id);

drop index public.weekly_plans_one_published_per_user_idx;
create unique index weekly_plans_one_published_per_learner_idx
  on public.weekly_plans(learner_id) where status = 'published';
drop index public.weekly_plans_user_week_idx;
create index weekly_plans_learner_week_idx
  on public.weekly_plans(user_id, learner_id, week_start desc);
drop index public.tasks_user_day_idx;
create index tasks_learner_day_idx
  on public.tasks(user_id, learner_id, day, created_at);
drop index public.xp_events_user_earned_idx;
create index xp_events_learner_earned_idx
  on public.xp_events(user_id, learner_id, earned_at);

alter table public.learners enable row level security;
create policy learners_select_own on public.learners for select to authenticated
using (user_id = auth.uid());
revoke all on public.learners from anon, authenticated;
grant select on public.learners to authenticated;
alter publication supabase_realtime add table public.learners;

create or replace function public.protect_weekly_plan_history()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.status = 'completed' then
    raise exception 'Completed weekly plans cannot be changed';
  end if;
  if tg_op = 'UPDATE' and (
    new.id <> old.id or new.user_id <> old.user_id
    or new.learner_id <> old.learner_id or new.week_start <> old.week_start
    or new.created_at <> old.created_at
  ) then
    raise exception 'Weekly plan identity cannot be changed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.protect_task_history()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  old_plan_status text;
  new_plan_status text;
  related_user_id uuid;
  related_learner_id uuid;
begin
  if tg_op <> 'INSERT' and old.weekly_plan_id is not null then
    select status into old_plan_status from public.weekly_plans where id = old.weekly_plan_id for share;
    if old_plan_status = 'completed' then raise exception 'Tasks in completed weekly plans cannot be changed'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  -- Keep the pre-profile client compatible during the migration/deploy window.
  if new.learner_id is null then
    select id into new.learner_id from public.learners
    where user_id = new.user_id and is_default;
  end if;

  if new.weekly_plan_id is not null then
    select status, user_id, learner_id into new_plan_status, related_user_id, related_learner_id
    from public.weekly_plans where id = new.weekly_plan_id for share;
    if not found or related_user_id <> new.user_id or related_learner_id <> new.learner_id then
      raise exception 'Task and weekly plan must belong to the same learner';
    end if;
    if new_plan_status = 'completed' then raise exception 'Tasks cannot be added to completed weekly plans'; end if;
  end if;

  if new.copied_from_task_id is not null then
    select user_id, learner_id into related_user_id, related_learner_id
    from public.tasks where id = new.copied_from_task_id;
    if not found or related_user_id <> new.user_id or related_learner_id <> new.learner_id then
      raise exception 'Copied task and source task must belong to the same learner';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.id <> old.id or new.user_id <> old.user_id or new.learner_id <> old.learner_id
    or new.weekly_plan_id is distinct from old.weekly_plan_id
    or new.copied_from_task_id is distinct from old.copied_from_task_id
    or new.created_at <> old.created_at
  ) then
    raise exception 'Task assignment identity cannot be changed';
  end if;
  return new;
end;
$$;

create or replace function public.protect_xp_ledger()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  plan_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'XP events are append-only; use a compensating event';
  end if;
  select * into task_record from public.tasks where id = new.task_id;
  if new.learner_id is null and found then new.learner_id := task_record.learner_id; end if;
  if not found or task_record.user_id <> new.user_id or task_record.learner_id <> new.learner_id then
    raise exception 'XP event and task must belong to the same learner';
  end if;
  if new.weekly_plan_id is distinct from task_record.weekly_plan_id then
    raise exception 'XP event must use the task weekly plan';
  end if;
  if new.weekly_plan_id is not null then
    select status into plan_status from public.weekly_plans
    where id = new.weekly_plan_id and learner_id = new.learner_id for share;
    if plan_status = 'completed' then raise exception 'XP cannot be changed for a completed weekly plan'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_dashboard_for_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  new_learner_id uuid;
begin
  insert into public.learners (user_id, display_name, is_default)
  values (new.id, 'My Learner', true)
  returning id into new_learner_id;
  insert into public.dashboard_settings (user_id, learner_id)
  values (new.id, new_learner_id);
  return new;
end;
$$;

drop trigger if exists create_dashboard_after_signup on auth.users;
create trigger create_dashboard_after_signup
after insert on auth.users
for each row execute function public.create_dashboard_for_user();

create function public.create_family_learner(p_display_name text, p_week_start date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  new_learner_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_display_name, ''))) not between 1 and 80 then raise exception 'Learner name is required'; end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then raise exception 'Week start must be a Monday'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));
  insert into public.learners (user_id, display_name)
  values (current_user_id, trim(p_display_name)) returning id into new_learner_id;
  insert into public.dashboard_settings (user_id, learner_id, learner_name, initialized)
  values (current_user_id, new_learner_id, trim(p_display_name), true);
  insert into public.weekly_plans (user_id, learner_id, week_start)
  values (current_user_id, new_learner_id, p_week_start);
  return new_learner_id;
end;
$$;

create function public.set_learner_name(p_learner_id uuid, p_display_name text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_display_name, ''))) not between 1 and 80 then raise exception 'Learner name is required'; end if;
  update public.learners set display_name = trim(p_display_name), updated_at = now()
  where id = p_learner_id and user_id = auth.uid();
  if not found then raise exception 'Learner not found'; end if;
  update public.dashboard_settings set learner_name = trim(p_display_name), updated_at = now()
  where learner_id = p_learner_id and user_id = auth.uid();
end;
$$;

create or replace function public.record_task_completion(p_task_id uuid, p_complete boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  current_balance integer;
  plan_status text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into task_record from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null;
  if not found then raise exception 'Task not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || task_record.learner_id::text, 0));
  if task_record.weekly_plan_id is not null then
    select status into plan_status from public.weekly_plans
    where id = task_record.weekly_plan_id and learner_id = task_record.learner_id for update;
    if plan_status = 'completed' then raise exception 'XP cannot be changed for a completed weekly plan'; end if;
  end if;
  select * into task_record from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null for update;
  if not found then raise exception 'Task not found'; end if;
  select coalesce(sum(amount), 0)::integer into current_balance from public.xp_events
  where task_id = task_record.id and user_id = auth.uid() and learner_id = task_record.learner_id;
  if p_complete and current_balance <= 0 then
    insert into public.xp_events (user_id, learner_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id, task_record.xp, 'task_completed');
  elsif not p_complete and current_balance > 0 then
    insert into public.xp_events (user_id, learner_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id, -current_balance, 'task_unchecked');
  end if;
end;
$$;

create or replace function public.reset_task_completions()
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  default_learner_id uuid;
  task_record public.tasks%rowtype;
  current_balance integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select id into default_learner_id from public.learners
  where user_id = auth.uid() and is_default;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || default_learner_id::text, 0));
  for task_record in
    select t.* from public.tasks t
    left join public.weekly_plans p on p.id = t.weekly_plan_id
    where t.user_id = auth.uid() and t.learner_id = default_learner_id
      and t.removed_at is null and (p.id is null or p.status = 'published')
    order by t.id for update of t
  loop
    select coalesce(sum(amount), 0)::integer into current_balance from public.xp_events
    where task_id = task_record.id and learner_id = default_learner_id;
    if current_balance > 0 then
      insert into public.xp_events (user_id, learner_id, task_id, weekly_plan_id, amount, reason)
      values (auth.uid(), default_learner_id, task_record.id, task_record.weekly_plan_id, -current_balance, 'week_reset');
    end if;
  end loop;
end;
$$;

create or replace function public.start_next_week(
  p_source_plan_id uuid,
  p_task_ids uuid[],
  p_week_start date
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_learner_id uuid;
  source_plan public.weekly_plans%rowtype;
  destination_plan public.weekly_plans%rowtype;
  destination_id uuid;
  selected_ids uuid[];
  copied_ids uuid[];
  invalid_task_count integer;
  other_plan_count integer;
  copied_task_count integer;
  destination_created boolean := false;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then raise exception 'Week start must be a Monday'; end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into selected_ids
  from (select distinct unnest(coalesce(p_task_ids, '{}'::uuid[])) as id) selected;
  if cardinality(selected_ids) = 0 then raise exception 'Select at least one task'; end if;

  if p_source_plan_id is null then
    select learner_id into current_learner_id from public.tasks
    where id = selected_ids[1] and user_id = current_user_id;
    if not found then raise exception 'Every selected task must belong to the authenticated user and source'; end if;
  else
    select * into source_plan from public.weekly_plans
    where id = p_source_plan_id and user_id = current_user_id;
    if not found then raise exception 'Source weekly plan not found'; end if;
    current_learner_id := source_plan.learner_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text || ':' || current_learner_id::text, 0));

  if p_source_plan_id is null then
    select count(*) into other_plan_count from public.weekly_plans
    where user_id = current_user_id and learner_id = current_learner_id and week_start <> p_week_start;
    if other_plan_count > 0 then raise exception 'A source weekly plan is required'; end if;
    select count(*) into invalid_task_count from unnest(selected_ids) selected(id)
    left join public.tasks t on t.id = selected.id
    where t.id is null or t.user_id <> current_user_id or t.learner_id <> current_learner_id
      or t.weekly_plan_id is not null or t.removed_at is not null;
  else
    select * into source_plan from public.weekly_plans
    where id = p_source_plan_id and user_id = current_user_id and learner_id = current_learner_id for update;
    if p_week_start <> source_plan.week_start + 7 then raise exception 'The next weekly plan must begin seven days after the source plan'; end if;
    if source_plan.status = 'published' and exists (
      select 1 from public.weekly_plans where user_id = current_user_id
      and learner_id = current_learner_id and week_start > source_plan.week_start
    ) then raise exception 'Only the latest published weekly plan can roll over'; end if;
    select count(*) into invalid_task_count from unnest(selected_ids) selected(id)
    left join public.tasks t on t.id = selected.id
    where t.id is null or t.user_id <> current_user_id or t.learner_id <> current_learner_id
      or t.weekly_plan_id is distinct from source_plan.id or t.removed_at is not null;
  end if;
  if invalid_task_count > 0 then raise exception 'Every selected task must belong to the authenticated user and source'; end if;

  perform 1 from public.tasks where id = any(selected_ids) order by id for update;
  if p_source_plan_id is not null and source_plan.status = 'published' then
    update public.weekly_plans set status = 'completed', completed_at = now() where id = source_plan.id;
  end if;

  insert into public.weekly_plans (user_id, learner_id, week_start, sick_days)
  values (current_user_id, current_learner_id, p_week_start,
    case when p_source_plan_id is null
      then coalesce((select sick_days from public.dashboard_settings where learner_id = current_learner_id), '{}'::text[])
      else source_plan.sick_days end)
  on conflict (learner_id, week_start) do nothing returning id into destination_id;
  destination_created := destination_id is not null;

  if destination_created and p_source_plan_id is not null and source_plan.status = 'completed' then
    raise exception 'A completed source can only retry its existing rollover';
  end if;
  if not destination_created then
    select * into destination_plan from public.weekly_plans
    where learner_id = current_learner_id and week_start = p_week_start for update;
    destination_id := destination_plan.id;
    if destination_plan.status = 'completed' then raise exception 'Destination weekly plan is already completed'; end if;
    select coalesce(array_agg(copied_from_task_id order by copied_from_task_id), '{}'::uuid[])
    into copied_ids from public.tasks
    where weekly_plan_id = destination_id and learner_id = current_learner_id and copied_from_task_id is not null;
    if copied_ids <> selected_ids then raise exception 'This weekly plan already exists with a different task selection'; end if;
  else
    insert into public.tasks (user_id, learner_id, weekly_plan_id, copied_from_task_id, name, category, day, xp)
    select current_user_id, current_learner_id, destination_id, source.id, source.name, source.category, source.day, source.xp
    from public.tasks source
    where source.id = any(selected_ids) and source.learner_id = current_learner_id and source.removed_at is null
    order by source.created_at, source.id;
    get diagnostics copied_task_count = row_count;
    if copied_task_count <> cardinality(selected_ids) then raise exception 'Not every selected task was copied'; end if;
  end if;
  return destination_id;
end;
$$;

create or replace function public.create_weekly_task(
  p_weekly_plan_id uuid, p_name text, p_category text, p_day text, p_xp integer
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  plan_record public.weekly_plans%rowtype;
  new_task_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into plan_record from public.weekly_plans
  where id = p_weekly_plan_id and user_id = auth.uid();
  if not found then raise exception 'Weekly plan not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || plan_record.learner_id::text, 0));
  select * into plan_record from public.weekly_plans where id = p_weekly_plan_id for update;
  if plan_record.status = 'completed' then raise exception 'Completed weekly plans cannot be changed'; end if;
  insert into public.tasks (user_id, learner_id, weekly_plan_id, name, category, day, xp)
  values (auth.uid(), plan_record.learner_id, plan_record.id, p_name, p_category, p_day, p_xp)
  returning id into new_task_id;
  return new_task_id;
end;
$$;

create or replace function public.import_legacy_dashboard(
  p_learner_name text, p_sick_days text[], p_tasks jsonb, p_completed_task_ids text[]
)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_learner_id uuid;
  settings_initialized boolean;
  task_json jsonb;
  new_task_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select id into current_learner_id from public.learners
  where user_id = current_user_id and is_default;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text || ':' || current_learner_id::text, 0));
  select initialized into settings_initialized from public.dashboard_settings
  where learner_id = current_learner_id and user_id = current_user_id for update;
  if settings_initialized then return; end if;
  for task_json in select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) loop
    insert into public.tasks (user_id, learner_id, name, category, day, xp)
    values (current_user_id, current_learner_id, task_json->>'name', task_json->>'category', task_json->>'day', (task_json->>'xp')::integer)
    returning id into new_task_id;
    if task_json->>'id' = any(coalesce(p_completed_task_ids, '{}'::text[])) then
      insert into public.xp_events (user_id, learner_id, task_id, amount, reason)
      values (current_user_id, current_learner_id, new_task_id, (task_json->>'xp')::integer, 'task_completed');
    end if;
  end loop;
  update public.learners set display_name = p_learner_name, updated_at = now() where id = current_learner_id;
  update public.dashboard_settings set learner_name = p_learner_name, sick_days = p_sick_days,
    initialized = true, updated_at = now() where learner_id = current_learner_id;
end;
$$;

revoke all on function public.create_family_learner(text, date) from public, anon, authenticated, service_role;
revoke all on function public.set_learner_name(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.create_family_learner(text, date) to authenticated;
grant execute on function public.set_learner_name(uuid, text) to authenticated;

-- Verify the backfill before allowing the migration transaction to commit.
do $$
begin
  if exists (select 1 from public.dashboard_settings where learner_id is null)
    or exists (select 1 from public.weekly_plans where learner_id is null)
    or exists (select 1 from public.tasks where learner_id is null)
    or exists (select 1 from public.xp_events where learner_id is null) then
    raise exception 'Learner backfill is incomplete';
  end if;
  if exists (
    select 1 from public.xp_events e join public.tasks t on t.id = e.task_id
    where e.user_id <> t.user_id or e.learner_id <> t.learner_id
  ) then raise exception 'XP learner ownership mismatch'; end if;
end;
$$;
