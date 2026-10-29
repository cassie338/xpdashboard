-- Additive weekly-plan migration. Existing tasks and XP events deliberately remain
-- unassigned because their timestamps do not establish an assignment week.

create table public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  status text not null default 'published' check (status in ('published', 'completed')),
  sick_days text[] not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, week_start),
  check (extract(isodow from week_start) = 1),
  check (sick_days <@ array['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']::text[]),
  check ((status = 'completed') = (completed_at is not null))
);

alter table public.tasks
  add column weekly_plan_id uuid references public.weekly_plans(id),
  add column copied_from_task_id uuid references public.tasks(id),
  add column removed_at timestamptz;

alter table public.xp_events
  add column weekly_plan_id uuid references public.weekly_plans(id);

create index weekly_plans_user_week_idx on public.weekly_plans(user_id, week_start desc);
create unique index weekly_plans_one_published_per_user_idx
  on public.weekly_plans(user_id)
  where status = 'published';
create index tasks_weekly_plan_idx on public.tasks(weekly_plan_id, day, created_at);
create unique index tasks_plan_copy_unique_idx
  on public.tasks(weekly_plan_id, copied_from_task_id)
  where weekly_plan_id is not null and copied_from_task_id is not null;
create index xp_events_weekly_plan_idx on public.xp_events(weekly_plan_id, earned_at);

alter table public.weekly_plans enable row level security;

-- The dashboard always requires an authenticated family account. Supabase's
-- auto-exposure grants are broader than this application needs.
revoke all on public.dashboard_settings from anon;
revoke all on public.tasks from anon;
revoke all on public.xp_events from anon;

create policy weekly_plans_select_own on public.weekly_plans
for select to authenticated
using (user_id = auth.uid());

revoke all on public.weekly_plans from anon, authenticated;
grant select on public.weekly_plans to authenticated;
alter publication supabase_realtime add table public.weekly_plans;

create function public.protect_weekly_plan_history()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.status = 'completed' then
    raise exception 'Completed weekly plans cannot be changed';
  end if;

  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.user_id <> old.user_id or new.week_start <> old.week_start
      or new.created_at <> old.created_at then
      raise exception 'Weekly plan identity cannot be changed';
    end if;
    return new;
  end if;

  return old;
end;
$$;

create trigger protect_weekly_plan_history
before update or delete on public.weekly_plans
for each row execute function public.protect_weekly_plan_history();

create function public.protect_task_history()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  old_plan_status text;
  new_plan_status text;
  new_plan_user_id uuid;
  copied_from_user_id uuid;
begin
  if tg_op <> 'INSERT' and old.weekly_plan_id is not null then
    select status into old_plan_status from public.weekly_plans where id = old.weekly_plan_id for share;
    if old_plan_status = 'completed' then
      raise exception 'Tasks in completed weekly plans cannot be changed';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.weekly_plan_id is not null then
    select status, user_id into new_plan_status, new_plan_user_id
    from public.weekly_plans where id = new.weekly_plan_id
    for share;

    if not found or new_plan_user_id <> new.user_id then
      raise exception 'Task and weekly plan must belong to the same user';
    end if;
    if new_plan_status = 'completed' then
      raise exception 'Tasks cannot be added to completed weekly plans';
    end if;
  end if;

  if new.copied_from_task_id is not null then
    select user_id into copied_from_user_id
    from public.tasks
    where id = new.copied_from_task_id;
    if not found or copied_from_user_id <> new.user_id then
      raise exception 'Copied task and source task must belong to the same user';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.id <> old.id
    or new.user_id <> old.user_id
    or new.weekly_plan_id is distinct from old.weekly_plan_id
    or new.copied_from_task_id is distinct from old.copied_from_task_id
    or new.created_at <> old.created_at
  ) then
    raise exception 'Task assignment identity cannot be changed';
  end if;

  return new;
end;
$$;

create trigger protect_task_history
before insert or update or delete on public.tasks
for each row execute function public.protect_task_history();

create function public.protect_xp_ledger()
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
  if not found or task_record.user_id <> new.user_id then
    raise exception 'XP event and task must belong to the same user';
  end if;
  if new.weekly_plan_id is distinct from task_record.weekly_plan_id then
    raise exception 'XP event must use the task weekly plan';
  end if;

  if new.weekly_plan_id is not null then
    select status into plan_status from public.weekly_plans where id = new.weekly_plan_id for share;
    if plan_status = 'completed' then
      raise exception 'XP cannot be changed for a completed weekly plan';
    end if;
  end if;

  return new;
end;
$$;

create trigger protect_xp_ledger
before insert or update or delete on public.xp_events
for each row execute function public.protect_xp_ledger();

