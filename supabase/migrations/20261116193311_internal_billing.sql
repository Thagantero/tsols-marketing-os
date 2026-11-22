begin;

create table public.billing_packages (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete restrict,
  name text not null check(length(btrim(name)) between 1 and 100),
  monthly_fee_kes numeric(12,2) not null check(monthly_fee_kes>=0),
  description text not null default '' check(length(description)<=800),
  active boolean not null default true
);
create unique index billing_packages_agency_name_idx on public.billing_packages(agency_id,lower(name));
insert into public.billing_packages(agency_id,name,monthly_fee_kes,description)
select a.id,p.name,p.fee,p.description from public.agencies a cross join (values
  ('TSOLS Starter',15000,'Client portal, 12 social posts per month, content calendar, weekly performance report.'),
  ('TSOLS Growth',35000,'Starter features, lead management, WhatsApp follow-up and agreed ad budget management up to KES 20,000.'),
  ('TSOLS Pro',60000,'Growth features, advanced advertising and reporting, two extra posters per week and a monthly strategy call.')
) p(name,fee,description);

create table public.billing_subscriptions (
  client_id uuid primary key references public.clients(id) on delete restrict,
  package_id uuid not null references public.billing_packages(id) on delete restrict,
  renewal_date date not null,
  status text not null check(status in ('active','paused','ended')),
  notes text not null default '' check(length(notes)<=1000),
  updated_at timestamptz not null default now()
);
create index billing_subscriptions_package_idx on public.billing_subscriptions(package_id);
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  client_name text not null,
  billing_month date not null check(extract(day from billing_month)=1),
  billed_on date not null,
  due_on date not null check(due_on>=billed_on),
  package_name text not null,
  service_fee_kes numeric(12,2) not null check(service_fee_kes>0),
  ad_budget_kes numeric(12,2) check(ad_budget_kes>=0),
  status text not null default 'unpaid' check(status in ('unpaid','paid','void')),
  payment_reference text check(length(btrim(payment_reference)) between 1 and 120),
  paid_on date check(paid_on>=billed_on),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(),
  check((status='paid')=(payment_reference is not null and paid_on is not null))
);
create unique index billing_invoices_active_month_idx on public.billing_invoices(client_id,billing_month) where status<>'void';
create index billing_invoices_client_month_idx on public.billing_invoices(client_id,billing_month desc);
create table public.billing_costs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete restrict,
  incurred_on date not null,
  description text not null check(length(btrim(description)) between 1 and 160),
  category text not null check(category in ('Software','Contractors','Production','Operations','Other')),
  amount_kes numeric(12,2) not null check(amount_kes>0),
  reference text check(length(reference)<=120),
  voided boolean not null default false,
  created_at timestamptz not null default now()
);
create index billing_costs_agency_date_idx on public.billing_costs(agency_id,incurred_on desc);

alter table public.billing_packages enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_costs enable row level security;
revoke all on public.billing_packages,public.billing_subscriptions,public.billing_invoices,public.billing_costs from public,anon,authenticated;
grant select on public.billing_packages,public.billing_subscriptions,public.billing_invoices,public.billing_costs to authenticated;
grant insert(agency_id,name,monthly_fee_kes,description),update(name,monthly_fee_kes,description,active) on public.billing_packages to authenticated;
grant insert(agency_id,incurred_on,description,category,amount_kes,reference),update(voided) on public.billing_costs to authenticated;
create policy billing_packages_admin on public.billing_packages for all to authenticated
using (exists(select 1 from public.agency_memberships m where m.agency_id=billing_packages.agency_id
  and m.user_id=(select auth.uid()) and m.role='administrator'))
