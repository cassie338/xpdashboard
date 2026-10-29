# Account Closure And XP Retention

## Recommended policy

Closing an account should disable access and anonymize personal account data without deleting learning records or XP events. XP is an append-only effort ledger, so ordinary account closure must not erase or rewrite it.

Use these distinct operations:

- **Close account:** reversible administrative access shutdown. Block sign-in, revoke sessions, and mark the account closed.
- **Anonymize account:** irreversible removal of direct identifiers while retaining a random internal UUID and historical records.
- **Exceptional purge:** a separately authorized legal/privacy operation. It is not part of normal product behavior and must never be implemented as a client-callable RPC.

## Proposed implementation

Use a separate reviewed migration after weekly plans are deployed:

1. Add `closed_at`, `anonymized_at`, and `account_status` to account-level settings or a dedicated account lifecycle table.
2. Replace `ON DELETE CASCADE` references to `auth.users` with `ON DELETE RESTRICT` so an Auth administrator cannot accidentally erase tasks, plans, or ledger records.
3. Add an administrative server-side closure operation using the Supabase service role. Do not expose it directly to browser clients.
4. On closure, ban the Auth user, revoke active sessions, and prevent application access.
5. On anonymization, replace email and Auth metadata with generated non-identifying values and replace display names with a neutral tombstone label.
6. Keep UUIDs, weekly plans, tasks, and XP events unchanged. The UUID becomes pseudonymous and preserves ledger relationships.
7. Record who performed the closure/anonymization, when it occurred, and the reason category without storing unnecessary personal detail.

Task names may themselves contain personal information. A privacy review must decide whether they are retained as educational records, separately redacted through an auditable process, or covered by a retention period. XP events must not be silently rewritten as part of that decision.

## Current behavior

Hard deletion of an Auth user with XP fails because the cascade reaches `xp_events` and the append-only trigger rejects deletion. This protects the ledger but is not a complete account lifecycle design. Do not weaken the trigger to make Auth deletion succeed.

## Exceptional purge trade-off

If law or policy requires complete erasure, use an offline, explicitly authorized maintenance procedure with a verified backup, immutable audit record, and organization-level approval. Such a purge necessarily conflicts with permanent ledger retention. It must be designed and reviewed separately rather than bypassing triggers in an application RPC.
