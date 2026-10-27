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

The browser prototype is intentionally local-first. Authentication, PostgreSQL persistence, Supabase RLS, and adult/learner accounts are the next production step.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.
