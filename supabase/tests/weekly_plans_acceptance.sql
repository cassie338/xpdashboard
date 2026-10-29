\set ON_ERROR_STOP on

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

create temporary table weekly_test_results (
  test_name text primary key,
  status text not null,
  evidence text not null
) on commit drop;

do $$
declare
  user_one constant uuid := '10000000-0000-0000-0000-000000000001';
  user_two constant uuid := '20000000-0000-0000-0000-000000000002';
  legacy_one constant uuid := '11000000-0000-0000-0000-000000000001';
  legacy_two constant uuid := '11000000-0000-0000-0000-000000000002';
  other_user_task constant uuid := '22000000-0000-0000-0000-000000000001';
  first_plan uuid;
  first_retry uuid;
  second_plan uuid;
  second_retry uuid;
  first_tasks uuid[];
  second_tasks uuid[];
  first_task uuid;
  second_task uuid;
  closed_unreferenced_task uuid;
  before_plan_count integer;
  before_task_count integer;
  before_event_count integer;
  before_first_xp integer;
  error_message text;
begin
  select public.start_next_week(
    null,
    array[legacy_one, legacy_two],
    date '2026-10-26'
  ) into first_plan;

  if (select count(*) from public.weekly_plans where id = first_plan and user_id = user_one and status = 'published') <> 1
    or (select count(*) from public.tasks where weekly_plan_id = first_plan) <> 2
    or (select count(*) from public.tasks where id in (legacy_one, legacy_two) and weekly_plan_id is null) <> 2
    or (select count(*) from public.xp_events where weekly_plan_id = first_plan) <> 0
    or (select sick_days from public.weekly_plans where id = first_plan) <> array['Friday']::text[] then
    raise exception 'First weekly plan assertions failed';
  end if;
  insert into weekly_test_results values (
    'first_week_creation', 'PASS',
    'Created one published 2026-10-26 plan with 2 fresh tasks, Friday sick day, 0 copied XP events, and 2 untouched legacy tasks.'
  );

  select count(*) into before_plan_count from public.weekly_plans;
  select count(*) into before_task_count from public.tasks;
  select public.start_next_week(null, array[legacy_one, legacy_two], date '2026-10-26') into first_retry;
  if first_retry <> first_plan
    or (select count(*) from public.weekly_plans) <> before_plan_count
    or (select count(*) from public.tasks) <> before_task_count then
    raise exception 'First-week retry duplicated data';
  end if;
  insert into weekly_test_results values (
    'first_week_identical_retry', 'PASS',
    'Identical retry returned the same plan ID; plan and task counts were unchanged.'
  );

  begin
    perform public.start_next_week(null, array[legacy_one], date '2026-10-26');
    raise exception 'EXPECTED_CONFLICT_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CONFLICT_WAS_NOT_RAISED'
      or position('different task selection' in error_message) = 0 then
      raise;
    end if;
  end;
  if (select count(*) from public.weekly_plans) <> before_plan_count
    or (select count(*) from public.tasks) <> before_task_count then
    raise exception 'Conflicting first-week retry changed data';
  end if;
  insert into weekly_test_results values (
    'first_week_conflicting_retry', 'PASS',
    'Different task selection was rejected and plan/task counts remained unchanged.'
  );

  select array_agg(id order by id)
  into first_tasks
  from public.tasks
  where weekly_plan_id = first_plan;
  first_task := first_tasks[1];

  perform public.record_task_completion(first_task, true);
  perform public.record_task_completion(first_task, false);
  if (select count(*) from public.xp_events where task_id = first_task) <> 2
    or (select coalesce(sum(amount), 0) from public.xp_events where task_id = first_task) <> 0
    or (select count(*) from public.xp_events where task_id = first_task and amount < 0 and reason = 'task_unchecked') <> 1 then
    raise exception 'Completion undo did not create an exact compensating event';
  end if;
  insert into weekly_test_results values (
    'completion_and_undo', 'PASS',
    'Completion plus undo left 2 append-only events, one task_unchecked compensation, and net 0 XP.'
  );

  select public.create_weekly_task(first_plan, 'Do not copy', 'Creative', 'Sunday', 10)
  into closed_unreferenced_task;

  select coalesce(sum(amount), 0) into before_first_xp
  from public.xp_events where weekly_plan_id = first_plan;
  select count(*) into before_event_count from public.xp_events where weekly_plan_id = first_plan;

  select public.start_next_week(first_plan, first_tasks, date '2026-11-02') into second_plan;
  if (select status from public.weekly_plans where id = first_plan) <> 'completed'
    or (select status from public.weekly_plans where id = second_plan) <> 'published'
    or (select count(*) from public.tasks where weekly_plan_id = second_plan) <> cardinality(first_tasks)
    or (select count(*) from public.xp_events where weekly_plan_id = second_plan) <> 0 then
    raise exception 'Rollover state assertions failed';
  end if;
  insert into weekly_test_results values (
    'atomic_rollover', 'PASS',
    'Source completed, destination published, every selected task copied, and destination completion state was empty.'
  );

  select count(*) into before_plan_count from public.weekly_plans;
  select count(*) into before_task_count from public.tasks;
  select public.start_next_week(first_plan, first_tasks, date '2026-11-02') into second_retry;
  if second_retry <> second_plan
    or (select count(*) from public.weekly_plans) <> before_plan_count
    or (select count(*) from public.tasks) <> before_task_count then
    raise exception 'Rollover retry duplicated data';
  end if;
  insert into weekly_test_results values (
    'rollover_identical_retry', 'PASS',
    'Identical rollover retry returned the same destination and created no plans or tasks.'
  );

  begin
    perform public.start_next_week(first_plan, array[first_tasks[1]], date '2026-11-02');
    raise exception 'EXPECTED_CONFLICT_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CONFLICT_WAS_NOT_RAISED'
      or position('different task selection' in error_message) = 0 then
      raise;
    end if;
  end;
  if (select count(*) from public.weekly_plans) <> before_plan_count
    or (select count(*) from public.tasks) <> before_task_count then
    raise exception 'Conflicting rollover retry changed data';
  end if;
  insert into weekly_test_results values (
    'rollover_conflicting_retry', 'PASS',
    'Different retry selection was rejected without changing destination data.'
  );

  select array_agg(id order by id)
  into second_tasks
  from public.tasks
  where weekly_plan_id = second_plan;
  second_task := second_tasks[1];

  begin
    perform public.start_next_week(
      second_plan,
      array[second_tasks[1], other_user_task],
      date '2026-11-09'
    );
    raise exception 'EXPECTED_ATOMIC_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_ATOMIC_FAILURE_WAS_NOT_RAISED'
      or position('authenticated user and source' in error_message) = 0 then
      raise;
    end if;
  end;
  if (select status from public.weekly_plans where id = second_plan) <> 'published'
    or exists (select 1 from public.weekly_plans where user_id = user_one and week_start = date '2026-11-09') then
    raise exception 'Failed rollover left partial plan state';
  end if;
  insert into weekly_test_results values (
    'rollover_failure_atomicity', 'PASS',
    'Invalid selected ownership failed with source still published and no destination plan.'
  );

  perform public.record_task_completion(second_task, true);
  if (select coalesce(sum(amount), 0) from public.xp_events where weekly_plan_id = first_plan) <> before_first_xp
    or (select count(*) from public.xp_events where weekly_plan_id = first_plan) <> before_event_count
    or (select coalesce(sum(amount), 0) from public.xp_events where weekly_plan_id is null and user_id = user_one) <> 25 then
    raise exception 'Later-week XP changed historical or legacy totals';
  end if;
  insert into weekly_test_results values (
    'history_isolation', 'PASS',
    'Later-week completion left prior-week events/net XP and legacy 25 XP unchanged.'
  );

  begin
    perform public.record_task_completion(first_task, true);
    raise exception 'EXPECTED_COMPLETION_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_COMPLETION_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plan' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.record_task_completion(first_task, false);
    raise exception 'EXPECTED_UNDO_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_UNDO_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plan' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.create_weekly_task(first_plan, 'Forbidden', 'Math', 'Monday', 10);
    raise exception 'EXPECTED_CREATE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CREATE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.delete_weekly_task(closed_unreferenced_task);
    raise exception 'EXPECTED_DELETE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_DELETE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.set_weekly_plan_sick_days(first_plan, array['Monday']);
    raise exception 'EXPECTED_SICK_DAY_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_SICK_DAY_FAILURE_WAS_NOT_RAISED'
      or position('published weekly plan not found' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    delete from public.tasks where id = closed_unreferenced_task;
    raise exception 'EXPECTED_DIRECT_DELETE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_DIRECT_DELETE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  insert into weekly_test_results values (
    'completed_week_rpcs', 'PASS',
    'Completion, undo, create, delete, sick-day change, and authenticated direct task delete all failed for the completed week.'
  );

  perform set_config('request.jwt.claims', '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
  if (select count(*) from public.weekly_plans where user_id = user_one) <> 0
    or (select count(*) from public.tasks where user_id = user_one) <> 0
    or (select count(*) from public.xp_events where user_id = user_one) <> 0
    or (select count(*) from public.dashboard_settings where user_id = user_one) <> 0
    or (select count(*) from public.tasks where user_id = user_two) <> 1 then
    raise exception 'RLS cross-user select isolation failed';
  end if;
  begin
    perform public.record_task_completion(first_task, true);
    raise exception 'EXPECTED_CROSS_USER_RPC_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CROSS_USER_RPC_FAILURE_WAS_NOT_RAISED'
      or position('task not found' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.start_next_week(first_plan, first_tasks, date '2026-11-02');
    raise exception 'EXPECTED_CROSS_USER_ROLLOVER_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CROSS_USER_ROLLOVER_FAILURE_WAS_NOT_RAISED'
      or position('source weekly plan not found' in lower(error_message)) = 0 then raise; end if;
  end;
  insert into weekly_test_results values (
    'cross_user_rls_and_rpcs', 'PASS',
    'Second user saw 0 first-user settings/plans/tasks/events and could not complete or roll over first-user records.'
  );
end;
$$;

reset role;

do $$
declare
  first_plan uuid;
  second_plan uuid;
  first_task uuid;
  first_event uuid;
  duplicate_source uuid;
  error_message text;
begin
  select id into first_plan from public.weekly_plans
  where user_id = '10000000-0000-0000-0000-000000000001' and week_start = date '2026-10-26';
  select id into second_plan from public.weekly_plans
  where user_id = '10000000-0000-0000-0000-000000000001' and week_start = date '2026-11-02';
  select t.id into first_task
  from public.tasks t
  where t.weekly_plan_id = first_plan
    and not exists (select 1 from public.tasks copy where copy.copied_from_task_id = t.id)
    and not exists (select 1 from public.xp_events event where event.task_id = t.id)
  order by t.id
  limit 1;
  select id into first_event from public.xp_events where weekly_plan_id = first_plan order by earned_at limit 1;
  select copied_from_task_id into duplicate_source from public.tasks where weekly_plan_id = second_plan order by id limit 1;

  begin
    update public.xp_events set amount = amount + 1 where id = first_event;
    raise exception 'EXPECTED_XP_UPDATE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_XP_UPDATE_FAILURE_WAS_NOT_RAISED'
      or position('append-only' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    delete from public.xp_events where id = first_event;
    raise exception 'EXPECTED_XP_DELETE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_XP_DELETE_FAILURE_WAS_NOT_RAISED'
      or position('append-only' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    insert into public.xp_events (user_id, task_id, weekly_plan_id, amount, reason)
    values ('10000000-0000-0000-0000-000000000001', first_task, first_plan, 1, 'task_completed');
    raise exception 'EXPECTED_CLOSED_XP_INSERT_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CLOSED_XP_INSERT_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plan' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    update public.tasks set name = 'Forbidden edit' where id = first_task;
    raise exception 'EXPECTED_TASK_UPDATE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_TASK_UPDATE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    delete from public.tasks where id = first_task;
    raise exception 'EXPECTED_TASK_DELETE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_TASK_DELETE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    update public.weekly_plans set sick_days = array['Tuesday'] where id = first_plan;
    raise exception 'EXPECTED_PLAN_UPDATE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_PLAN_UPDATE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    delete from public.weekly_plans where id = first_plan;
    raise exception 'EXPECTED_PLAN_DELETE_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_PLAN_DELETE_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans' in lower(error_message)) = 0 then raise; end if;
  end;
  insert into weekly_test_results values (
    'completed_week_owner_triggers', 'PASS',
    'Owner-level XP update/delete/insert and completed task/plan update/delete were all rejected by triggers.'
  );

  begin
    insert into public.tasks (user_id, weekly_plan_id, copied_from_task_id, name, category, day, xp)
    values ('10000000-0000-0000-0000-000000000001', second_plan, duplicate_source, 'Duplicate', 'Math', 'Monday', 10);
    raise exception 'EXPECTED_DUPLICATE_COPY_FAILURE_WAS_NOT_RAISED';
  exception when unique_violation then
    null;
  end;
  insert into weekly_test_results values (
    'duplicate_copy_constraint', 'PASS',
    'Database unique constraint rejected the same source task in the same destination plan.'
  );
end;
$$;

select test_name, status, evidence
from weekly_test_results
order by test_name;

select
  (select count(*) from public.weekly_plans) as plan_count,
  (select count(*) from public.tasks) as task_count,
  (select count(*) from public.xp_events) as event_count,
  (select coalesce(sum(amount), 0) from public.xp_events where weekly_plan_id is null) as legacy_xp,
  (select coalesce(sum(amount), 0) from public.xp_events where weekly_plan_id = (select id from public.weekly_plans where week_start = date '2026-10-26')) as first_week_xp,
  (select coalesce(sum(amount), 0) from public.xp_events where weekly_plan_id = (select id from public.weekly_plans where week_start = date '2026-11-02')) as second_week_xp;

commit;
