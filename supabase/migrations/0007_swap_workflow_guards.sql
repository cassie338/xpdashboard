-- Enforce pending-swap approval inside authoritative task RPCs, not only in UI.

create or replace function public.start_task(p_task_id uuid)
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
  if exists (select 1 from public.task_swap_requests where original_task_id = p_task_id and status = 'pending') then
    raise exception 'Parent approval is required before this task can be started';
  end if;
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
  if p_complete and exists (
    select 1 from public.task_swap_requests where original_task_id = p_task_id and status = 'pending'
  ) then raise exception 'Parent approval is required before this task can be completed'; end if;
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
