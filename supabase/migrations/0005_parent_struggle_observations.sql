-- Raw, parent-reported observations from parent-led work. These records retain
-- provenance for future analysis and never affect XP, completion, or mastery.

create table public.parent_struggle_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  learner_id uuid not null,
  task_id uuid not null,
  weekly_plan_id uuid not null,
  category text not null check (length(trim(category)) between 1 and 80),
  description text not null check (length(trim(description)) between 1 and 1000),
  provenance text not null default 'parent_reported' check (provenance = 'parent_reported'),
  recorded_at timestamptz not null default now(),
  foreign key (learner_id, user_id) references public.learners(id, user_id),
  foreign key (task_id, learner_id, user_id) references public.tasks(id, learner_id, user_id),
  foreign key (weekly_plan_id, learner_id, user_id) references public.weekly_plans(id, learner_id, user_id)
);

create index parent_struggles_task_recorded_idx
  on public.parent_struggle_observations(task_id, recorded_at desc);
create index parent_struggles_learner_recorded_idx
  on public.parent_struggle_observations(learner_id, recorded_at desc);

alter table public.parent_struggle_observations enable row level security;
create policy parent_struggles_select_own
  on public.parent_struggle_observations for select to authenticated
  using (user_id = auth.uid());
revoke all on public.parent_struggle_observations from anon, authenticated;
grant select on public.parent_struggle_observations to authenticated;
alter publication supabase_realtime add table public.parent_struggle_observations;

create function public.record_parent_struggle(p_task_id uuid, p_description text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  task_record public.tasks%rowtype;
  observation_id uuid;
  normalized_description text := trim(coalesce(p_description, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(normalized_description) not between 1 and 1000 then
    raise exception 'Struggle description must be between 1 and 1000 characters';
  end if;

  select t.* into task_record
  from public.tasks t
  join public.weekly_plans p on p.id = t.weekly_plan_id
  where t.id = p_task_id
    and t.user_id = auth.uid()
    and t.removed_at is null
    and t.support_mode = 'with_parent'
    and p.status = 'published';
  if not found then raise exception 'Current parent-led task not found'; end if;

  insert into public.parent_struggle_observations (
    user_id, learner_id, task_id, weekly_plan_id, category, description
  ) values (
    auth.uid(), task_record.learner_id, task_record.id,
    task_record.weekly_plan_id, task_record.category, normalized_description
  ) returning id into observation_id;

  return observation_id;
end;
$$;

revoke all on function public.record_parent_struggle(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_parent_struggle(uuid, text) to authenticated;
