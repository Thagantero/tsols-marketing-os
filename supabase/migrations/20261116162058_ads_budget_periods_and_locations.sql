begin;

alter table public.ad_campaigns
  alter column monthly_budget_kes drop not null,
  alter column end_date drop not null,
  add column budget_mode text not null default 'monthly',
  add column daily_budget_kes numeric(12,2),
  add column start_time time not null default '00:00',
  add column end_time time default '23:59',
  add column target_locations jsonb not null default '[]';

update public.ad_campaigns set target_locations=jsonb_build_array(jsonb_build_object('scope','local','name',target_location));

alter table public.ad_campaigns
  add constraint ad_campaign_budget_mode_check check (
    (budget_mode='monthly' and monthly_budget_kes is not null and daily_budget_kes is null) or
    (budget_mode='daily' and daily_budget_kes is not null and daily_budget_kes>0
      and (monthly_budget_kes is null or monthly_budget_kes>=daily_budget_kes))
  ),
  add constraint ad_campaign_period_check check (
    (end_date is null and end_time is null) or
    (end_date is not null and end_time is not null
      and (end_date>start_date or (end_date=start_date and end_time>start_time)))
  ),
  add constraint ad_campaign_location_shape_check check (jsonb_typeof(target_locations)='array');

grant insert(budget_mode,daily_budget_kes,start_time,end_time,target_locations),
  update(budget_mode,daily_budget_kes,start_time,end_time,target_locations) on public.ad_campaigns to authenticated;

create function tsols_private.ad_budget_in_month(plan public.ad_campaigns, month_start date)
returns numeric language sql immutable set search_path='' as $$
  select case when days<=0 then 0
    when (plan).budget_mode='monthly' then (plan).monthly_budget_kes
    else least(days*(plan).daily_budget_kes,coalesce((plan).monthly_budget_kes,days*(plan).daily_budget_kes))
  end
  from (
    select least(coalesce((plan).end_date,'infinity'::date),(month_start+interval '1 month')::date-1)
      - greatest((plan).start_date,month_start) + 1 as days
  ) active_days
$$;

create function tsols_private.peak_ad_budget(target_client uuid, excluded uuid, candidate public.ad_campaigns, first_month date, last_month date)
returns numeric language sql stable set search_path='' as $$
  with plans(plan) as (
    select p from public.ad_campaigns p where p.client_id=target_client and p.plan_status='approved'
      and p.id is distinct from excluded and (p.end_date is null or p.end_date>=first_month)
      and (last_month is null or p.start_date<(last_month+interval '1 month')::date)
    union all select candidate where (candidate).id is not null
  ), boundaries(month_start) as (
    select first_month
    union select date_trunc('month',(plan).start_date::timestamp)::date from plans
    union select date_trunc('month',(plan).end_date::timestamp)::date from plans where (plan).end_date is not null
  ), months(month_start) as (
    -- Outside start/end months the plan set stays constant. Every three consecutive
    -- whole months include a 31-day month, which bounds any daily allocation.
    select distinct (b.month_start+offset_month*interval '1 month')::date
      from boundaries b cross join generate_series(0,3) offset_month
  )
  select coalesce(max(totals.amount),0)
  from months
  cross join lateral(select coalesce(sum(tsols_private.ad_budget_in_month(plan,month_start)),0) as amount from plans) totals
  where month_start>=first_month and (last_month is null or month_start<=last_month)
$$;

