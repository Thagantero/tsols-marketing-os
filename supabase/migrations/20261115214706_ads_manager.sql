begin;

create table public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  platform text not null check(platform in ('meta','google')),
  name text not null check(length(btrim(name)) between 1 and 160),
  objective text not null check(objective in ('Leads','Sales','Traffic','Awareness','Engagement')),
  monthly_budget_kes numeric(12,2) not null check(monthly_budget_kes>0),
  start_date date not null,
  end_date date not null check(end_date>=start_date),
  target_location text not null check(length(btrim(target_location)) between 1 and 240),
  min_age integer check(min_age between 18 and 65),
  max_age integer check(max_age between 18 and 65),
  audience_gender text not null default 'all' check(audience_gender in ('all','women','men')),
  creative text check(length(creative)<=3000),
  external_campaign_id text check(external_campaign_id ~ '^[0-9]{1,24}$'),
  plan_status text not null default 'draft' check(plan_status in ('draft','approved','archived')),
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(min_age is null or max_age is null or min_age<=max_age)
);
create index ad_campaigns_client_plan_idx on public.ad_campaigns(client_id,plan_status,start_date,end_date);
create index ad_campaigns_client_recent_idx on public.ad_campaigns(client_id,updated_at desc,id);

create table public.ad_plan_approvals (
  campaign_id uuid not null references public.ad_campaigns(id) on delete restrict,
  revision integer not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  plan jsonb not null,
  primary key(campaign_id,revision)
);

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  platform text not null check(platform in ('meta','google')),
  external_account_id text not null,
  label text not null check(length(btrim(label)) between 1 and 100),
  currency text check(currency ~ '^[A-Z]{3}$'),
  reporting_timezone text check(length(reporting_timezone)<=100),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique(platform,external_account_id),
  unique(id,client_id),
  check((platform='meta' and external_account_id ~ '^[0-9]{5,24}$')
    or (platform='google' and external_account_id ~ '^[0-9]{10}$'))
);
create index ad_accounts_client_idx on public.ad_accounts(client_id);

create table public.ad_performance_snapshots (
  account_id uuid not null,
  client_id uuid not null,
  external_campaign_id text not null check(external_campaign_id ~ '^[0-9]{1,24}$'),
  campaign_name text not null check(length(campaign_name) between 1 and 300),
  report_date date not null,
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  spend numeric(18,6) not null check(spend>=0),
  impressions bigint not null check(impressions>=0),
  reach bigint check(reach>=0),
  clicks bigint not null check(clicks>=0),
  leads numeric(18,6) check(leads>=0),
  conversions numeric(18,6),
  conversion_label text check(length(conversion_label)<=100),
  fx_rate_kes numeric(18,8) check(fx_rate_kes>0),
  fx_source text check(length(fx_source)<=160),
  fx_as_of date,
  spend_kes numeric(24,4) generated always as (spend*fx_rate_kes) stored,
  imported_at timestamptz not null default now(),
  primary key(account_id,external_campaign_id,report_date),
  foreign key(account_id,client_id) references public.ad_accounts(id,client_id) on delete restrict,
  check((fx_rate_kes is null and fx_source is null and fx_as_of is null)
    or (fx_rate_kes is not null and fx_source is not null and length(btrim(fx_source))>0 and fx_as_of is not null)),
  check(currency<>'KES' or (fx_rate_kes is not null and fx_rate_kes=1))
);
create index ad_snapshots_account_date_idx on public.ad_performance_snapshots(account_id,report_date desc,external_campaign_id);

create table public.ad_import_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  client_id uuid not null,
  date_from date not null,
  date_to date not null check(date_to>=date_from),
  row_count integer not null check(row_count>=0),
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(account_id,client_id) references public.ad_accounts(id,client_id) on delete restrict
);
create index ad_import_runs_account_idx on public.ad_import_runs(account_id,created_at desc);

alter table public.ad_campaigns enable row level security;
alter table public.ad_plan_approvals enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.ad_performance_snapshots enable row level security;
alter table public.ad_import_runs enable row level security;

revoke all on public.ad_campaigns,public.ad_plan_approvals,public.ad_accounts,public.ad_performance_snapshots,public.ad_import_runs from public,anon,authenticated;
grant select on public.ad_campaigns,public.ad_plan_approvals,public.ad_accounts,public.ad_performance_snapshots,public.ad_import_runs to authenticated;
grant insert(client_id,platform,name,objective,monthly_budget_kes,start_date,end_date,target_location,min_age,max_age,audience_gender,creative,external_campaign_id)
  on public.ad_campaigns to authenticated;
grant update(platform,name,objective,monthly_budget_kes,start_date,end_date,target_location,min_age,max_age,audience_gender,creative,external_campaign_id,plan_status)
  on public.ad_campaigns to authenticated;
