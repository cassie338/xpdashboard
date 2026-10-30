\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '70000000-0000-0000-0000-000000000007',
  'authenticated', 'authenticated', 'task-swaps@example.invalid',
  crypt('local-test-only', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"70000000-0000-0000-0000-000000000007","role":"authenticated"}', true);

do $$
declare
  test_learner_id uuid;
  plan_id uuid;
  first_task_id uuid;
  second_task_id uuid;
  request_id uuid;
  retry_request_id uuid;
  replacement_id uuid;
  error_message text;
begin
  select public.create_family_learner('Swap Test Learner', date '2032-04-05') into test_learner_id;
  select id into plan_id from public.weekly_plans where learner_id = test_learner_id and week_start = date '2032-04-05';
  select public.create_weekly_task(plan_id, 'Story of the World', 'History', 'Monday', 35, 'with_parent') into first_task_id;
  select public.create_weekly_task(plan_id, 'Writing', 'Writing', 'Monday', 20, 'independent') into second_task_id;

  select public.request_task_swap(first_task_id, '  Piano  ') into request_id;
  if not exists (
    select 1 from public.task_swap_requests
    where id = request_id and requested_name = 'Piano' and status = 'pending' and day = 'Monday'
  ) then raise exception 'Swap request did not preserve normalized learner input'; end if;
  if (select count(*) from public.tasks where weekly_plan_id = plan_id and removed_at is null) <> 2
    or (select coalesce(sum(amount), 0) from public.xp_events where learner_id = test_learner_id) <> 0 then
    raise exception 'Pending swap changed tasks or XP';
  end if;

  begin
    perform public.start_task(first_task_id);
    raise exception 'EXPECTED_PENDING_START_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_PENDING_START_FAILURE_WAS_NOT_RAISED'
      or position('parent approval' in lower(error_message)) = 0 then raise; end if;
  end;
  begin
    perform public.record_task_completion(first_task_id, true);
    raise exception 'EXPECTED_PENDING_COMPLETION_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_PENDING_COMPLETION_FAILURE_WAS_NOT_RAISED'
      or position('parent approval' in lower(error_message)) = 0 then raise; end if;
  end;

  begin
    perform public.request_task_swap(second_task_id, 'Drawing');
    raise exception 'EXPECTED_DAILY_LIMIT_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_DAILY_LIMIT_FAILURE_WAS_NOT_RAISED'
      or position('daily swap' in lower(error_message)) = 0 then raise; end if;
  end;

  perform public.review_task_swap(request_id, false);
  select public.request_task_swap(second_task_id, 'Drawing') into retry_request_id;
  select public.review_task_swap(retry_request_id, true) into replacement_id;

  if not exists (
    select 1 from public.tasks replacement
    join public.tasks original on original.id = second_task_id
    where replacement.id = replacement_id
      and replacement.name = 'Drawing'
      and replacement.xp = original.xp
      and replacement.category = original.category
      and replacement.day = original.day
      and replacement.support_mode = original.support_mode
      and replacement.removed_at is null
      and original.removed_at is not null
  ) then raise exception 'Approved replacement did not inherit the effort contract'; end if;
  if not exists (
    select 1 from public.task_swap_requests
    where id = retry_request_id and status = 'approved' and replacement_task_id = replacement_id and reviewed_at is not null
  ) then raise exception 'Approved swap provenance was not preserved'; end if;
  if (select coalesce(sum(amount), 0) from public.xp_events where learner_id = test_learner_id) <> 0 then
    raise exception 'Swap review changed XP';
  end if;

  begin
    perform public.request_task_swap(first_task_id, 'Piano');
    raise exception 'EXPECTED_USED_SWAP_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_USED_SWAP_FAILURE_WAS_NOT_RAISED'
      or position('daily swap' in lower(error_message)) = 0 then raise; end if;
  end;

  perform public.record_task_completion(replacement_id, true);
  if (select coalesce(sum(amount), 0) from public.xp_events where task_id = replacement_id) <> 20 then
    raise exception 'Replacement did not earn inherited XP on completion';
  end if;
end;
$$;

select 'daily_task_swaps' as test_name, 'PASS' as status;

rollback;
