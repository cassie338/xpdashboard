create extension if not exists pgcrypto;

create table public.dashboard_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  learner_name text not null default 'My Learner' check (length(trim(learner_name)) between 1 and 80),
  sick_days text[] not null default '{}',
  initialized boolean not null default false,
  updated_at timestamptz not null default now(),
  check (sick_days <@ array['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']::text[])
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  category text not null check (category in ('Math', 'Reading', 'Writing', 'History', 'Life Skills', 'Creative')),
  day text not null check (day in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')),
  xp integer not null check (xp between 1 and 500),
  created_at timestamptz not null default now()
);

create table public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id),
  amount integer not null check (amount <> 0),
  reason text not null check (reason in ('task_completed', 'task_unchecked', 'week_reset')),
  earned_at timestamptz not null default now()
);

create index tasks_user_day_idx on public.tasks(user_id, day, created_at);
create index xp_events_user_earned_idx on public.xp_events(user_id, earned_at);
create index xp_events_task_idx on public.xp_events(task_id, earned_at);

alter table public.dashboard_settings enable row level security;
alter table public.tasks enable row level security;
alter table public.xp_events enable row level security;

create policy settings_select_own on public.dashboard_settings for select to authenticated using (user_id = auth.uid());
create policy settings_insert_own on public.dashboard_settings for insert to authenticated with check (user_id = auth.uid());
create policy settings_update_own on public.dashboard_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy tasks_select_own on public.tasks for select to authenticated using (user_id = auth.uid());
create policy tasks_insert_own on public.tasks for insert to authenticated with check (user_id = auth.uid());
create policy tasks_delete_own on public.tasks for delete to authenticated using (user_id = auth.uid());

create policy xp_events_select_own on public.xp_events for select to authenticated using (user_id = auth.uid());

grant select, insert, update on public.dashboard_settings to authenticated;
grant select, insert, delete on public.tasks to authenticated;
grant select on public.xp_events to authenticated;

create function public.create_dashboard_for_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.dashboard_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger create_dashboard_after_signup
after insert on auth.users
for each row execute function public.create_dashboard_for_user();

insert into public.dashboard_settings (user_id)
select id from auth.users
on conflict do nothing;

create function public.record_task_completion(p_task_id uuid, p_complete boolean)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  current_balance integer;
begin
  select * into task_record from public.tasks where id = p_task_id and user_id = auth.uid() for update;
  if not found then raise exception 'Task not found'; end if;

  select coalesce(sum(amount), 0)::integer into current_balance
  from public.xp_events where task_id = task_record.id and user_id = auth.uid();

  if p_complete and current_balance <= 0 then
    insert into public.xp_events (user_id, task_id, amount, reason)
    values (auth.uid(), task_record.id, task_record.xp, 'task_completed');
  elsif not p_complete and current_balance > 0 then
    insert into public.xp_events (user_id, task_id, amount, reason)
    values (auth.uid(), task_record.id, -task_record.xp, 'task_unchecked');
  end if;
end;
$$;

create function public.reset_task_completions()
returns void
language sql security definer set search_path = public, pg_temp
as $$
  insert into public.xp_events (user_id, task_id, amount, reason)
  select auth.uid(), t.id, (-sum(e.amount))::integer, 'week_reset'
  from public.tasks t
  join public.xp_events e on e.task_id = t.id and e.user_id = auth.uid()
  where t.user_id = auth.uid()
  group by t.id
  having sum(e.amount) > 0;
$$;

revoke insert, update, delete on public.xp_events from authenticated;
revoke update on public.tasks from authenticated;
revoke all on function public.record_task_completion(uuid, boolean) from public;
revoke all on function public.reset_task_completions() from public;
grant execute on function public.record_task_completion(uuid, boolean) to authenticated;
grant execute on function public.reset_task_completions() to authenticated;

alter publication supabase_realtime add table public.dashboard_settings;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.xp_events;
