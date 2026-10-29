-- Run after 0002 on development and production. Compare the first three values
-- with the pre-migration baseline captured by the rollout runbook.
select 'tasks' as measure, count(*)::numeric as value from public.tasks
union all
select 'xp_events', count(*)::numeric from public.xp_events
union all
select 'xp_total', coalesce(sum(amount), 0)::numeric from public.xp_events;

select user_id, count(*) as task_count
from public.tasks
group by user_id
order by user_id;

select user_id, count(*) as event_count, coalesce(sum(amount), 0) as xp_total
from public.xp_events
group by user_id
order by user_id;

-- All rows that existed before the additive migration must remain unassigned.
-- Replace the placeholders with baseline counts before running.
-- select count(*) = <PRE_MIGRATION_TASK_COUNT> from public.tasks where weekly_plan_id is null;
-- select count(*) = <PRE_MIGRATION_EVENT_COUNT> from public.xp_events where weekly_plan_id is null;

select count(*) as task_plan_user_mismatches
from public.tasks t
join public.weekly_plans p on p.id = t.weekly_plan_id
where t.user_id <> p.user_id;

select count(*) as event_task_plan_mismatches
from public.xp_events e
join public.tasks t on t.id = e.task_id
where e.user_id <> t.user_id or e.weekly_plan_id is distinct from t.weekly_plan_id;

select user_id, week_start, count(*)
from public.weekly_plans
group by user_id, week_start
having count(*) > 1;
