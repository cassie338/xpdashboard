\set ON_ERROR_STOP on

select 'learners' as measure, count(*)::numeric as value from public.learners
union all select 'settings', count(*)::numeric from public.dashboard_settings
union all select 'plans', count(*)::numeric from public.weekly_plans
union all select 'tasks', count(*)::numeric from public.tasks
union all select 'xp_events', count(*)::numeric from public.xp_events
union all select 'xp_total', coalesce(sum(amount), 0)::numeric from public.xp_events
order by measure;

select
  (select count(*) from auth.users u where not exists (
    select 1 from public.learners l where l.user_id = u.id and l.is_default
  )) as users_without_default_learner,
  (select count(*) from public.dashboard_settings s join public.learners l on l.id = s.learner_id
    where s.user_id <> l.user_id) as settings_owner_mismatches,
  (select count(*) from public.weekly_plans p join public.learners l on l.id = p.learner_id
    where p.user_id <> l.user_id) as plan_owner_mismatches,
  (select count(*) from public.tasks t join public.learners l on l.id = t.learner_id
    where t.user_id <> l.user_id) as task_owner_mismatches,
  (select count(*) from public.tasks t join public.weekly_plans p on p.id = t.weekly_plan_id
    where t.user_id <> p.user_id or t.learner_id <> p.learner_id) as task_plan_mismatches,
  (select count(*) from public.xp_events e join public.tasks t on t.id = e.task_id
    where e.user_id <> t.user_id or e.learner_id <> t.learner_id) as event_task_mismatches,
  (select count(*) from public.xp_events e join public.weekly_plans p on p.id = e.weekly_plan_id
    where e.user_id <> p.user_id or e.learner_id <> p.learner_id) as event_plan_mismatches,
  (select count(*) from (
    select learner_id from public.weekly_plans where status = 'published'
    group by learner_id having count(*) > 1
  ) duplicates) as duplicate_published_learners;
