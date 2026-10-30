-- Focused learner workflow: suggested order, support mode, task sessions,
-- help requests, and family-authored daily finish-line rewards.

alter table public.tasks
  add column position integer,
  add column support_mode text not null default 'independent'
    check (support_mode in ('independent', 'with_parent'));

with ranked as (
  select id, row_number() over (
    partition by learner_id, weekly_plan_id, day
    order by created_at, id
  ) - 1 as next_position
  from public.tasks
)
update public.tasks t set position = ranked.next_position
from ranked where ranked.id = t.id;

alter table public.tasks alter column position set not null;
alter table public.tasks alter column position set default 0;
alter table public.tasks add constraint tasks_position_nonnegative check (position >= 0);
create index tasks_plan_day_position_idx on public.tasks(weekly_plan_id, day, position, created_at);

alter table public.weekly_plans
  add column daily_rewards jsonb not null default '{}'::jsonb
  check (jsonb_typeof(daily_rewards) = 'object');

create table public.task_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  learner_id uuid not null,
  task_id uuid not null,
  weekly_plan_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'started' check (status in ('started', 'completed')),
  check ((status = 'started') = (ended_at is null)),
  foreign key (learner_id, user_id) references public.learners(id, user_id),
  foreign key (task_id, learner_id, user_id) references public.tasks(id, learner_id, user_id),
  foreign key (weekly_plan_id, learner_id, user_id) references public.weekly_plans(id, learner_id, user_id)
);
create unique index task_sessions_one_active_task_idx on public.task_sessions(task_id) where ended_at is null;
create index task_sessions_learner_started_idx on public.task_sessions(learner_id, started_at desc);

create table public.help_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  learner_id uuid not null,
  task_id uuid not null,
  weekly_plan_id uuid not null,
  status text not null default 'requested' check (status in ('requested', 'resolved')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_at is not null)),
  foreign key (learner_id, user_id) references public.learners(id, user_id),
  foreign key (task_id, learner_id, user_id) references public.tasks(id, learner_id, user_id),
  foreign key (weekly_plan_id, learner_id, user_id) references public.weekly_plans(id, learner_id, user_id)
);
create unique index help_requests_one_active_task_idx on public.help_requests(task_id) where status = 'requested';
create index help_requests_learner_requested_idx on public.help_requests(learner_id, requested_at desc);

alter table public.task_sessions enable row level security;
alter table public.help_requests enable row level security;
create policy task_sessions_select_own on public.task_sessions for select to authenticated using (user_id = auth.uid());
create policy help_requests_select_own on public.help_requests for select to authenticated using (user_id = auth.uid());
revoke all on public.task_sessions from anon, authenticated;
revoke all on public.help_requests from anon, authenticated;
grant select on public.task_sessions to authenticated;
grant select on public.help_requests to authenticated;
alter publication supabase_realtime add table public.task_sessions;
alter publication supabase_realtime add table public.help_requests;

create function public.copy_task_preferences()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.copied_from_task_id is not null then
    select position, support_mode into new.position, new.support_mode
    from public.tasks where id = new.copied_from_task_id;
  end if;
  return new;
end;
$$;
create trigger copy_task_preferences
before insert on public.tasks
for each row execute function public.copy_task_preferences();

create function public.start_task(p_task_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  session_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select t.* into task_record from public.tasks t
  join public.weekly_plans p on p.id = t.weekly_plan_id
  where t.id = p_task_id and t.user_id = auth.uid() and t.removed_at is null and p.status = 'published';
  if not found then raise exception 'Current task not found'; end if;
  if exists (select 1 from public.xp_events where task_id = p_task_id group by task_id having sum(amount) > 0) then
    raise exception 'Completed tasks cannot be started';
  end if;
  insert into public.task_sessions (user_id, learner_id, task_id, weekly_plan_id)
  values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id)
  on conflict do nothing
  returning id into session_id;
  if session_id is null then
    select id into session_id from public.task_sessions where task_id = p_task_id and ended_at is null;
  end if;
  return session_id;
end;
$$;

create function public.request_task_help(p_task_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  request_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select t.* into task_record from public.tasks t
  join public.weekly_plans p on p.id = t.weekly_plan_id
  where t.id = p_task_id and t.user_id = auth.uid() and t.removed_at is null and p.status = 'published';
  if not found then raise exception 'Current task not found'; end if;
  insert into public.help_requests (user_id, learner_id, task_id, weekly_plan_id)
  values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id)
  on conflict do nothing
  returning id into request_id;
  if request_id is null then
    select id into request_id from public.help_requests where task_id = p_task_id and status = 'requested';
  end if;
  return request_id;
end;
$$;

