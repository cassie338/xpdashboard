-- Move an existing weekly task between day columns without replacing its identity,
-- XP history, help requests, swaps, or parent observations.

create function public.move_weekly_task(
  p_task_id uuid,
  p_target_day text,
  p_before_task_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  plan_record public.weekly_plans%rowtype;
  target_record public.tasks%rowtype;
  ordered_task record;
  next_position integer := 0;
  inserted boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_target_day not in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday') then
    raise exception 'Invalid target day';
  end if;

  select * into task_record from public.tasks
  where id = p_task_id and user_id = auth.uid() and removed_at is null
  for update;
  if not found or task_record.weekly_plan_id is null then raise exception 'Weekly task not found'; end if;

  select * into plan_record from public.weekly_plans
  where id = task_record.weekly_plan_id and user_id = auth.uid()
  for update;
  if not found or plan_record.status <> 'published' then raise exception 'Published weekly plan not found'; end if;

  if p_before_task_id = p_task_id then return; end if;
  if p_before_task_id is not null then
    select * into target_record from public.tasks
    where id = p_before_task_id and user_id = auth.uid()
      and weekly_plan_id = plan_record.id and day = p_target_day and removed_at is null
    for update;
    if not found then raise exception 'Target task not found'; end if;
  end if;

  -- Re-rank the source day first when crossing columns.
  if task_record.day <> p_target_day then
    next_position := 0;
    for ordered_task in
      select id from public.tasks
      where weekly_plan_id = plan_record.id and day = task_record.day
        and removed_at is null and id <> task_record.id
      order by position, created_at, id
    loop
      update public.tasks set position = next_position where id = ordered_task.id;
      next_position := next_position + 1;
    end loop;
  end if;

  next_position := 0;
  for ordered_task in
    select id from public.tasks
    where weekly_plan_id = plan_record.id and day = p_target_day
      and removed_at is null and id <> task_record.id
    order by position, created_at, id
  loop
    if not inserted and ordered_task.id = p_before_task_id then
      update public.tasks
      set day = p_target_day, position = next_position
      where id = task_record.id;
      next_position := next_position + 1;
      inserted := true;
    end if;
    update public.tasks set position = next_position where id = ordered_task.id;
    next_position := next_position + 1;
  end loop;

  if not inserted then
    update public.tasks
    set day = p_target_day, position = next_position
    where id = task_record.id;
  end if;
end;
$$;

revoke all on function public.move_weekly_task(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.move_weekly_task(uuid, text, uuid) to authenticated;
