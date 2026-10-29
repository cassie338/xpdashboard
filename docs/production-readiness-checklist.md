# Production Readiness Checklist

No production action should begin until every required item is checked and recorded with the operator, timestamp, project reference, and evidence location.

## Backup And Restore

- [ ] Confirm managed backup or point-in-time recovery is available for the production project.
- [ ] Capture a fresh logical backup immediately before migration.
- [ ] Capture global and per-user task counts, XP event counts, and XP totals.
- [ ] Restore the backup into an isolated Supabase project.
- [ ] Compare restored counts and totals byte-for-byte with the production baseline.
- [ ] Sign in to the restored application and confirm legacy records are usable.
- [ ] Record the tested recovery point and measured restore time.

## Migration Review

- [x] Apply `0002_weekly_plans_expand.sql` to isolated PostgreSQL 17 with `ON_ERROR_STOP=1`.
- [x] Run Supabase database lint with no schema errors.
- [x] Verify existing rows remain legacy/unassigned and counts/totals remain unchanged.
- [x] Verify first-plan, rollover, retry, conflict, immutability, RLS, and history isolation behavior.
- [x] Verify simultaneous identical and conflicting rollover requests.
- [ ] Obtain final human review of migration SQL and this checklist.
- [ ] Record the migration checksum that was reviewed and tested.

## One-Time Execution

- [ ] Confirm `0002` is not already recorded or partially applied in production.
- [ ] Confirm the command target hostname/project reference is production only after explicit approval.
- [ ] Apply `0002` once through the approved migration mechanism, not by editing `0001`.
- [ ] Stop immediately on any SQL error; do not rerun blindly.
- [ ] Run post-migration verification before deploying application code.
- [ ] Compare production post-migration counts and XP totals to the captured baseline.

## Application Deployment Order

- [ ] Apply additive `0002` while the old application is still live.
- [ ] Verify the old application can sign in and perform its existing legacy flow.
- [ ] Deploy the weekly-plan-aware application.
- [ ] Verify first plan creation, task completion/undo, rollover, history, and realtime updates.
- [ ] Observe errors and database metrics before planning the contract migration.
- [ ] Do not redeploy the old application after dated weekly-plan XP exists because it aggregates all events as one week.

## Rollback And Recovery

- [ ] Before any weekly-plan writes, define the application rollback and database restore decision point.
- [ ] After weekly-plan writes, prefer a forward fix; do not drop plan columns or tables.
- [ ] Preserve all new XP events and plan records during recovery.
- [ ] Document who can authorize managed restore versus forward repair.
- [ ] Test maintenance communication and expected downtime.

## Authentication And Security

- [x] Verify RPC execution is denied to `anon` and granted to `authenticated` only.
- [x] Verify RLS with two real local Auth sessions in both directions.
- [x] Verify security-definer functions use a fixed search path and validate ownership.
- [x] Verify completed plan/task/XP protection through RPC, authenticated direct calls, and owner-level trigger probes.
- [ ] Verify production Auth redirect URLs and email confirmation settings.
- [ ] Rotate or review production credentials according to operational policy; never place them in chat or source control.
- [ ] Decide and document account closure/anonymization policy before offering self-service deletion.

## Public Beta Contract

- [ ] After the new app is verified, create a separate contract migration.
- [ ] Revoke authenticated direct `INSERT` and `DELETE` on `tasks`.
- [ ] Remove obsolete task insert/delete policies.
- [ ] Revoke and remove `reset_task_completions` after confirming no deployed client uses it.
- [ ] Re-run current-app, weekly-plan, RLS, and realtime tests against the contracted schema.
- [ ] Apply the contract migration only with separate approval.