create or replace function tsols_private.enforce_ad_plan() returns trigger
language plpgsql set search_path='' as $$
declare ceiling numeric; first_month date; last_month date; planned numeric;
begin
  if new.end_date is null then new.end_time:=null;
  elsif new.end_time is null then new.end_time:='23:59'; end if;

  if new.target_locations='[]'::jsonb or (tg_op='UPDATE' and new.target_locations=old.target_locations
    and new.target_location is distinct from old.target_location) then
    new.target_locations:=jsonb_build_array(jsonb_build_object('scope','local','name',btrim(new.target_location)));
  end if;
  if jsonb_typeof(new.target_locations) is distinct from 'array' then raise exception 'Enter a list of target locations.'; end if;
  if jsonb_array_length(new.target_locations) not between 1 and 30
    or exists(select 1 from jsonb_array_elements(new.target_locations) as item
      where jsonb_typeof(item) is distinct from 'object'
        or item->>'scope' is null or item->>'scope' not in ('local','country')
        or jsonb_typeof(item->'name') is distinct from 'string'
        or coalesce(length(btrim(item->>'name')),0) not between 1 and 240)
    or exists(select 1 from jsonb_array_elements(new.target_locations) as item
      group by item->>'scope',lower(btrim(item->>'name')) having count(*)>1) then
    raise exception 'Add one to 30 distinct city, region, or whole-country targets.';
  end if;
  new.target_location:=btrim(new.target_locations->0->>'name');

  if tg_op='INSERT' then return new; end if;
  if new.plan_status is distinct from old.plan_status
    and not ((old.plan_status='draft' and new.plan_status in ('approved','archived'))
      or (old.plan_status='approved' and new.plan_status='archived')) then
    raise exception 'This plan status change is unavailable.';
  end if;
  if (new.platform,new.name,new.objective,new.budget_mode,new.monthly_budget_kes,new.daily_budget_kes,
    new.start_date,new.start_time,new.end_date,new.end_time,new.target_locations,new.min_age,new.max_age,new.audience_gender,new.creative,new.external_campaign_id)
    is distinct from
    (old.platform,old.name,old.objective,old.budget_mode,old.monthly_budget_kes,old.daily_budget_kes,
    old.start_date,old.start_time,old.end_date,old.end_time,old.target_locations,old.min_age,old.max_age,old.audience_gender,old.creative,old.external_campaign_id) then
    if old.plan_status='archived' then raise exception 'Archived campaign plans are read-only.'; end if;
    if new.plan_status is distinct from old.plan_status then raise exception 'Save changes before approving a plan.'; end if;
    new.revision:=old.revision+1;
    new.plan_status:='draft';
  end if;
  if new.plan_status='approved' and old.plan_status<>'approved' then
    select monthly_ad_budget_kes into ceiling from public.clients where id=new.client_id and status<>'archived' for update;
    if ceiling is null then raise exception 'Set the client’s monthly advertising budget in Client Manager before approving a plan.'; end if;
    first_month:=date_trunc('month',new.start_date::timestamp)::date;
    last_month:=date_trunc('month',new.end_date::timestamp)::date;
    planned:=tsols_private.peak_ad_budget(new.client_id,new.id,new,first_month,last_month);
    if planned>ceiling then raise exception 'This plan would exceed the client’s monthly advertising budget in at least one month.'; end if;
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end;
$$;
drop trigger enforce_ad_plan on public.ad_campaigns;
create trigger enforce_ad_plan before insert or update on public.ad_campaigns
for each row execute function tsols_private.enforce_ad_plan();

create or replace function tsols_private.protect_client_ad_budget() returns trigger
language plpgsql set search_path='' as $$
declare peak numeric;
begin
  if new.monthly_ad_budget_kes is not distinct from old.monthly_ad_budget_kes then return new; end if;
  peak:=tsols_private.peak_ad_budget(new.id,null,null,date_trunc('month',now() at time zone 'Africa/Nairobi')::date,null);
  if peak>coalesce(new.monthly_ad_budget_kes,0) then raise exception 'The new budget is below an approved upcoming ad plan. Archive or revise the plan first.'; end if;
  return new;
end;
$$;

create or replace function public.ad_budget_for_month(target_client uuid,month_start date)
returns table(budget_limit numeric,approved_amount numeric) language sql stable security invoker set search_path='' as $$
  select c.monthly_ad_budget_kes,coalesce((
    select sum(tsols_private.ad_budget_in_month(p,date_trunc('month',month_start::timestamp)::date))
    from public.ad_campaigns p where p.client_id=c.id and p.plan_status='approved'
      and (p.end_date is null or p.end_date>=date_trunc('month',month_start::timestamp)::date)
      and p.start_date < (date_trunc('month',month_start::timestamp)+interval '1 month')::date
  ),0)
  from public.clients c where c.id=target_client
$$;

drop function tsols_private.max_planned_ad_budget(uuid,uuid,date,date);

commit;
