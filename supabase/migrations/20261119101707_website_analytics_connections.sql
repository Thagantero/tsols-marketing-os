begin;
create table public.website_analytics_connections (
 client_id uuid primary key references public.clients(id) on delete restrict,
 ga4_property_id text check(ga4_property_id ~ '^[0-9]{1,20}$'),
 search_console_property text check(length(search_console_property)<=500),
 bing_site_url text check(length(bing_site_url)<=500 and bing_site_url ~ '^https?://'),
 google_email text,
 google_verified_at timestamptz,
 bing_verified_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.website_analytics_connections enable row level security;
revoke all on public.website_analytics_connections from public,anon,authenticated;
grant select on public.website_analytics_connections to authenticated;
grant select,insert,update on public.website_analytics_connections to service_role;
create policy website_analytics_admin_read on public.website_analytics_connections for select to authenticated using (
 exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
 where c.id=website_analytics_connections.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create table tsols_private.website_analytics_credentials(
 client_id uuid not null references public.clients(id) on delete restrict,
 provider text not null check(provider in ('google','bing')),
 secret_id uuid not null,
 primary key(client_id,provider)
);
alter table tsols_private.website_analytics_credentials enable row level security;
revoke all on tsols_private.website_analytics_credentials from public,anon,authenticated,service_role;
create function public.store_website_analytics_connection(target_client uuid,provider text,credential jsonb,configuration jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare secret uuid;
begin
 if provider not in ('google','bing') or credential is null then raise exception 'Invalid analytics provider'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_client::text||provider,0));
 select c.secret_id into secret from tsols_private.website_analytics_credentials c where c.client_id=target_client and c.provider=store_website_analytics_connection.provider;
 if secret is null then
   secret:=vault.create_secret(credential::text,'website-analytics:'||target_client::text||':'||provider);
   insert into tsols_private.website_analytics_credentials values(target_client,provider,secret);
 else perform vault.update_secret(secret,credential::text); end if;
 insert into public.website_analytics_connections(client_id) values(target_client) on conflict do nothing;
 if provider='google' then
   update public.website_analytics_connections set ga4_property_id=nullif(configuration->>'ga4_property_id',''),
    search_console_property=nullif(configuration->>'search_console_property',''),google_email=credential->>'client_email',
    google_verified_at=now(),updated_at=now() where client_id=target_client;
 else
   update public.website_analytics_connections set bing_site_url=configuration->>'bing_site_url',bing_verified_at=now(),updated_at=now() where client_id=target_client;
 end if;
end; $$;
create function public.read_website_analytics_credential(target_client uuid,provider text)
returns jsonb language sql security definer set search_path='' as $$
 select s.decrypted_secret::jsonb from tsols_private.website_analytics_credentials c
 join vault.decrypted_secrets s on s.id=c.secret_id where c.client_id=target_client and c.provider=read_website_analytics_credential.provider;
$$;
revoke all on function public.store_website_analytics_connection(uuid,text,jsonb,jsonb),public.read_website_analytics_credential(uuid,text) from public,anon,authenticated;
grant execute on function public.store_website_analytics_connection(uuid,text,jsonb,jsonb),public.read_website_analytics_credential(uuid,text) to service_role;
commit;