create function public.resolve_help_request(p_help_request_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.help_requests set status = 'resolved', resolved_at = now()
  where id = p_help_request_id and user_id = auth.uid() and status = 'requested';
  if not found then raise exception 'Active help request not found'; end if;
end;
$$;

create function public.reorder_daily_tasks(p_weekly_plan_id uuid, p_day text, p_task_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  plan_record public.weekly_plans%rowtype;
  expected_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into plan_record from public.weekly_plans
  where id = p_weekly_plan_id and user_id = auth.uid() for update;
  if not found or plan_record.status <> 'published' then raise exception 'Published weekly plan not found'; end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into expected_ids
  from public.tasks where weekly_plan_id = plan_record.id and day = p_day and removed_at is null;
  if expected_ids <> coalesce((select array_agg(id order by id) from unnest(p_task_ids) selected(id)), '{}'::uuid[])
    or cardinality(p_task_ids) <> cardinality(expected_ids) then
    raise exception 'Task order must contain every active task for the day exactly once';
  end if;
  update public.tasks t set position = ordered.position
  from unnest(p_task_ids) with ordinality ordered(id, position)
  where t.id = ordered.id and t.weekly_plan_id = plan_record.id;
end;
$$;

create function public.set_task_support_mode(p_task_id uuid, p_support_mode text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_support_mode not in ('independent', 'with_parent') then raise exception 'Invalid support mode'; end if;
  update public.tasks t set support_mode = p_support_mode
  from public.weekly_plans p
  where t.id = p_task_id and t.user_id = auth.uid() and t.weekly_plan_id = p.id
    and p.status = 'published' and t.removed_at is null;
  if not found then raise exception 'Current task not found'; end if;
end;
$$;

create function public.set_daily_reward(p_weekly_plan_id uuid, p_day text, p_reward text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_day not in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') then raise exception 'Invalid day'; end if;
  update public.weekly_plans
  set daily_rewards = case when trim(coalesce(p_reward, '')) = ''
    then daily_rewards - p_day
    else jsonb_set(daily_rewards, array[p_day], to_jsonb(left(trim(p_reward), 160)), true) end
  where id = p_weekly_plan_id and user_id = auth.uid() and status = 'published';
  if not found then raise exception 'Published weekly plan not found'; end if;
end;
$$;

create function public.create_weekly_task(
  p_weekly_plan_id uuid, p_name text, p_category text, p_day text, p_xp integer, p_support_mode text
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  plan_record public.weekly_plans%rowtype;
  new_task_id uuid;
  next_position integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_support_mode not in ('independent', 'with_parent') then raise exception 'Invalid support mode'; end if;
  select * into plan_record from public.weekly_plans
  where id = p_weekly_plan_id and user_id = auth.uid() for update;
  if not found then raise exception 'Weekly plan not found'; end if;
  if plan_record.status = 'completed' then raise exception 'Completed weekly plans cannot be changed'; end if;
  select coalesce(max(position), -1) + 1 into next_position from public.tasks
  where weekly_plan_id = plan_record.id and day = p_day and removed_at is null;
  insert into public.tasks (user_id, learner_id, weekly_plan_id, name, category, day, xp, position, support_mode)
  values (auth.uid(), plan_record.learner_id, plan_record.id, p_name, p_category, p_day, p_xp, next_position, p_support_mode)
  returning id into new_task_id;
  return new_task_id;
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
  select * into task_record from public.tasks where id = p_task_id and user_id = auth.uid() and removed_at is null;
  if not found then raise exception 'Task not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || task_record.learner_id::text, 0));
  if task_record.weekly_plan_id is not null then
    select status into plan_status from public.weekly_plans where id = task_record.weekly_plan_id for update;
    if plan_status = 'completed' then raise exception 'XP cannot be changed for a completed weekly plan'; end if;
  end if;
  select coalesce(sum(amount), 0)::integer into current_balance from public.xp_events
  where task_id = task_record.id and user_id = auth.uid() and learner_id = task_record.learner_id;
  if p_complete and current_balance <= 0 then
    insert into public.xp_events (user_id, learner_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id, task_record.xp, 'task_completed');
    update public.task_sessions set status = 'completed', ended_at = now()
    where task_id = task_record.id and ended_at is null;
  elsif not p_complete and current_balance > 0 then
    insert into public.xp_events (user_id, learner_id, task_id, weekly_plan_id, amount, reason)
    values (auth.uid(), task_record.learner_id, task_record.id, task_record.weekly_plan_id, -current_balance, 'task_unchecked');
  end if;
end;
$$;

revoke all on function public.copy_task_preferences() from public, anon, authenticated, service_role;
revoke all on function public.start_task(uuid) from public, anon, authenticated, service_role;
revoke all on function public.request_task_help(uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_help_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reorder_daily_tasks(uuid, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.set_task_support_mode(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.set_daily_reward(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_weekly_task(uuid, text, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.start_task(uuid) to authenticated;
grant execute on function public.request_task_help(uuid) to authenticated;
grant execute on function public.resolve_help_request(uuid) to authenticated;
grant execute on function public.reorder_daily_tasks(uuid, text, uuid[]) to authenticated;
grant execute on function public.set_task_support_mode(uuid, text) to authenticated;
grant execute on function public.set_daily_reward(uuid, text, text) to authenticated;
grant execute on function public.create_weekly_task(uuid, text, text, text, integer, text) to authenticated;
