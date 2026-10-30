\set ON_ERROR_STOP on

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '60000000-0000-0000-0000-000000000006',
  'authenticated', 'authenticated', 'parent-struggles@example.invalid',
  crypt('local-test-only', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"60000000-0000-0000-0000-000000000006","role":"authenticated"}', true);

do $$
declare
  test_learner_id uuid;
  plan_id uuid;
  parent_task_id uuid;
  independent_task_id uuid;
  observation_id uuid;
  error_message text;
begin
  select public.create_family_learner('Struggle Test Learner', date '2032-03-01') into test_learner_id;
  select id into plan_id from public.weekly_plans where learner_id = test_learner_id and week_start = date '2032-03-01';

  select public.create_weekly_task(plan_id, 'Parent-led fractions', 'Math', 'Monday', 25, 'with_parent') into parent_task_id;
  select public.create_weekly_task(plan_id, 'Independent reading', 'Reading', 'Tuesday', 20, 'independent') into independent_task_id;

  select public.record_parent_struggle(parent_task_id, '  Reversed the numerator and denominator.  ') into observation_id;
  if not exists (
    select 1 from public.parent_struggle_observations
    where id = observation_id
      and learner_id = test_learner_id
      and weekly_plan_id = plan_id
      and category = 'Math'
      and description = 'Reversed the numerator and denominator.'
      and provenance = 'parent_reported'
  ) then raise exception 'Parent struggle did not preserve task context and provenance'; end if;

  if (select coalesce(sum(amount), 0) from public.xp_events where learner_id = test_learner_id) <> 0 then
    raise exception 'Recording a struggle changed XP';
  end if;

  begin
    perform public.record_parent_struggle(independent_task_id, 'Should not save');
    raise exception 'EXPECTED_INDEPENDENT_TASK_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_INDEPENDENT_TASK_FAILURE_WAS_NOT_RAISED'
      or position('parent-led task' in lower(error_message)) = 0 then raise; end if;
  end;

  begin
    perform public.record_parent_struggle(parent_task_id, '   ');
    raise exception 'EXPECTED_BLANK_DESCRIPTION_FAILURE_WAS_NOT_RAISED';
  exception when others then
    get stacked diagnostics error_message = message_text;
    if error_message = 'EXPECTED_BLANK_DESCRIPTION_FAILURE_WAS_NOT_RAISED'
      or position('description' in lower(error_message)) = 0 then raise; end if;
  end;

  begin
    insert into public.parent_struggle_observations (
      user_id, learner_id, task_id, weekly_plan_id, category, description
    ) values (
      auth.uid(), test_learner_id, parent_task_id, plan_id, 'Math', 'Direct insert'
    );
    raise exception 'EXPECTED_DIRECT_INSERT_FAILURE_WAS_NOT_RAISED';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select 'parent_struggle_observations' as test_name, 'PASS' as status;

rollback;
