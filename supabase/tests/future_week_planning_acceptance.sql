\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '80000000-0000-0000-0000-000000000008',
  'authenticated', 'authenticated', 'future-planning@example.invalid',
  crypt('local-test-only', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"80000000-0000-0000-0000-000000000008","role":"authenticated"}', true);

do $$
declare
  test_learner_id uuid;
  source_plan_id uuid;
  second_plan_id uuid;
  second_retry_id uuid;
  third_plan_id uuid;
  first_task_id uuid;
  second_task_id uuid;
  second_task_ids uuid[];
  past_learner_id uuid;
  past_plan_id uuid;
  error_message text;
begin
  select public.create_family_learner('Future Plan Learner', date '2032-05-03') into test_learner_id;
  select id into source_plan_id from public.weekly_plans where learner_id = test_learner_id and week_start = date '2032-05-03';
  select public.create_weekly_task(source_plan_id, 'Monday math', 'Math', 'Monday', 25, 'independent') into first_task_id;
  select public.create_weekly_task(source_plan_id, 'Friday reading', 'Reading', 'Friday', 30, 'with_parent') into second_task_id;
  perform public.set_daily_reward(source_plan_id, 'Friday', 'Family movie');
  perform public.set_weekly_plan_sick_days(source_plan_id, array['Wednesday']);
  perform public.record_task_completion(first_task_id, true);

  select public.plan_future_week(source_plan_id, array[first_task_id, second_task_id]) into second_plan_id;
  if (select status from public.weekly_plans where id = source_plan_id) <> 'published' then
    raise exception 'Planning ahead closed the source week';
  end if;
  if (select week_start from public.weekly_plans where id = second_plan_id) <> date '2032-05-10'
    or (select sick_days from public.weekly_plans where id = second_plan_id) <> '{}'::text[]
    or (select daily_rewards from public.weekly_plans where id = second_plan_id) <> '{}'::jsonb then
    raise exception 'Future plan date or week-specific settings were incorrect';
  end if;
  if (select count(*) from public.tasks where weekly_plan_id = second_plan_id) <> 2
    or exists (
      select 1 from public.tasks copied
      join public.tasks source on source.id = copied.copied_from_task_id
      where copied.weekly_plan_id = second_plan_id
        and (copied.name, copied.category, copied.day, copied.xp, copied.position, copied.support_mode)
          is distinct from (source.name, source.category, source.day, source.xp, source.position, source.support_mode)
    ) then raise exception 'Future tasks did not preserve their assignments'; end if;
  if exists (select 1 from public.xp_events where weekly_plan_id = second_plan_id) then
    raise exception 'Planning ahead copied completion or XP';
  end if;

  select public.plan_future_week(source_plan_id, array[first_task_id, second_task_id]) into second_retry_id;
  if second_retry_id <> second_plan_id then raise exception 'Identical future-plan retry was not idempotent'; end if;
  begin
    perform public.plan_future_week(source_plan_id, array[first_task_id]);
    raise exception 'EXPECTED_CONFLICTING_RETRY_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CONFLICTING_RETRY_FAILURE_WAS_NOT_RAISED'
      or position('different task selection' in lower(error_message)) = 0 then raise; end if;
  end;

  select array_agg(id order by id) into second_task_ids from public.tasks where weekly_plan_id = second_plan_id;
  select public.plan_future_week(second_plan_id, second_task_ids) into third_plan_id;
  if (select week_start from public.weekly_plans where id = third_plan_id) <> date '2032-05-17' then
    raise exception 'A second future week could not be planned';
  end if;

  select public.create_family_learner('Past Plan Learner', date '2020-01-06') into past_learner_id;
  select id into past_plan_id from public.weekly_plans
  where learner_id = past_learner_id and week_start = date '2020-01-06';
  perform public.finalize_past_weekly_plans(date_trunc('week', current_date)::date);
  if (select status from public.weekly_plans where id = past_plan_id) <> 'completed' then
    raise exception 'Past published plan was not finalized';
  end if;
end;
$$;

select 'future_week_planning' as test_name, 'PASS' as status;

rollback;
