-- Allow families to prepare multiple future weeks without closing the current
-- week. Past published plans are finalized deterministically when the app loads.

drop index public.weekly_plans_one_published_per_learner_idx;

create function public.plan_future_week(p_source_plan_id uuid, p_task_ids uuid[])
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  source_plan public.weekly_plans%rowtype;
  destination_plan public.weekly_plans%rowtype;
  destination_id uuid;
  destination_week date;
  selected_ids uuid[];
  copied_ids uuid[];
  invalid_task_count integer;
  copied_task_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into selected_ids
  from (select distinct unnest(coalesce(p_task_ids, '{}'::uuid[])) as id) selected;
  if cardinality(selected_ids) = 0 then raise exception 'Select at least one task'; end if;

  select * into source_plan from public.weekly_plans
  where id = p_source_plan_id and user_id = auth.uid();
  if not found then raise exception 'Source weekly plan not found'; end if;
  destination_week := source_plan.week_start + 7;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || source_plan.learner_id::text, 0));
  select * into source_plan from public.weekly_plans where id = source_plan.id for update;

  select count(*) into invalid_task_count from unnest(selected_ids) selected(id)
  left join public.tasks t on t.id = selected.id
  where t.id is null or t.user_id <> auth.uid() or t.learner_id <> source_plan.learner_id
    or t.weekly_plan_id is distinct from source_plan.id or t.removed_at is not null;
  if invalid_task_count > 0 then
    raise exception 'Every selected task must belong to the authenticated user and source';
  end if;
  perform 1 from public.tasks where id = any(selected_ids) order by id for update;

  select * into destination_plan from public.weekly_plans
  where learner_id = source_plan.learner_id and week_start = destination_week for update;
  if found then
    destination_id := destination_plan.id;
    if destination_plan.status = 'completed' then raise exception 'Destination weekly plan is already completed'; end if;
    select coalesce(array_agg(copied_from_task_id order by copied_from_task_id), '{}'::uuid[])
    into copied_ids from public.tasks
    where weekly_plan_id = destination_id and learner_id = source_plan.learner_id and copied_from_task_id is not null;
    if copied_ids <> selected_ids then
      raise exception 'This weekly plan already exists with a different task selection';
    end if;
    return destination_id;
  end if;

  if exists (
    select 1 from public.weekly_plans
    where learner_id = source_plan.learner_id and week_start > source_plan.week_start
  ) then raise exception 'Only the latest weekly plan can be used to plan ahead'; end if;

  insert into public.weekly_plans (user_id, learner_id, week_start, sick_days, daily_rewards)
  values (auth.uid(), source_plan.learner_id, destination_week, '{}'::text[], '{}'::jsonb)
  returning id into destination_id;

  insert into public.tasks (
    user_id, learner_id, weekly_plan_id, copied_from_task_id,
    name, category, day, xp, position, support_mode
  )
  select auth.uid(), source_plan.learner_id, destination_id, source.id,
    source.name, source.category, source.day, source.xp, source.position, source.support_mode
  from public.tasks source
  where source.id = any(selected_ids) and source.removed_at is null
  order by source.day, source.position, source.created_at, source.id;
  get diagnostics copied_task_count = row_count;
  if copied_task_count <> cardinality(selected_ids) then
    raise exception 'Not every selected task was copied';
  end if;
  return destination_id;
end;
$$;

create function public.finalize_past_weekly_plans(p_current_week_start date)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_current_week_start is null or extract(isodow from p_current_week_start) <> 1 then
    raise exception 'Current week start must be a Monday';
  end if;
  if abs(p_current_week_start - date_trunc('week', current_date)::date) > 7 then
    raise exception 'Current week start is outside the allowed timezone range';
  end if;
  update public.weekly_plans
  set status = 'completed', completed_at = now()
  where user_id = auth.uid()
    and status = 'published'
    and week_start < p_current_week_start;
end;
$$;

revoke all on function public.plan_future_week(uuid, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_past_weekly_plans(date)
  from public, anon, authenticated, service_role;
grant execute on function public.plan_future_week(uuid, uuid[]) to authenticated;
grant execute on function public.finalize_past_weekly_plans(date) to authenticated;
