\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '50000000-0000-0000-0000-000000000005',
  'authenticated', 'authenticated', 'next-task@example.invalid',
  crypt('local-test-only', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"50000000-0000-0000-0000-000000000005","role":"authenticated"}', true);

do $$
declare
  learner_id uuid;
  legacy_task_id uuid;
  plan_id uuid;
  first_task_id uuid;
  second_task_id uuid;
  session_id uuid;
  repeated_session_id uuid;
  help_id uuid;
  repeated_help_id uuid;
  replacement_help_id uuid;
  error_message text;
begin
  select id into learner_id from public.learners where user_id = auth.uid() and is_default;
  insert into public.tasks (user_id, learner_id, name, category, day, xp)
  values (auth.uid(), learner_id, 'First task', 'Math', 'Monday', 20)
  returning id into legacy_task_id;

  select public.start_next_week(null, array[legacy_task_id], date '2032-02-02') into plan_id;
  select id into first_task_id from public.tasks where weekly_plan_id = plan_id and copied_from_task_id = legacy_task_id;
  select public.create_weekly_task(plan_id, 'Second task', 'Reading', 'Monday', 30, 'with_parent') into second_task_id;

  if (select support_mode from public.tasks where id = second_task_id) <> 'with_parent' then
    raise exception 'Support mode was not stored';
  end if;

  perform public.reorder_daily_tasks(plan_id, 'Monday', array[second_task_id, first_task_id]);
  if (select position from public.tasks where id = second_task_id) <> 1
    or (select position from public.tasks where id = first_task_id) <> 2 then
    raise exception 'Task order was not stored';
  end if;

  begin
    perform public.reorder_daily_tasks(plan_id, 'Monday', array[first_task_id]);
    raise exception 'EXPECTED_INCOMPLETE_ORDER_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_INCOMPLETE_ORDER_FAILURE_WAS_NOT_RAISED'
      or position('every active task' in lower(error_message)) = 0 then raise; end if;
  end;

  perform public.set_daily_reward(plan_id, 'Monday', 'Choose the family game');
  if (select daily_rewards->>'Monday' from public.weekly_plans where id = plan_id) <> 'Choose the family game' then
    raise exception 'Daily reward was not stored';
  end if;

  select public.start_task(first_task_id) into session_id;
  select public.start_task(first_task_id) into repeated_session_id;
  if session_id <> repeated_session_id then raise exception 'Starting a task was not idempotent'; end if;

  select public.request_task_help(first_task_id) into help_id;
  select public.request_task_help(first_task_id) into repeated_help_id;
  if help_id <> repeated_help_id then raise exception 'Help request was not idempotent'; end if;
  if (select coalesce(sum(amount), 0) from public.xp_events where task_id = first_task_id) <> 0 then
    raise exception 'Starting work or asking for help changed XP';
  end if;

  perform public.resolve_help_request(help_id);
  select public.request_task_help(first_task_id) into replacement_help_id;
  if replacement_help_id = help_id then raise exception 'Resolved help could not be requested again'; end if;

  perform public.record_task_completion(first_task_id, true);
  if exists (select 1 from public.task_sessions where id = session_id and ended_at is null) then
    raise exception 'Completion did not close the task session';
  end if;
  if (select coalesce(sum(amount), 0) from public.xp_events where task_id = first_task_id) <> 20 then
    raise exception 'Completion did not award task XP exactly once';
  end if;
end;
$$;

select 'next_task_dashboard' as test_name, 'PASS' as status;

rollback;
