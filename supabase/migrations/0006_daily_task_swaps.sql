-- Learner-requested, parent-reviewed daily task swaps. Approval replaces the
-- assigned task while preserving its effort contract and both task records.

create table public.task_swap_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  learner_id uuid not null,
  weekly_plan_id uuid not null,
  original_task_id uuid not null,
  replacement_task_id uuid,
  day text not null check (day in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  requested_name text not null check (length(trim(requested_name)) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (
    (status = 'pending' and reviewed_at is null and replacement_task_id is null)
    or (status = 'rejected' and reviewed_at is not null and replacement_task_id is null)
    or (status = 'approved' and reviewed_at is not null and replacement_task_id is not null)
  ),
  foreign key (learner_id, user_id) references public.learners(id, user_id),
  foreign key (weekly_plan_id, learner_id, user_id) references public.weekly_plans(id, learner_id, user_id),
  foreign key (original_task_id, learner_id, user_id) references public.tasks(id, learner_id, user_id),
  foreign key (replacement_task_id, learner_id, user_id) references public.tasks(id, learner_id, user_id)
);

create unique index task_swaps_one_active_daily_idx
  on public.task_swap_requests(learner_id, weekly_plan_id, day)
  where status in ('pending', 'approved');
create index task_swaps_plan_requested_idx
  on public.task_swap_requests(weekly_plan_id, requested_at desc);

alter table public.task_swap_requests enable row level security;
create policy task_swaps_select_own on public.task_swap_requests
  for select to authenticated using (user_id = auth.uid());
revoke all on public.task_swap_requests from anon, authenticated;
grant select on public.task_swap_requests to authenticated;
alter publication supabase_realtime add table public.task_swap_requests;

create function public.request_task_swap(p_task_id uuid, p_requested_name text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  request_id uuid;
  normalized_name text := trim(coalesce(p_requested_name, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(normalized_name) not between 1 and 80 then
    raise exception 'Replacement activity must be between 1 and 80 characters';
  end if;

  select t.* into task_record
  from public.tasks t
  join public.weekly_plans p on p.id = t.weekly_plan_id
  where t.id = p_task_id and t.user_id = auth.uid()
    and t.removed_at is null and p.status = 'published';
  if not found then raise exception 'Current task not found'; end if;
  if exists (select 1 from public.xp_events where task_id = task_record.id group by task_id having sum(amount) > 0) then
    raise exception 'Completed tasks cannot be swapped';
  end if;
  if exists (select 1 from public.task_sessions where task_id = task_record.id and ended_at is null) then
    raise exception 'Started tasks cannot be swapped';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(task_record.learner_id::text || ':' || task_record.weekly_plan_id::text || ':' || task_record.day, 0));
  if exists (
    select 1 from public.task_swap_requests
    where learner_id = task_record.learner_id
      and weekly_plan_id = task_record.weekly_plan_id
      and day = task_record.day
      and status in ('pending', 'approved')
  ) then raise exception 'The daily swap is already pending or used'; end if;

  insert into public.task_swap_requests (
    user_id, learner_id, weekly_plan_id, original_task_id, day, requested_name
  ) values (
    auth.uid(), task_record.learner_id, task_record.weekly_plan_id,
    task_record.id, task_record.day, normalized_name
  ) returning id into request_id;
  return request_id;
end;
$$;

create function public.review_task_swap(p_swap_request_id uuid, p_approve boolean)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  request_record public.task_swap_requests%rowtype;
  task_record public.tasks%rowtype;
  replacement_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into request_record from public.task_swap_requests
  where id = p_swap_request_id and user_id = auth.uid() and status = 'pending'
  for update;
  if not found then raise exception 'Pending swap request not found'; end if;

  if not p_approve then
    update public.task_swap_requests set status = 'rejected', reviewed_at = now()
    where id = request_record.id;
    return null;
  end if;

  select t.* into task_record
  from public.tasks t
  join public.weekly_plans p on p.id = t.weekly_plan_id
  where t.id = request_record.original_task_id and t.user_id = auth.uid()
    and t.removed_at is null and p.status = 'published'
  for update of t;
  if not found then raise exception 'Current task not found'; end if;
  if exists (select 1 from public.xp_events where task_id = task_record.id group by task_id having sum(amount) > 0) then
    raise exception 'Completed tasks cannot be swapped';
  end if;
  if exists (select 1 from public.task_sessions where task_id = task_record.id and ended_at is null) then
    raise exception 'Started tasks cannot be swapped';
  end if;

  update public.tasks set removed_at = now() where id = task_record.id;
  insert into public.tasks (
    user_id, learner_id, weekly_plan_id, name, category, day, xp, position, support_mode
  ) values (
    auth.uid(), task_record.learner_id, task_record.weekly_plan_id,
    request_record.requested_name, task_record.category, task_record.day,
    task_record.xp, task_record.position, task_record.support_mode
  ) returning id into replacement_id;

  update public.task_swap_requests
  set status = 'approved', reviewed_at = now(), replacement_task_id = replacement_id
  where id = request_record.id;
  return replacement_id;
end;
$$;

revoke all on function public.request_task_swap(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.review_task_swap(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.request_task_swap(uuid, text) to authenticated;
grant execute on function public.review_task_swap(uuid, boolean) to authenticated;
