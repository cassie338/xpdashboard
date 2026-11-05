alter table public.weekly_plans
  add column inspirational_quote text not null default ''
  check (char_length(inspirational_quote) <= 280);

create function public.set_weekly_inspirational_quote(
  p_weekly_plan_id uuid,
  p_quote text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(coalesce(p_quote, ''))) > 280 then
    raise exception 'Inspirational quote must be 280 characters or fewer';
  end if;

  update public.weekly_plans
  set inspirational_quote = trim(coalesce(p_quote, ''))
  where id = p_weekly_plan_id and user_id = auth.uid() and status = 'published';
  if not found then raise exception 'Published weekly plan not found'; end if;
end;
$$;

revoke all on function public.set_weekly_inspirational_quote(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.set_weekly_inspirational_quote(uuid, text) to authenticated;