with check (exists(select 1 from public.agency_memberships m where m.agency_id=billing_packages.agency_id
  and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy billing_costs_admin on public.billing_costs for all to authenticated
using (exists(select 1 from public.agency_memberships m where m.agency_id=billing_costs.agency_id
  and m.user_id=(select auth.uid()) and m.role='administrator'))
with check (exists(select 1 from public.agency_memberships m where m.agency_id=billing_costs.agency_id
  and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy billing_subscriptions_admin on public.billing_subscriptions for select to authenticated
using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=billing_subscriptions.client_id and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy billing_invoices_admin on public.billing_invoices for select to authenticated
using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=billing_invoices.client_id and m.user_id=(select auth.uid()) and m.role='administrator'));

create function tsols_private.save_billing_terms(target_client uuid,package_id uuid,fee numeric,
  ad_budget numeric,renewal date,subscription_status text,detail text)
returns void language plpgsql security definer set search_path='' as $$
declare business public.clients; plan public.billing_packages;
begin
  select c.* into business from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=target_client and c.status<>'archived' and m.user_id=auth.uid() and m.role='administrator'
  for no key update of c;
  if not found then raise exception 'This client is unavailable.' using errcode='42501';end if;
  select * into plan from public.billing_packages where id=package_id and agency_id=business.agency_id and active;
  if not found then raise exception 'Select an active package for this agency.';end if;
  update public.clients set package_name=plan.name,monthly_service_fee_kes=coalesce(fee,plan.monthly_fee_kes),
    monthly_ad_budget_kes=ad_budget where id=target_client;
  insert into public.billing_subscriptions(client_id,package_id,renewal_date,status,notes)
    values(target_client,package_id,renewal,subscription_status,btrim(coalesce(detail,'')))
    on conflict(client_id) do update set package_id=excluded.package_id,renewal_date=excluded.renewal_date,status=excluded.status,
      notes=excluded.notes,updated_at=clock_timestamp();
end;
$$;

create function tsols_private.issue_billing_invoice(target_client uuid,period date,issued date,due date,detail text)
returns uuid language plpgsql security definer set search_path='' as $$
declare business public.clients; invoice_id uuid;
begin
  select c.* into business from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=target_client and c.status<>'archived' and m.user_id=auth.uid() and m.role='administrator'
  for no key update of c;
  if not found then raise exception 'This client is unavailable.' using errcode='42501';end if;
  if business.package_name is null or coalesce(business.monthly_service_fee_kes,0)<=0 or not exists(
    select 1 from public.billing_subscriptions where client_id=target_client and status='active')
    then raise exception 'Save an active subscription with a positive service fee first.';end if;
  if issued>(now() at time zone 'Africa/Nairobi')::date then raise exception 'The invoice date cannot be in the future.'; end if;
  insert into public.billing_invoices(client_id,client_name,billing_month,billed_on,due_on,package_name,service_fee_kes,ad_budget_kes,notes)
    values(target_client,business.business_name,date_trunc('month',period::timestamp)::date,issued,due,business.package_name,
      business.monthly_service_fee_kes,business.monthly_ad_budget_kes,btrim(coalesce(detail,'')))
    returning id into invoice_id;
  return invoice_id;
exception when unique_violation then raise exception 'This client already has an invoice for that billing month.';
end;
$$;

create function tsols_private.complete_billing_invoice(invoice_id uuid,action text,reference text,payment_date date)
returns void language plpgsql security definer set search_path='' as $$
declare invoice public.billing_invoices; cleaned text:=nullif(btrim(reference),'');
begin
  select i.* into invoice from public.billing_invoices i join public.clients c on c.id=i.client_id
    join public.agency_memberships m on m.agency_id=c.agency_id
    where i.id=invoice_id and m.user_id=auth.uid() and m.role='administrator' for update of i;
  if not found then raise exception 'This invoice is unavailable.' using errcode='42501';end if;
  if invoice.status<>'unpaid' then raise exception 'Only an unpaid invoice can be updated.';end if;
  if action='pay' then
    if cleaned is null or payment_date is null or payment_date<invoice.billed_on
      or payment_date>(now() at time zone 'Africa/Nairobi')::date
      then raise exception 'Enter a payment reference and a payment date between the invoice date and today.';end if;
    update public.billing_invoices set status='paid',payment_reference=cleaned,paid_on=payment_date where id=invoice.id;
  elsif action='void' then update public.billing_invoices set status='void' where id=invoice.id;
  else raise exception 'Choose a billing action.';end if;
end;
$$;

create function public.save_billing_terms(target_client uuid,package_id uuid,fee numeric,
  ad_budget numeric,renewal date,subscription_status text,detail text)
returns void language sql set search_path='' as $$
  select tsols_private.save_billing_terms(target_client,package_id,fee,ad_budget,renewal,subscription_status,detail)
$$;
create function public.issue_billing_invoice(target_client uuid,period date,issued date,due date,detail text)
returns uuid language sql set search_path='' as $$
  select tsols_private.issue_billing_invoice(target_client,period,issued,due,detail)
$$;
create function public.complete_billing_invoice(invoice_id uuid,action text,reference text,payment_date date)
returns void language sql set search_path='' as $$
  select tsols_private.complete_billing_invoice(invoice_id,action,reference,payment_date)
$$;

create function public.billing_month_summary(target_agency uuid,period date)
returns jsonb language sql stable set search_path='' as $$
  with bounds as (
    select date_trunc('month',period::timestamp)::date first_day,
      (date_trunc('month',period::timestamp)+interval '1 month')::date next_month,
      (now() at time zone 'Africa/Nairobi')::date today
  ), invoiced as (
    select coalesce(sum(i.service_fee_kes) filter(where i.status<>'void'),0) billed,
      coalesce(sum(i.service_fee_kes) filter(where i.status='paid'),0) paid,
      coalesce(sum(i.service_fee_kes) filter(where i.status='unpaid'),0) unpaid,
      count(*) filter(where i.status='unpaid') open_invoices,
      count(*) filter(where i.status='unpaid' and i.due_on<b.today) overdue
    from public.billing_invoices i join public.clients c on c.id=i.client_id cross join bounds b
    where c.agency_id=target_agency and i.billing_month=b.first_day
  ), costs as (
    select coalesce(sum(o.amount_kes),0) expenses from public.billing_costs o cross join bounds b
    where o.agency_id=target_agency and not o.voided and o.incurred_on>=b.first_day and o.incurred_on<b.next_month
  )
  select jsonb_build_object('billed',billed,'paid',paid,'unpaid',unpaid,'open_invoices',open_invoices,'overdue',overdue,
    'costs',expenses,'margin',billed-expenses,'margin_pct',round(100*(billed-expenses)/nullif(billed,0),1))
  from invoiced cross join costs
$$;

create index billing_buffer_exceptions_idx on public.publishing_deliveries(client_id,submitted_at)
  where status in ('rejected','unknown') or provider_status='error';
create index billing_facebook_exceptions_idx on public.facebook_page_deliveries(client_id,created_at)
  where status in ('rejected','unknown');
create index billing_agent_exceptions_idx on public.agent_events(client_id,created_at) where event='failed';
create index billing_whatsapp_exceptions_idx on public.whatsapp_messages(client_id,updated_at)
  where status in ('failed','unknown');

create function public.billing_launch_exceptions(target_agency uuid)
returns jsonb language sql stable set search_path='' as $$
  with scoped as (select id from public.clients where agency_id=target_agency),
  since as (select now()-interval '7 days' cutoff)
  select jsonb_build_object(
    'publishing',(select count(*) from public.publishing_deliveries d join scoped c on c.id=d.client_id cross join since
      where d.submitted_at>=cutoff and (d.status in ('rejected','unknown') or d.provider_status='error')),
    'facebook',(select count(*) from public.facebook_page_deliveries d join scoped c on c.id=d.client_id cross join since
      where d.created_at>=cutoff and d.status in ('rejected','unknown')),
    'agents',(select count(*) from public.agent_events e join scoped c on c.id=e.client_id cross join since
      where e.created_at>=cutoff and e.event='failed'),
    'whatsapp',(select count(*) from public.whatsapp_messages w join scoped c on c.id=w.client_id cross join since
      where w.updated_at>=cutoff and w.status in ('failed','unknown'))
  )
$$;
revoke all on function public.billing_launch_exceptions(uuid) from public,anon;
grant execute on function public.billing_launch_exceptions(uuid) to authenticated;

-- Preserve the portal API while moving its privileged lookup out of the exposed schema.
create function tsols_private.assigned_businesses()
returns table(id uuid,business_name text,location text,industry text)
language sql stable security definer set search_path='' as $$
  select c.id,c.business_name,c.location,c.industry from public.client_memberships m
  join public.clients c on c.id=m.client_id where m.user_id=(select auth.uid()) and c.status<>'archived'
  order by c.business_name
$$;
create or replace function public.assigned_businesses()
returns table(id uuid,business_name text,location text,industry text)
language sql stable security invoker set search_path='' as $$
  select * from tsols_private.assigned_businesses()
$$;
revoke all on function tsols_private.assigned_businesses() from public,anon;
grant execute on function tsols_private.assigned_businesses() to authenticated;
do $guard$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public,anon,authenticated';
  end if;
end $guard$;

revoke all on function public.save_billing_terms(uuid,uuid,numeric,numeric,date,text,text),
  tsols_private.save_billing_terms(uuid,uuid,numeric,numeric,date,text,text),
  public.issue_billing_invoice(uuid,date,date,date,text),tsols_private.issue_billing_invoice(uuid,date,date,date,text),
  public.complete_billing_invoice(uuid,text,text,date),tsols_private.complete_billing_invoice(uuid,text,text,date),
  public.billing_month_summary(uuid,date) from public,anon;
grant execute on function public.save_billing_terms(uuid,uuid,numeric,numeric,date,text,text),
  tsols_private.save_billing_terms(uuid,uuid,numeric,numeric,date,text,text),
  public.issue_billing_invoice(uuid,date,date,date,text),tsols_private.issue_billing_invoice(uuid,date,date,date,text),
  public.complete_billing_invoice(uuid,text,text,date),tsols_private.complete_billing_invoice(uuid,text,text,date),
  public.billing_month_summary(uuid,date) to authenticated;
commit;
