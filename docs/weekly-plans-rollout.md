# Weekly Plans Rollout Runbook

Do not run these steps against production until the development restore and acceptance checks pass and production execution is explicitly approved.

## Required environment

Use separate connection strings. Never point both variables at the same project.

```bash
export PRODUCTION_DATABASE_URL='postgresql://...'
export DEVELOPMENT_DATABASE_URL='postgresql://...'
test "$PRODUCTION_DATABASE_URL" != "$DEVELOPMENT_DATABASE_URL"
```

Install PostgreSQL client tools compatible with the Supabase Postgres major version. Store generated files outside the repository.

## Production backup

1. Confirm the Supabase dashboard reports a successful managed backup or an available point-in-time recovery point immediately before the change.
2. Capture the current public schema and data as a second, logical backup:

```bash
mkdir -p "/secure/backups/xp-dashboard"
pg_dump "$PRODUCTION_DATABASE_URL" --format=custom --no-owner --no-acl --schema=public --file="/secure/backups/xp-dashboard/pre-weekly-plans.dump"
pg_restore --list "/secure/backups/xp-dashboard/pre-weekly-plans.dump" > "/secure/backups/xp-dashboard/pre-weekly-plans.contents.txt"
```

3. Capture the immutable baseline before migration:

```bash
psql "$PRODUCTION_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select 'tasks' as measure, count(*)::numeric as value from public.tasks union all select 'xp_events', count(*)::numeric from public.xp_events union all select 'xp_total', coalesce(sum(amount), 0)::numeric from public.xp_events" > "/secure/backups/xp-dashboard/pre-weekly-plans-baseline.csv"
psql "$PRODUCTION_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select user_id, count(*) as task_count from public.tasks group by user_id order by user_id" > "/secure/backups/xp-dashboard/pre-weekly-plans-tasks-by-user.csv"
psql "$PRODUCTION_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select user_id, count(*) as event_count, coalesce(sum(amount), 0) as xp_total from public.xp_events group by user_id order by user_id" > "/secure/backups/xp-dashboard/pre-weekly-plans-xp-by-user.csv"
```

## Restore verification

The backup is not considered usable merely because `pg_dump` succeeded.

1. Create or reset an isolated Supabase development project with the same base migration and matching test Auth users.
2. Restore the logical backup only into that isolated project:

```bash
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --dbname="$DEVELOPMENT_DATABASE_URL" "/secure/backups/xp-dashboard/pre-weekly-plans.dump"
```

3. Run the baseline query against development and compare it byte-for-byte after normalizing line endings:

```bash
psql "$DEVELOPMENT_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select 'tasks' as measure, count(*)::numeric as value from public.tasks union all select 'xp_events', count(*)::numeric from public.xp_events union all select 'xp_total', coalesce(sum(amount), 0)::numeric from public.xp_events" > "/secure/backups/xp-dashboard/restored-baseline.csv"
diff -u "/secure/backups/xp-dashboard/pre-weekly-plans-baseline.csv" "/secure/backups/xp-dashboard/restored-baseline.csv"
psql "$DEVELOPMENT_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select user_id, count(*) as task_count from public.tasks group by user_id order by user_id" > "/secure/backups/xp-dashboard/restored-tasks-by-user.csv"
psql "$DEVELOPMENT_DATABASE_URL" --set ON_ERROR_STOP=1 --csv --command="select user_id, count(*) as event_count, coalesce(sum(amount), 0) as xp_total from public.xp_events group by user_id order by user_id" > "/secure/backups/xp-dashboard/restored-xp-by-user.csv"
diff -u "/secure/backups/xp-dashboard/pre-weekly-plans-tasks-by-user.csv" "/secure/backups/xp-dashboard/restored-tasks-by-user.csv"
diff -u "/secure/backups/xp-dashboard/pre-weekly-plans-xp-by-user.csv" "/secure/backups/xp-dashboard/restored-xp-by-user.csv"
```

4. Sign in to the development app and confirm the restored legacy tasks and XP are visible. Record the restore timestamp, project ID, and verifier.

If restore or comparison fails, stop. Do not migrate production.

## Development migration

Apply only the additive migration first:

```bash
psql "$DEVELOPMENT_DATABASE_URL" --set ON_ERROR_STOP=1 --file="supabase/migrations/0002_weekly_plans_expand.sql"
psql "$DEVELOPMENT_DATABASE_URL" --set ON_ERROR_STOP=1 --file="supabase/verification/weekly_plans_post_migration.sql"
```

Verify the baseline counts and XP total are unchanged and both mismatch counts are zero. Existing rows must still have null `weekly_plan_id` values.

## Development acceptance

Use two development Auth accounts and test through both the app and direct Supabase calls.

- Create the first plan from Legacy / Unassigned and confirm no legacy row changed.
- Call `start_next_week` twice with identical arguments and confirm one plan and one copy per selected source task.
- Retry with a different selection and confirm the transaction fails without partial rows.
- Earn and undo XP; confirm two ledger events remain and net XP is zero.
- Rollover and confirm prior-week task and XP totals are unchanged.
- Attempt completion, undo, task creation, task deletion, sick-day changes, and direct task deletion against a completed week; every call must fail.
- Attempt direct XP update and deletion; both must fail.
- Authenticate as the second account and confirm the first account's plans, tasks, and XP cannot be selected or mutated.
- Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.

## Production deployment order

1. Reconfirm backup/PITR and capture a fresh baseline.
2. Apply `0002_weekly_plans_expand.sql`. The existing live app remains compatible.
3. Run post-migration verification and compare counts and XP totals.
4. Deploy the plan-aware application.
5. Verify first-plan creation, rollover retry, history totals, and cross-session synchronization in production.
6. Observe production before preparing or applying a contract migration.
7. Apply the future contract migration only after explicit approval and successful production verification.

Do not deploy the old application after weekly-plan XP exists because it aggregates every XP event as one week.

## Recovery

Before weekly-plan writes occur, restore the managed backup or the verified logical dump if the additive migration causes an unexpected failure. After weekly-plan writes occur, preserve those records and prefer a forward fix; do not drop weekly-plan tables or columns without a separately reviewed data recovery plan.
