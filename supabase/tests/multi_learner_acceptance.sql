\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '40000000-0000-0000-0000-000000000004',
  'authenticated', 'authenticated', 'multi-learner@example.invalid',
  crypt('local-test-only', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"40000000-0000-0000-0000-000000000004","role":"authenticated"}', true);

do $$
declare
  default_learner_id uuid;
  second_learner_id uuid;
  default_legacy_task_id uuid;
  default_plan_id uuid;
  second_plan_id uuid;
  second_task_id uuid;
  error_message text;
begin
  select id into default_learner_id from public.learners
  where user_id = auth.uid() and is_default;
  if default_learner_id is null then raise exception 'Signup did not create a default learner'; end if;

  -- The old client may still insert without learner_id during deployment.
  insert into public.tasks (user_id, name, category, day, xp)
  values (auth.uid(), 'Default legacy task', 'Math', 'Monday', 20)
  returning id into default_legacy_task_id;
  if (select learner_id from public.tasks where id = default_legacy_task_id) <> default_learner_id then
    raise exception 'Legacy insert was not assigned to the default learner';
  end if;

  select public.create_family_learner('Second Learner', date '2032-01-05') into second_learner_id;
  select id into second_plan_id from public.weekly_plans
  where learner_id = second_learner_id and week_start = date '2032-01-05';

  if (select count(*) from public.learners where user_id = auth.uid()) <> 2
    or (select count(*) from public.dashboard_settings where user_id = auth.uid()) <> 2
    or second_plan_id is null then
    raise exception 'Second learner was not created atomically';
  end if;

  select public.start_next_week(null, array[default_legacy_task_id], date '2032-01-05') into default_plan_id;
  if default_plan_id = second_plan_id then raise exception 'Learners shared a weekly plan'; end if;
  if (select count(*) from public.weekly_plans where user_id = auth.uid() and week_start = date '2032-01-05') <> 2 then
    raise exception 'Learners could not hold separate plans for the same week';
  end if;

  select public.create_weekly_task(second_plan_id, 'Second learner task', 'Reading', 'Tuesday', 30)
  into second_task_id;
  perform public.record_task_completion(second_task_id, true);

  if (select coalesce(sum(amount), 0) from public.xp_events where learner_id = second_learner_id) <> 30
    or (select coalesce(sum(amount), 0) from public.xp_events where learner_id = default_learner_id) <> 0 then
    raise exception 'XP crossed learner boundaries';
  end if;

  begin
    insert into public.tasks (
      user_id, learner_id, weekly_plan_id, copied_from_task_id, name, category, day, xp
    ) values (
      auth.uid(), second_learner_id, second_plan_id, default_legacy_task_id,
      'Invalid cross-learner copy', 'Math', 'Friday', 10
    );
    raise exception 'EXPECTED_CROSS_LEARNER_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_CROSS_LEARNER_FAILURE_WAS_NOT_RAISED'
      or position('same learner' in lower(error_message)) = 0 then raise; end if;
  end;

  perform public.set_learner_name(second_learner_id, 'Second Learner Updated');
  if (select display_name from public.learners where id = second_learner_id) <> 'Second Learner Updated'
    or (select learner_name from public.dashboard_settings where learner_id = second_learner_id) <> 'Second Learner Updated' then
    raise exception 'Learner name sources were not updated together';
  end if;
end;
$$;

select 'multi_learner_isolation' as test_name, 'PASS' as status;

rollback;
