\set ON_ERROR_STOP on

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}', true);

do $$
declare
  completed_task uuid;
  removable_task uuid;
begin
  update public.dashboard_settings
  set learner_name = 'Compatibility Check', updated_at = now()
  where user_id = auth.uid();

  insert into public.tasks (user_id, name, category, day, xp)
  values (auth.uid(), 'Old client completion', 'Math', 'Thursday', 15)
  returning id into completed_task;

  perform public.record_task_completion(completed_task, true);
  if (select coalesce(sum(amount), 0) from public.xp_events where task_id = completed_task) <> 15 then
    raise exception 'Legacy completion path failed';
  end if;

  perform public.reset_task_completions();
  if (select coalesce(sum(amount), 0) from public.xp_events where task_id = completed_task) <> 0
    or (select count(*) from public.xp_events where task_id = completed_task) <> 2 then
    raise exception 'Legacy reset did not append an exact compensation';
  end if;

  insert into public.tasks (user_id, name, category, day, xp)
  values (auth.uid(), 'Old client removal', 'Reading', 'Friday', 10)
  returning id into removable_task;
  delete from public.tasks where id = removable_task;
  if exists (select 1 from public.tasks where id = removable_task) then
    raise exception 'Legacy direct task removal failed';
  end if;
end;
$$;

select
  'current_app_compatibility' as test_name,
  'PASS' as status,
  'Authenticated settings update, legacy task insert, completion, compensating reset, and unearned task delete all succeeded.' as evidence;

rollback;