-- This remains signature-compatible with the live application during rollout.
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
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  select * into task_record
  from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null;
  if not found then raise exception 'Task not found'; end if;

  if task_record.weekly_plan_id is not null then
    select status into plan_status
    from public.weekly_plans
    where id = task_record.weekly_plan_id and user_id = auth.uid()
    for update;
    if plan_status = 'completed' then
      raise exception 'XP cannot be changed for a completed weekly plan';
    end if;
  end if;

  select * into task_record
  from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null
  for update;
  if not found then raise exception 'Task not found'; end if;

  select coalesce(sum(amount), 0)::integer into current_balance
  from public.xp_events
  where task_id = task_record.id and user_id = auth.uid();

  if p_complete and current_balance <= 0 then
    insert into public.xp_events (user_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.id, task_record.weekly_plan_id, task_record.xp, 'task_completed');
  elsif not p_complete and current_balance > 0 then
    insert into public.xp_events (user_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.id, task_record.weekly_plan_id, -current_balance, 'task_unchecked');
  end if;
end;
$$;

-- The old client can still reset its visible week, but this can never touch a
-- completed weekly plan. The contract migration will remove this function.
create or replace function public.reset_task_completions()
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  current_balance integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  for task_record in
    select t.*
    from public.tasks t
    left join public.weekly_plans p on p.id = t.weekly_plan_id
    where t.user_id = auth.uid() and t.removed_at is null and (p.id is null or p.status = 'published')
    order by t.id
    for update of t
  loop
    select coalesce(sum(amount), 0)::integer into current_balance
    from public.xp_events
    where task_id = task_record.id and user_id = auth.uid();

    if current_balance > 0 then
      insert into public.xp_events (user_id, task_id, weekly_plan_id, amount, reason)
      values (auth.uid(), task_record.id, task_record.weekly_plan_id, -current_balance, 'week_reset');
    end if;
  end loop;
end;
$$;

