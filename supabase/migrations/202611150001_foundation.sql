begin;

create type public.client_status as enum ('onboarding', 'active', 'paused', 'archived');

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (length(display_name) <= 160),
  created_at timestamptz not null default now()
);

create table public.agency_memberships (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'administrator' check (role = 'administrator'),
  created_at timestamptz not null default now(),
  primary key (agency_id, user_id)
);
create index agency_memberships_user_idx on public.agency_memberships(user_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete restrict,
  business_name text not null check (length(btrim(business_name)) between 1 and 160),
  industry text not null check (length(btrim(industry)) between 1 and 120),
  location text not null check (length(btrim(location)) between 1 and 180),
  description text,
  address text,
  contact_person text,
  contact_phone text,
  whatsapp_number text,
  contact_email text,
  website text check (website ~ '^https?://'),
  package_name text,
  monthly_service_fee_kes numeric(12,2) check (monthly_service_fee_kes >= 0),
  monthly_ad_budget_kes numeric(12,2) check (monthly_ad_budget_kes >= 0),
  onboarding_date date,
  internal_notes text,
  status public.client_status not null default 'onboarding',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'archived') = (archived_at is not null))
);
create index clients_agency_name_idx on public.clients(agency_id, lower(business_name));
create index clients_agency_status_idx on public.clients(agency_id, status);

create table public.client_memberships (
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'client_user' check (role = 'client_user'),
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index client_memberships_user_idx on public.client_memberships(user_id);

create table public.client_brand_profiles (
  client_id uuid primary key references public.clients(id) on delete cascade,
  brand_name text,
  language text,
  tone text,
  target_audience text,
  brand_colors text,
  logo_url text check (logo_url ~ '^https?://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.client_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  price_kes numeric(12,2) check (price_kes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index client_services_client_idx on public.client_services(client_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  client_id uuid not null references public.clients(id) on delete restrict,
  action text not null,
  created_at timestamptz not null default now()
);
create index audit_logs_agency_recent_idx on public.audit_logs(agency_id, created_at desc);

alter table public.agencies enable row level security;
alter table public.profiles enable row level security;
alter table public.agency_memberships enable row level security;
alter table public.client_memberships enable row level security;
alter table public.clients enable row level security;
alter table public.client_brand_profiles enable row level security;
alter table public.client_services enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.agencies, public.profiles, public.agency_memberships, public.client_memberships,
  public.clients, public.client_brand_profiles, public.client_services, public.audit_logs from anon, authenticated;
grant select on public.agencies, public.profiles, public.agency_memberships, public.client_memberships,
  public.clients, public.client_brand_profiles, public.client_services, public.audit_logs to authenticated;
grant insert (agency_id,business_name,industry,location,description,address,contact_person,contact_phone,
  whatsapp_number,contact_email,website,package_name,monthly_service_fee_kes,monthly_ad_budget_kes,onboarding_date,internal_notes,status)
  on public.clients to authenticated;
grant update (business_name,industry,location,description,address,contact_person,contact_phone,whatsapp_number,contact_email,
  website,package_name,monthly_service_fee_kes,monthly_ad_budget_kes,onboarding_date,internal_notes,status)
  on public.clients to authenticated;
grant insert (client_id,brand_name,language,tone,target_audience,brand_colors,logo_url),
  update (brand_name,language,tone,target_audience,brand_colors,logo_url)
  on public.client_brand_profiles to authenticated;
grant insert (client_id,name,price_kes), update (name,price_kes), delete on public.client_services to authenticated;

create policy own_profile on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy own_agency_membership on public.agency_memberships for select to authenticated using (user_id = (select auth.uid()));
create policy own_client_membership on public.client_memberships for select to authenticated using (user_id = (select auth.uid()));
create policy member_agency on public.agencies for select to authenticated using (
  exists (select 1 from public.agency_memberships m where m.agency_id = agencies.id and m.user_id = (select auth.uid()))
);
create policy admin_clients on public.clients for all to authenticated using (
  exists (select 1 from public.agency_memberships m where m.agency_id = clients.agency_id and m.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.agency_memberships m where m.agency_id = clients.agency_id and m.user_id = (select auth.uid()))
);
create policy admin_brand on public.client_brand_profiles for all to authenticated
  using (exists (select 1 from public.clients c where c.id = client_id))
  with check (exists (select 1 from public.clients c where c.id = client_id));
create policy admin_services on public.client_services for all to authenticated
  using (exists (select 1 from public.clients c where c.id = client_id))
  with check (exists (select 1 from public.clients c where c.id = client_id));
create policy admin_audit on public.audit_logs for select to authenticated using (
  exists (select 1 from public.agency_memberships m where m.agency_id = audit_logs.agency_id and m.user_id = (select auth.uid()))
);

create function public.assigned_businesses()
returns table (id uuid, business_name text, location text, industry text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.business_name, c.location, c.industry
  from public.client_memberships m join public.clients c on c.id = m.client_id
  where m.user_id = (select auth.uid()) and c.status <> 'archived'
  order by c.business_name
$$;
revoke all on function public.assigned_businesses() from public, anon;
grant execute on function public.assigned_businesses() to authenticated;

create function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger brand_updated before update on public.client_brand_profiles for each row execute function public.set_updated_at();
create trigger services_updated before update on public.client_services for each row execute function public.set_updated_at();

create function public.set_client_timestamps() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  if new.status = 'archived' then
    new.archived_at := coalesce(new.archived_at, now());
  else
    new.archived_at := null;
  end if;
  return new;
end;
$$;
create trigger client_timestamps before insert or update on public.clients for each row execute function public.set_client_timestamps();

create function public.log_client_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  tenant uuid;
  client uuid;
  event text;
begin
  if tg_table_name = 'clients' then
    tenant := new.agency_id;
    client := new.id;
    event := case when tg_op = 'INSERT' then 'Client created'
                  when new.status = 'archived' and old.status <> 'archived' then 'Client archived'
                  else 'Client details updated' end;
  else
    client := case when tg_op = 'DELETE' then old.client_id else new.client_id end;
    select c.agency_id into tenant from public.clients c where c.id = client;
    event := case when tg_table_name = 'client_brand_profiles' then 'Brand profile updated' else 'Client services updated' end;
  end if;
  if tenant is not null then
    insert into public.audit_logs (agency_id, actor_id, client_id, action)
      values (tenant, (select p.id from public.profiles p where p.id = auth.uid()), client, event);
  end if;
  return null;
end;
$$;
revoke all on function public.log_client_change() from public, anon, authenticated;
create trigger client_change after insert or update on public.clients for each row execute function public.log_client_change();
create trigger brand_change after insert or update on public.client_brand_profiles for each row execute function public.log_client_change();
create trigger service_change after insert or update or delete on public.client_services for each row execute function public.log_client_change();

commit;