grant insert(client_id,platform,external_account_id,label) on public.ad_accounts to authenticated;
grant select, update(currency,reporting_timezone,last_verified_at) on public.ad_accounts to service_role;
grant select,insert,update on public.ad_performance_snapshots to service_role;
grant insert on public.ad_import_runs to service_role;

create policy ad_plans_admin_read on public.ad_campaigns for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_campaigns.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_plans_admin_create on public.ad_campaigns for insert to authenticated with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_campaigns.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_plans_admin_update on public.ad_campaigns for update to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_campaigns.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_campaigns.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_approvals_admin_read on public.ad_plan_approvals for select to authenticated using (
  exists (select 1 from public.ad_campaigns p join public.clients c on c.id=p.client_id join public.agency_memberships m on m.agency_id=c.agency_id
    where p.id=ad_plan_approvals.campaign_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_accounts_admin_read on public.ad_accounts for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_accounts.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_accounts_admin_register on public.ad_accounts for insert to authenticated with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_accounts.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_snapshots_admin_read on public.ad_performance_snapshots for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_performance_snapshots.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy ad_runs_admin_read on public.ad_import_runs for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=ad_import_runs.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);

create function tsols_private.max_planned_ad_budget(target_client uuid, excluded uuid, first_month date, last_month date)
returns numeric language sql stable set search_path='' as $$
  with plans as (
    select monthly_budget_kes as amount,date_trunc('month',start_date::timestamp)::date as begins,end_date as closes
    from public.ad_campaigns where client_id=target_client and plan_status='approved'
      and id is distinct from excluded and end_date>=first_month
      and (last_month is null or date_trunc('month',start_date::timestamp)::date<=last_month)
  ), months as (
    select first_month as month_start
    union select begins from plans where begins>=first_month
  )
  select coalesce(max(totals.amount),0)
  from months
  cross join lateral(select coalesce(sum(amount),0) as amount from plans where begins<=month_start and closes>=month_start) totals
$$;

create function tsols_private.enforce_ad_plan() returns trigger
language plpgsql set search_path='' as $$
declare ceiling numeric; first_month date; last_month date; planned numeric;
begin
  if new.plan_status is distinct from old.plan_status
    and not ((old.plan_status='draft' and new.plan_status in ('approved','archived'))
      or (old.plan_status='approved' and new.plan_status='archived')) then
    raise exception 'This plan status change is unavailable.';
  end if;
  if (new.platform,new.name,new.objective,new.monthly_budget_kes,new.start_date,new.end_date,new.target_location,
    new.min_age,new.max_age,new.audience_gender,new.creative,new.external_campaign_id) is distinct from
    (old.platform,old.name,old.objective,old.monthly_budget_kes,old.start_date,old.end_date,old.target_location,
    old.min_age,old.max_age,old.audience_gender,old.creative,old.external_campaign_id) then
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
    planned:=tsols_private.max_planned_ad_budget(new.client_id,new.id,first_month,last_month);
    if planned+new.monthly_budget_kes>ceiling then raise exception 'This plan would exceed the client’s monthly advertising budget in at least one month.'; end if;
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end;
$$;
create trigger enforce_ad_plan before update on public.ad_campaigns for each row execute function tsols_private.enforce_ad_plan();

create function tsols_private.record_ad_approval() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.plan_status='approved' and old.plan_status<>'approved' then
    insert into public.ad_plan_approvals(campaign_id,revision,approved_by,plan)
    values(new.id,new.revision,auth.uid(),to_jsonb(new));
  end if;
  return null;
end;
$$;
revoke all on function tsols_private.record_ad_approval() from public,anon,authenticated;
create trigger record_ad_plan_approval after update on public.ad_campaigns for each row execute function tsols_private.record_ad_approval();

create function tsols_private.protect_client_ad_budget() returns trigger
language plpgsql set search_path='' as $$
declare peak numeric;
begin
  if new.monthly_ad_budget_kes is not distinct from old.monthly_ad_budget_kes then return new; end if;
  peak:=tsols_private.max_planned_ad_budget(new.id,null,date_trunc('month',now() at time zone 'Africa/Nairobi')::date,null);
  if peak>coalesce(new.monthly_ad_budget_kes,0) then raise exception 'The new budget is below an approved upcoming ad plan. Archive or revise the plan first.'; end if;
  return new;
end;
$$;
create trigger protect_ad_budget before update of monthly_ad_budget_kes on public.clients for each row execute function tsols_private.protect_client_ad_budget();

create function public.ingest_ad_performance(target_account uuid, operator_id uuid, source_currency text, reporting_zone text,
  from_date date, to_date date, rate_kes numeric, rate_source text, rate_date date, snapshot_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare account public.ad_accounts; count_rows integer; stamp timestamptz:=clock_timestamp();
begin
  if from_date is null or to_date is null or to_date<from_date or to_date-from_date>30
    or source_currency !~ '^[A-Z]{3}$' or jsonb_typeof(snapshot_rows)<>'array' or jsonb_array_length(snapshot_rows)>5000
    then raise exception 'Invalid performance import.'; end if;
  select * into account from public.ad_accounts where id=target_account for update;
  if not found then raise exception 'Account is unavailable.'; end if;
  if account.currency is not null and account.currency<>source_currency then raise exception 'The account currency changed. Review the connection before importing.'; end if;
  if exists (select 1 from jsonb_to_recordset(snapshot_rows) as x(report_date date) where x.report_date is null or x.report_date not between from_date and to_date)
    then raise exception 'A snapshot is outside the requested date range.'; end if;
  if source_currency='KES' then
    rate_kes:=1;rate_source:='Account currency is KES';
  elsif rate_kes is not null and (rate_kes<=0 or nullif(btrim(rate_source),'') is null or rate_date is null) then
    raise exception 'A conversion rate requires a source and effective date.';
  end if;
  insert into public.ad_performance_snapshots as previous(
    account_id,client_id,external_campaign_id,campaign_name,report_date,currency,spend,impressions,reach,clicks,leads,conversions,
    conversion_label,fx_rate_kes,fx_source,fx_as_of,imported_at
  ) select account.id,account.client_id,x.external_campaign_id,x.campaign_name,x.report_date,source_currency,
    x.spend,x.impressions,x.reach,x.clicks,x.leads,x.conversions,x.conversion_label,rate_kes,
    case when rate_kes is not null then rate_source end,case when source_currency='KES' then x.report_date when rate_kes is not null then rate_date end,stamp
  from jsonb_to_recordset(snapshot_rows) as x(external_campaign_id text,campaign_name text,report_date date,spend numeric,
    impressions bigint,reach bigint,clicks bigint,leads numeric,conversions numeric,conversion_label text)
  on conflict(account_id,external_campaign_id,report_date) do update set
    campaign_name=excluded.campaign_name,spend=excluded.spend,impressions=excluded.impressions,reach=excluded.reach,
    clicks=excluded.clicks,leads=excluded.leads,conversions=excluded.conversions,conversion_label=excluded.conversion_label,
    fx_rate_kes=coalesce(excluded.fx_rate_kes,previous.fx_rate_kes),
    fx_source=coalesce(excluded.fx_source,previous.fx_source),fx_as_of=coalesce(excluded.fx_as_of,previous.fx_as_of),
    imported_at=excluded.imported_at;
  get diagnostics count_rows=row_count;
  update public.ad_accounts set currency=source_currency,reporting_timezone=reporting_zone,last_verified_at=stamp where id=account.id;
  insert into public.ad_import_runs(account_id,client_id,date_from,date_to,row_count,imported_by)
  values(account.id,account.client_id,from_date,to_date,count_rows,operator_id);
  return count_rows;
end;
$$;
revoke all on function public.ingest_ad_performance(uuid,uuid,text,text,date,date,numeric,text,date,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_ad_performance(uuid,uuid,text,text,date,date,numeric,text,date,jsonb) to service_role;

create function public.ad_performance_summary(target_account uuid,from_date date,to_date date)
returns table(row_count bigint,native_spend numeric,reported_spend_kes numeric,missing_fx bigint,impressions numeric,clicks numeric,leads numeric,lead_rows bigint,conversions numeric)
language sql stable security invoker set search_path='' as $$
  select count(*),sum(s.spend),sum(s.spend_kes),count(*) filter(where s.spend_kes is null),
    sum(s.impressions),sum(s.clicks),sum(s.leads),count(s.leads),sum(s.conversions)
  from public.ad_performance_snapshots s where s.account_id=target_account and s.report_date between from_date and to_date
$$;
revoke all on function public.ad_performance_summary(uuid,date,date) from public,anon;
grant execute on function public.ad_performance_summary(uuid,date,date) to authenticated;

create function public.ad_budget_for_month(target_client uuid,month_start date)
returns table(budget_limit numeric,approved_amount numeric) language sql stable security invoker set search_path='' as $$
  select c.monthly_ad_budget_kes,coalesce((
    select sum(p.monthly_budget_kes) from public.ad_campaigns p
    where p.client_id=c.id and p.plan_status='approved' and p.end_date>=month_start
      and p.start_date < (month_start+interval '1 month')
  ),0)
  from public.clients c where c.id=target_client
$$;
revoke all on function public.ad_budget_for_month(uuid,date) from public,anon;
grant execute on function public.ad_budget_for_month(uuid,date) to authenticated;

commit;
