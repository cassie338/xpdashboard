# XP Dashboard

A focused weekly effort dashboard for one family. A parent plans Monday-Sunday tasks and assigns XP. The learner can complete any task at any point during the week, and clearing every task assigned to a future day earns that day off.

## Current prototype

- Parent and learner views
- Monday-Sunday task planning
- Per-task XP
- History task category
- Automatic daily and weekly XP goals calculated from assigned tasks
- Learner-controlled completion undo with compensating XP events
- Parent-view household gate
- Reversible learner Sick Days that remove assigned XP from expected goals without removing optional tasks
- Full-screen daily-goal celebration with confetti
- Early-completion day-off recognition
- Append-only XP completion and correction events
- Local browser persistence
- Responsive child-friendly interface

The dashboard uses one shared Supabase family login so the parent and learner can use the same week from separate computers. Supabase Row Level Security keeps each account's tasks, settings, and append-only XP ledger private.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Supabase setup

1. Run `supabase/migrations/0001_shared_family_dashboard.sql` in the Supabase SQL Editor.
2. Run `npm run setup:supabase` and enter the public project URL and publishable key.
3. Create the shared family account from the app on the parent's existing browser first. The first login imports that browser's saved week.
4. Sign in with the same family account on the learner's computer.
