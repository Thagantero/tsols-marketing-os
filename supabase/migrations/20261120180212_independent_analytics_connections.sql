begin;
alter table public.website_analytics_connections
 add column ga4_email text, add column search_email text,
 add column ga4_verified_at timestamptz, add column search_verified_at timestamptz;
update public.website_analytics_connections set ga4_email=case when ga4_property_id is not null then google_email end,
 search_email=case when search_console_property is not null then google_email end,
 ga4_verified_at=case when ga4_property_id is not null then google_verified_at end,
 search_verified_at=case when search_console_property is not null then google_verified_at end;
alter table tsols_private.website_analytics_credentials drop constraint website_analytics_credentials_provider_check;
alter table tsols_private.website_analytics_credentials add constraint website_analytics_credentials_provider_check check(provider in ('google','ga4','search','bing'));
create or replace function public.store_website_analytics_connection(target_client uuid,provider text,credential jsonb,configuration jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare secret uuid;
begin
 if provider not in ('google','ga4','search','bing') or credential is null then raise exception 'Invalid analytics provider'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_client::text,0));
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
 elsif provider='ga4' then
   update public.website_analytics_connections set ga4_property_id=configuration->>'ga4_property_id',ga4_email=credential->>'client_email',ga4_verified_at=now(),updated_at=now() where client_id=target_client;
 elsif provider='search' then
   update public.website_analytics_connections set search_console_property=configuration->>'search_console_property',search_email=credential->>'client_email',search_verified_at=now(),updated_at=now() where client_id=target_client;
 else
   update public.website_analytics_connections set bing_site_url=configuration->>'bing_site_url',bing_verified_at=now(),updated_at=now() where client_id=target_client;
 end if;
end; $$;
create or replace function public.read_website_analytics_credential(target_client uuid,provider text)
returns jsonb language sql security definer set search_path='' as $$
 select s.decrypted_secret::jsonb from tsols_private.website_analytics_credentials c
 join vault.decrypted_secrets s on s.id=c.secret_id
 where c.client_id=target_client and (c.provider=read_website_analytics_credential.provider or (read_website_analytics_credential.provider in ('ga4','search') and c.provider='google'))
 order by (c.provider=read_website_analytics_credential.provider) desc limit 1;
$$;
revoke all on function public.store_website_analytics_connection(uuid,text,jsonb,jsonb),public.read_website_analytics_credential(uuid,text) from public,anon,authenticated;
grant execute on function public.store_website_analytics_connection(uuid,text,jsonb,jsonb),public.read_website_analytics_credential(uuid,text) to service_role;
commit;
