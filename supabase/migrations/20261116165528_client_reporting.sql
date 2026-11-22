begin;

alter table public.publishing_deliveries add column provider_sent_at timestamptz;
create index publishing_client_sent_idx on public.publishing_deliveries(client_id,provider_sent_at)
  where provider_sent_at is not null and provider_status='sent';

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  client_name text not null,
  recipient_email text,
  cadence text not null check(cadence in ('weekly','monthly')),
  period_start date not null,
  period_end date not null check(period_end>=period_start),
  partial_period boolean not null default false,
  version integer not null check(version>0),
  metrics jsonb not null check(jsonb_typeof(metrics)='object'),
  observations text not null default '' check(length(observations)<=4000),
  action_plan text not null default '' check(length(action_plan)<=4000),
  status text not null default 'draft' check(status in ('draft','approved','archived')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id,cadence,period_start,version),
  unique(id,client_id)
);
create index reports_client_recent_idx on public.reports(client_id,period_start desc,created_at desc);

create table public.report_deliveries (
  report_id uuid primary key,
  client_id uuid not null,
  recipient_email text not null,
  status text not null default 'sending' check(status in ('sending','accepted','failed','unknown')),
  provider_id text,
  attempt_count integer not null default 1 check(attempt_count between 1 and 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(report_id,client_id) references public.reports(id,client_id) on delete restrict,
  check((status='accepted')=(provider_id is not null))
);
create index report_deliveries_client_idx on public.report_deliveries(client_id,created_at desc);

alter table public.reports enable row level security;
alter table public.report_deliveries enable row level security;
revoke all on public.reports,public.report_deliveries from public,anon,authenticated;
grant select on public.reports,public.report_deliveries to authenticated;
grant update(observations,action_plan,status) on public.reports to authenticated;
grant select,insert,update on public.report_deliveries to service_role;
grant select on public.reports to service_role;

create policy report_admin_read on public.reports for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=reports.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy report_admin_review on public.reports for update to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=reports.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=reports.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy report_delivery_admin_read on public.report_deliveries for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=report_deliveries.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);

create function tsols_private.guard_report_review() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.status<>'draft' and (new.observations,new.action_plan) is distinct from (old.observations,old.action_plan) then
    raise exception 'Create a new report version to revise an approved report.';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status='draft' and new.status in ('approved','archived'))
      or (old.status='approved' and new.status='archived')) then
      raise exception 'This report status change is unavailable.';
    end if;
    if new.status='approved' then
      if (new.observations,new.action_plan) is distinct from (old.observations,old.action_plan) then
        raise exception 'Save the report notes before approving.';
      end if;
      new.approved_at:=clock_timestamp();
      new.approved_by:=auth.uid();
    elsif exists(select 1 from public.report_deliveries d where d.report_id=old.id and d.status='sending') then
      raise exception 'Wait until the email delivery request finishes before archiving.';
    end if;
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end;
$$;
create trigger guard_report_review before update on public.reports for each row execute function tsols_private.guard_report_review();

create function tsols_private.build_client_report(target_client uuid, report_cadence text, anchor_date date, operator_id uuid, only_if_missing boolean)
returns uuid language plpgsql set search_path='' as $$
declare
  client public.clients;
  first_day date;
  full_end date;
  last_day date;
  today date:=date_trunc('day',now() at time zone 'Africa/Nairobi')::date;
  from_stamp timestamptz;
  to_stamp timestamptz;
  report_version integer;
  saved_id uuid;
  captured jsonb;
