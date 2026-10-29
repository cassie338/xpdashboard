\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '30000000-0000-0000-0000-000000000003',
  'authenticated',
  'authenticated',
  'remove-regression@example.invalid',
  crypt('local-test-only', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
);

insert into public.tasks (id, user_id, name, category, day, xp)
values (
  '33000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000003',
  'Wednesday task with history',
  'Math',
  'Wednesday',
  45
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"30000000-0000-0000-0000-000000000003","role":"authenticated"}', true);

do $$
declare
  plan_id uuid;
  copied_task_id uuid;
  protected_task_id uuid;
  destination_plan_id uuid;
  event_count_before integer;
  event_total_before integer;
  error_message text;
begin
  select public.start_next_week(
    null,
    array['33000000-0000-0000-0000-000000000003'::uuid],
    date '2032-01-05'
  ) into plan_id;

  select id into copied_task_id
  from public.tasks
  where weekly_plan_id = plan_id;

  perform public.record_task_completion(copied_task_id, true);
  perform public.record_task_completion(copied_task_id, false);

  select count(*), coalesce(sum(amount), 0)::integer
  into event_count_before, event_total_before
  from public.xp_events
  where task_id = copied_task_id;

  if event_count_before <> 2 or event_total_before <> 0 then
    raise exception 'Completion and undo fixture was not created correctly';
  end if;

  perform public.delete_weekly_task(copied_task_id);

  if not exists (
    select 1 from public.tasks
    where id = copied_task_id and removed_at is not null
  ) then
    raise exception 'Removed task row was deleted instead of archived';
  end if;
  if exists (
    select 1 from public.tasks
    where id = copied_task_id and removed_at is null
  ) then
    raise exception 'Archived task still appears active';
  end if;
  if (select count(*) from public.xp_events where task_id = copied_task_id) <> event_count_before
    or (select coalesce(sum(amount), 0) from public.xp_events where task_id = copied_task_id) <> event_total_before then
    raise exception 'Archiving changed the XP ledger';
  end if;

  begin
    perform public.record_task_completion(copied_task_id, true);
    raise exception 'EXPECTED_ARCHIVED_COMPLETION_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_ARCHIVED_COMPLETION_FAILURE_WAS_NOT_RAISED'
      or position('task not found' in lower(error_message)) = 0 then raise; end if;
  end;

  begin
    perform public.start_next_week(plan_id, array[copied_task_id], date '2032-01-12');
    raise exception 'EXPECTED_ARCHIVED_ROLLOVER_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_ARCHIVED_ROLLOVER_FAILURE_WAS_NOT_RAISED'
      or position('authenticated user and source' in lower(error_message)) = 0 then raise; end if;
  end;

  if (select status from public.weekly_plans where id = plan_id) <> 'published'
    or exists (select 1 from public.weekly_plans where week_start = date '2032-01-12') then
    raise exception 'Rejected archived rollover changed plan state';
  end if;

  select public.create_weekly_task(
    plan_id,
    'Task with earned XP',
    'Reading',
    'Thursday',
    35
  ) into protected_task_id;
  perform public.record_task_completion(protected_task_id, true);

  begin
    perform public.delete_weekly_task(protected_task_id);
    raise exception 'EXPECTED_EARNED_XP_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_EARNED_XP_FAILURE_WAS_NOT_RAISED'
      or position('undo earned xp' in lower(error_message)) = 0 then raise; end if;
  end;

  if not exists (
    select 1 from public.tasks
    where id = protected_task_id and removed_at is null
  ) or (select coalesce(sum(amount), 0) from public.xp_events where task_id = protected_task_id) <> 35 then
    raise exception 'Rejected positive-XP removal changed the task or ledger';
  end if;

  perform public.record_task_completion(protected_task_id, false);
  select public.start_next_week(
    plan_id,
    array[protected_task_id],
    date '2032-01-12'
  ) into destination_plan_id;

  begin
    perform public.delete_weekly_task(protected_task_id);
    raise exception 'EXPECTED_COMPLETED_WEEK_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_COMPLETED_WEEK_FAILURE_WAS_NOT_RAISED'
      or position('completed weekly plans cannot be changed' in lower(error_message)) = 0 then raise; end if;
  end;

  if (select status from public.weekly_plans where id = plan_id) <> 'completed'
    or not exists (select 1 from public.weekly_plans where id = destination_plan_id and status = 'published')
    or not exists (select 1 from public.tasks where id = protected_task_id and removed_at is null) then
    raise exception 'Rejected completed-week removal changed preserved history';
  end if;
end;
$$;

select
  'remove_task_with_xp_history' as test_name,
  'PASS' as status,
  'Net-zero task archived with ledger preserved; positive-XP and completed-week removals rejected.' as evidence;

rollback;