create function public.start_next_week(
  p_source_plan_id uuid,
  p_task_ids uuid[],
  p_week_start date
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  source_plan public.weekly_plans%rowtype;
  destination_plan public.weekly_plans%rowtype;
  destination_id uuid;
  destination_created boolean;
  selected_ids uuid[];
  copied_ids uuid[];
  invalid_task_count integer;
  other_plan_count integer;
  copied_task_count integer;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'Week start must be a Monday';
  end if;

  select coalesce(array_agg(id order by id), '{}'::uuid[]) into selected_ids
  from (select distinct unnest(coalesce(p_task_ids, '{}'::uuid[])) as id) selected;
  if cardinality(selected_ids) = 0 then raise exception 'Select at least one task'; end if;

  -- Serialize rollovers for one account, including concurrent first-plan calls.
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  if p_source_plan_id is null then
    select count(*) into other_plan_count
    from public.weekly_plans
    where user_id = current_user_id and week_start <> p_week_start;
    if other_plan_count > 0 then
      raise exception 'A source weekly plan is required';
    end if;

    select count(*) into invalid_task_count
    from unnest(selected_ids) selected(id)
    left join public.tasks t on t.id = selected.id
    where t.id is null or t.user_id <> current_user_id or t.weekly_plan_id is not null or t.removed_at is not null;
  else
    select * into source_plan
    from public.weekly_plans
    where id = p_source_plan_id and user_id = current_user_id
    for update;
    if not found then raise exception 'Source weekly plan not found'; end if;
    if p_week_start <> source_plan.week_start + 7 then
      raise exception 'The next weekly plan must begin seven days after the source plan';
    end if;
    if source_plan.status = 'published' and exists (
      select 1 from public.weekly_plans
      where user_id = current_user_id and week_start > source_plan.week_start
    ) then
      raise exception 'Only the latest published weekly plan can roll over';
    end if;

    select count(*) into invalid_task_count
    from unnest(selected_ids) selected(id)
    left join public.tasks t on t.id = selected.id
    where t.id is null or t.user_id <> current_user_id
      or t.weekly_plan_id is distinct from source_plan.id or t.removed_at is not null;
  end if;

  if invalid_task_count > 0 then
    raise exception 'Every selected task must belong to the authenticated user and source';
  end if;

  perform 1
  from public.tasks
  where id = any(selected_ids)
  order by id
  for update;

  if p_source_plan_id is not null and source_plan.status = 'published' then
    update public.weekly_plans
    set status = 'completed', completed_at = now()
    where id = source_plan.id;
  end if;

  insert into public.weekly_plans (user_id, week_start, sick_days)
  values (
    current_user_id,
    p_week_start,
    case when p_source_plan_id is null
      then coalesce((select sick_days from public.dashboard_settings where user_id = current_user_id), '{}'::text[])
      else source_plan.sick_days
    end
  )
  on conflict (user_id, week_start) do nothing
  returning id into destination_id;
  destination_created := destination_id is not null;

  if destination_created and p_source_plan_id is not null and source_plan.status = 'completed' then
    raise exception 'A completed source can only retry its existing rollover';
  end if;

  if not destination_created then
    select * into destination_plan
    from public.weekly_plans
    where user_id = current_user_id and week_start = p_week_start
    for update;
    destination_id := destination_plan.id;
    if destination_plan.status = 'completed' then
      raise exception 'Destination weekly plan is already completed';
    end if;

    select coalesce(array_agg(copied_from_task_id order by copied_from_task_id), '{}'::uuid[])
    into copied_ids
    from public.tasks
    where weekly_plan_id = destination_id and copied_from_task_id is not null;

    if copied_ids <> selected_ids then
      raise exception 'This weekly plan already exists with a different task selection';
    end if;
  else
    insert into public.tasks (
      user_id, weekly_plan_id, copied_from_task_id, name, category, day, xp
    )
    select current_user_id, destination_id, source.id, source.name, source.category, source.day, source.xp
    from public.tasks source
    where source.id = any(selected_ids) and source.removed_at is null
    order by source.created_at, source.id;
    get diagnostics copied_task_count = row_count;
    if copied_task_count <> cardinality(selected_ids) then
      raise exception 'Not every selected task was copied';
    end if;
  end if;

  return destination_id;
end;
$$;

create function public.create_weekly_task(
  p_weekly_plan_id uuid,
  p_name text,
  p_category text,
  p_day text,
  p_xp integer
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  plan_record public.weekly_plans%rowtype;
  new_task_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select * into plan_record from public.weekly_plans
  where id = p_weekly_plan_id and user_id = auth.uid()
  for update;
  if not found then raise exception 'Weekly plan not found'; end if;
  if plan_record.status = 'completed' then raise exception 'Completed weekly plans cannot be changed'; end if;

  insert into public.tasks (user_id, weekly_plan_id, name, category, day, xp)
  values (auth.uid(), plan_record.id, p_name, p_category, p_day, p_xp)
  returning id into new_task_id;
  return new_task_id;
end;
$$;

create function public.delete_weekly_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  plan_status text;
  current_balance integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  select * into task_record from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null
  for update;
  if not found then raise exception 'Task not found'; end if;
  if task_record.weekly_plan_id is null then raise exception 'Legacy tasks cannot be changed'; end if;

  select status into plan_status from public.weekly_plans
  where id = task_record.weekly_plan_id and user_id = auth.uid()
  for update;
  if plan_status = 'completed' then raise exception 'Completed weekly plans cannot be changed'; end if;
  select coalesce(sum(amount), 0)::integer into current_balance
  from public.xp_events
  where task_id = task_record.id and user_id = auth.uid();
  if current_balance > 0 then
    raise exception 'Undo earned XP before removing this task';
  end if;

  update public.tasks set removed_at = now() where id = task_record.id;
end;
$$;

create function public.set_weekly_plan_sick_days(p_weekly_plan_id uuid, p_sick_days text[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  update public.weekly_plans
  set sick_days = p_sick_days
  where id = p_weekly_plan_id and user_id = auth.uid() and status = 'published';
  if not found then raise exception 'Published weekly plan not found'; end if;
end;
$$;

-- The local-to-Supabase legacy import is all-or-nothing. It intentionally
-- accepts only unassigned tasks and sets initialized only after every insert.
create function public.import_legacy_dashboard(
  p_learner_name text,
  p_sick_days text[],
  p_tasks jsonb,
  p_completed_task_ids text[]
)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  settings_initialized boolean;
  task_json jsonb;
  new_task_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  insert into public.dashboard_settings (user_id) values (current_user_id) on conflict do nothing;
  select initialized into settings_initialized
  from public.dashboard_settings
  where user_id = current_user_id
  for update;
  if settings_initialized then return; end if;

  for task_json in select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb))
  loop
    insert into public.tasks (user_id, name, category, day, xp)
    values (
      current_user_id,
      task_json->>'name',
      task_json->>'category',
      task_json->>'day',
      (task_json->>'xp')::integer
    )
    returning id into new_task_id;

    if task_json->>'id' = any(coalesce(p_completed_task_ids, '{}'::text[])) then
      insert into public.xp_events (user_id, task_id, amount, reason)
      values (current_user_id, new_task_id, (task_json->>'xp')::integer, 'task_completed');
    end if;
  end loop;

  update public.dashboard_settings
  set learner_name = p_learner_name,
      sick_days = p_sick_days,
      initialized = true,
      updated_at = now()
  where user_id = current_user_id;
end;
$$;

revoke all on function public.protect_weekly_plan_history() from public, anon, authenticated, service_role;
revoke all on function public.protect_task_history() from public, anon, authenticated, service_role;
revoke all on function public.protect_xp_ledger() from public, anon, authenticated, service_role;
revoke all on function public.record_task_completion(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.reset_task_completions() from public, anon, authenticated, service_role;
grant execute on function public.record_task_completion(uuid, boolean) to authenticated;
grant execute on function public.reset_task_completions() to authenticated;

revoke all on function public.start_next_week(uuid, uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.create_weekly_task(uuid, text, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.delete_weekly_task(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_weekly_plan_sick_days(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.import_legacy_dashboard(text, text[], jsonb, text[]) from public, anon, authenticated, service_role;
grant execute on function public.start_next_week(uuid, uuid[], date) to authenticated;
grant execute on function public.create_weekly_task(uuid, text, text, text, integer) to authenticated;
grant execute on function public.delete_weekly_task(uuid) to authenticated;
grant execute on function public.set_weekly_plan_sick_days(uuid, text[]) to authenticated;
grant execute on function public.import_legacy_dashboard(text, text[], jsonb, text[]) to authenticated;