begin
  if report_cadence is null or report_cadence not in ('weekly','monthly') or anchor_date is null or anchor_date>today or anchor_date<'2000-01-01' then
    raise exception 'Choose a valid weekly or monthly reporting date.';
  end if;
  select * into client from public.clients where id=target_client and status<>'archived' for update;
  if not found then raise exception 'This report client is unavailable.'; end if;
  first_day:=case when report_cadence='weekly' then date_trunc('week',anchor_date::timestamp)::date
    else date_trunc('month',anchor_date::timestamp)::date end;
  full_end:=case when report_cadence='weekly' then first_day+6 else (first_day+interval '1 month')::date-1 end;
  last_day:=least(full_end,today);
  from_stamp:=first_day::timestamp at time zone 'Africa/Nairobi';
  to_stamp:=(last_day+1)::timestamp at time zone 'Africa/Nairobi';

  select id,version into saved_id,report_version from public.reports
    where client_id=target_client and cadence=report_cadence and period_start=first_day
    order by version desc limit 1;
  if only_if_missing and saved_id is not null and exists(
    select 1 from public.reports where id=saved_id and not partial_period
  ) then return saved_id; end if;

  with publishing as (
    select
      count(distinct content_id) filter(where provider_status='sent' and provider_sent_at>=from_stamp and provider_sent_at<to_stamp) as posts,
      count(*) filter(where provider_status='sent' and provider_sent_at>=from_stamp and provider_sent_at<to_stamp) as sent,
      count(*) filter(where (status='rejected' or provider_status='error') and coalesce(due_at,submitted_at)>=from_stamp and coalesce(due_at,submitted_at)<to_stamp) as failed,
      count(*) filter(where (status in ('sending','unknown') or (status='submitted' and coalesce(provider_status,'') not in ('sent','error','cancelled')))
        and coalesce(due_at,submitted_at)>=from_stamp and coalesce(due_at,submitted_at)<to_stamp) as unresolved,
      count(*) filter(where provider_status='sent' and provider_sent_at is null and coalesce(due_at,submitted_at)>=from_stamp
        and coalesce(due_at,submitted_at)<to_stamp) as undated,
      exists(select 1 from public.publishing_accounts a where a.client_id=target_client) as linked
    from public.publishing_deliveries where client_id=target_client
  ), lead_totals as (
    select (select count(*) from public.leads l where l.client_id=target_client and l.created_at>=from_stamp and l.created_at<to_stamp) as new_leads,
      (select count(distinct a.lead_id) from public.lead_activities a where a.client_id=target_client
        and a.action='Status updated' and right(a.detail,length(' → qualified'))=' → qualified'
        and a.created_at>=from_stamp and a.created_at<to_stamp) as qualified
  ), ads_rows as (
    select s.* from public.ad_performance_snapshots s where s.client_id=target_client and s.report_date between first_day and last_day
  ), ads as (
    select count(*) as snapshots,count(spend_kes) as with_kes,count(leads) as with_leads,
      sum(spend_kes) as spend_kes,sum(impressions) as impressions,sum(clicks) as clicks,sum(leads) as leads
    from ads_rows
  ), native_totals as (
    select coalesce(jsonb_agg(jsonb_build_object('currency',currency,'amount',amount) order by currency),'[]'::jsonb) as totals
    from (select currency,sum(spend) as amount from ads_rows group by currency) grouped
  ), top_campaigns as (
    select coalesce(jsonb_agg(to_jsonb(r) order by clicks desc,external_campaign_id,account_label),'[]'::jsonb) as top_rows
    from (
      select s.external_campaign_id,max(s.campaign_name) as name,a.label as account_label,a.platform,s.currency,
        sum(s.spend) as native_spend,sum(s.impressions) as impressions,sum(s.clicks) as clicks
      from ads_rows s join public.ad_accounts a on a.id=s.account_id and a.client_id=s.client_id
      group by s.account_id,s.external_campaign_id,s.currency,a.label,a.platform
      order by sum(s.clicks) desc,s.external_campaign_id,a.label limit 5
    ) r
  )
  select jsonb_build_object(
    'posts_published',case when p.linked then p.posts end,
    'confirmed_deliveries',case when p.linked then p.sent end,
    'failed_deliveries',case when p.linked then p.failed end,
    'unresolved_deliveries',p.unresolved,
    'undated_deliveries',p.undated,
    'success_rate',case when p.sent+p.failed>0 then round(p.sent*100.0/(p.sent+p.failed),2) end,
    'new_leads',l.new_leads,'qualified_leads',l.qualified,
    'ad_snapshots',a.snapshots,'missing_fx_rows',a.snapshots-a.with_kes,
    'ad_spend_kes',case when a.snapshots>0 and a.with_kes=a.snapshots then a.spend_kes end,
    'ad_impressions',a.impressions,'ad_clicks',a.clicks,
    'ad_leads',case when a.with_leads=a.snapshots then a.leads end,
    'cost_per_ad_lead',case when a.snapshots>0 and a.with_kes=a.snapshots and a.with_leads=a.snapshots and a.leads>0
      then round(a.spend_kes/a.leads,2) end,
    'ad_native_spend',n.totals,'top_campaigns',t.top_rows,
    'organic_reach',null,'organic_impressions',null,'organic_engagement',null,'audience_growth',null,'best_post',null
  ) into captured from publishing p cross join lead_totals l cross join ads a cross join native_totals n cross join top_campaigns t;

  insert into public.reports(client_id,client_name,recipient_email,cadence,period_start,period_end,partial_period,version,metrics,created_by)
    values(client.id,client.business_name,nullif(lower(btrim(client.contact_email)),''),report_cadence,
      first_day,last_day,full_end>=today,coalesce(report_version,0)+1,captured,operator_id)
    returning id into saved_id;
  return saved_id;
