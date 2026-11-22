begin;
create table tsols_private.analytics_oauth_grants(agency_id uuid not null references public.agencies(id),user_id uuid not null,provider text not null check(provider in ('google','ga4','search','bing')),grant_id text not null,secret_id uuid not null,created_at timestamptz not null default now(),primary key(agency_id,user_id,provider,grant_id));
alter table tsols_private.analytics_oauth_grants enable row level security;
revoke all on tsols_private.analytics_oauth_grants from public,anon,authenticated,service_role;
create function public.read_analytics_oauth_grant(target_agency uuid,target_user uuid,provider text,grant_id text default null) returns jsonb language sql security definer set search_path='' as $$select s.decrypted_secret::jsonb from tsols_private.analytics_oauth_grants g join vault.decrypted_secrets s on s.id=g.secret_id where g.agency_id=target_agency and g.user_id=target_user and g.provider=read_analytics_oauth_grant.provider and (read_analytics_oauth_grant.grant_id is null or g.grant_id=read_analytics_oauth_grant.grant_id) order by g.created_at desc limit 1;$$;
create function public.store_analytics_oauth_grant(target_agency uuid,target_user uuid,provider text,credential jsonb,expected_refresh text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare secret uuid;stored jsonb;
begin
 if provider not in ('google','ga4','search','bing') or nullif(credential->>'grant_id','') is null then raise exception 'Invalid provider';end if;
 perform pg_advisory_xact_lock(hashtextextended(target_agency::text||target_user::text||provider,0));
 select g.secret_id,s.decrypted_secret::jsonb into secret,stored from tsols_private.analytics_oauth_grants g join vault.decrypted_secrets s on s.id=g.secret_id where g.agency_id=target_agency and g.user_id=target_user and g.provider=store_analytics_oauth_grant.provider and g.grant_id=credential->>'grant_id';
 if expected_refresh is not null and (secret is null or stored->>'refresh_token' is distinct from expected_refresh) then return false;end if;
 if secret is null then secret:=vault.create_secret(credential::text,'analytics-grant:'||target_agency||':'||target_user||':'||provider||':'||(credential->>'grant_id'));insert into tsols_private.analytics_oauth_grants(agency_id,user_id,provider,grant_id,secret_id) values(target_agency,target_user,provider,credential->>'grant_id',secret);else perform vault.update_secret(secret,credential::text);end if;
 return true;
end;$$;
revoke all on function public.read_analytics_oauth_grant(uuid,uuid,text,text),public.store_analytics_oauth_grant(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.read_analytics_oauth_grant(uuid,uuid,text,text),public.store_analytics_oauth_grant(uuid,uuid,text,jsonb,text) to service_role;
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
   update public.website_analytics_connections set ga4_property_id=configuration->>'ga4_property_id',ga4_email=credential->>'client_email',ga4_auth_method=case when credential->>'type' in ('oauth','oauth_grant') then 'oauth' else 'key' end,ga4_verified_at=now(),updated_at=now() where client_id=target_client;
 elsif provider='search' then
   update public.website_analytics_connections set search_console_property=configuration->>'search_console_property',search_email=credential->>'client_email',search_auth_method=case when credential->>'type' in ('oauth','oauth_grant') then 'oauth' else 'key' end,search_verified_at=now(),updated_at=now() where client_id=target_client;
 else
   update public.website_analytics_connections set bing_site_url=configuration->>'bing_site_url',bing_verified_at=now(),bing_auth_method=case when credential->>'type' in ('oauth','oauth_grant') then 'oauth' else 'key' end,updated_at=now() where client_id=target_client;
 end if;
end; $$;
commit;
