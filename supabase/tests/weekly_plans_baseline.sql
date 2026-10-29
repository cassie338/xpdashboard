\set ON_ERROR_STOP on

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'weekly-test-one@example.invalid', crypt('local-test-only', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'weekly-test-two@example.invalid', crypt('local-test-only', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

update public.dashboard_settings
set learner_name = 'Development Learner',
    sick_days = array['Friday'],
    initialized = true
where user_id = '10000000-0000-0000-0000-000000000001';

insert into public.tasks (id, user_id, name, category, day, xp, created_at)
values
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Legacy Math', 'Math', 'Monday', 25, '2026-10-01T12:00:00Z'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Legacy Reading', 'Reading', 'Tuesday', 20, '2026-10-02T12:00:00Z'),
  ('22000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'Other User Task', 'Writing', 'Wednesday', 30, '2026-10-03T12:00:00Z');

insert into public.xp_events (id, user_id, task_id, amount, reason, earned_at)
values (
  '12000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  25,
  'task_completed',
  '2026-10-01T13:00:00Z'
);