end;
$$;
revoke all on function tsols_private.build_client_report(uuid,text,date,uuid,boolean) from public,anon,authenticated;

create function tsols_private.request_client_report(target_client uuid, report_cadence text, anchor_date date)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=target_client and c.status<>'archived' and m.user_id=auth.uid() and m.role='administrator'
  ) then raise exception 'This report client is unavailable.'; end if;
  return tsols_private.build_client_report(target_client,report_cadence,anchor_date,auth.uid(),false);
end;
$$;
revoke all on function tsols_private.request_client_report(uuid,text,date) from public,anon;
grant execute on function tsols_private.request_client_report(uuid,text,date) to authenticated;

create function public.create_client_report(target_client uuid,report_cadence text,anchor_date date)
returns uuid language sql security invoker set search_path='' as $$
  select tsols_private.request_client_report(target_client,report_cadence,anchor_date)
$$;
revoke all on function public.create_client_report(uuid,text,date) from public,anon;
grant execute on function public.create_client_report(uuid,text,date) to authenticated;

create function tsols_private.generate_due_client_reports(report_cadence text)
returns integer language plpgsql security invoker set search_path='' as $$
declare tenant record; anchor date; created integer:=0;
begin
  if report_cadence='weekly' then
    anchor:=date_trunc('week',now() at time zone 'Africa/Nairobi')::date-1;
  elsif report_cadence='monthly' then
    anchor:=date_trunc('month',now() at time zone 'Africa/Nairobi')::date-1;
  else raise exception 'Choose weekly or monthly reports.'; end if;
  for tenant in select id from public.clients where status='active' order by id loop
    perform tsols_private.build_client_report(tenant.id,report_cadence,anchor,null,true);
    created:=created+1;
  end loop;
  return created;
end;
$$;
revoke all on function tsols_private.generate_due_client_reports(text) from public,anon,authenticated;

create function tsols_private.validate_report_delivery() returns trigger
language plpgsql set search_path='' as $$
declare verified_email text; current_email text;
begin
  if new.status<>'sending' then return new; end if;
  if tg_op='UPDATE' and not (old.status='failed' and old.attempt_count=1 and new.attempt_count=2) then
    raise exception 'This report delivery is not eligible for retry.';
  end if;
  select r.recipient_email,lower(btrim(c.contact_email)) into verified_email,current_email
    from public.reports r join public.clients c on c.id=r.client_id
    where r.id=new.report_id and r.client_id=new.client_id and r.status='approved' and c.status<>'archived'
    for update of r;
  if verified_email is null or verified_email is distinct from current_email or verified_email is distinct from new.recipient_email then
    raise exception 'Approve a report with the client’s current email before delivery.';
  end if;
  return new;
end;
$$;
grant update(updated_at) on public.reports to service_role;
grant select(id,status,contact_email) on public.clients to service_role;
create trigger validate_report_delivery before insert or update of status on public.report_deliveries
for each row execute function tsols_private.validate_report_delivery();

commit;
