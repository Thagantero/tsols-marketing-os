begin;
alter table public.website_analytics_connections add column ga4_auth_method text not null default 'key' check(ga4_auth_method in ('key','oauth')),add column search_auth_method text not null default 'key' check(search_auth_method in ('key','oauth')),add column bing_auth_method text not null default 'key' check(bing_auth_method in ('key','oauth'));

create table tsols_private.analytics_oauth_apps(agency_id uuid not null references public.agencies(id),provider text not null check(provider in ('google','bing')),secret_id uuid not null,primary key(agency_id,provider));
create table tsols_private.analytics_oauth_states(state_hash text primary key check(length(state_hash)=64),user_id uuid not null,client_id uuid not null references public.clients(id),payload jsonb not null,expires_at timestamptz not null default now()+interval '10 minutes');
create index analytics_oauth_states_expiry on tsols_private.analytics_oauth_states(expires_at);
alter table tsols_private.analytics_oauth_apps enable row level security;
alter table tsols_private.analytics_oauth_states enable row level security;
revoke all on tsols_private.analytics_oauth_apps,tsols_private.analytics_oauth_states from public,anon,authenticated,service_role;
create function public.store_analytics_oauth_app(target_agency uuid,provider text,credential jsonb) returns void language plpgsql security definer set search_path='' as $$
declare secret uuid;
begin
 if provider not in ('google','bing') or nullif(credential->>'client_id','') is null or nullif(credential->>'client_secret','') is null then raise exception 'Invalid OAuth app';end if;
 perform pg_advisory_xact_lock(hashtextextended(target_agency::text||provider,0));
 select a.secret_id into secret from tsols_private.analytics_oauth_apps a where a.agency_id=target_agency and a.provider=store_analytics_oauth_app.provider;
 if secret is null then secret:=vault.create_secret(credential::text,'analytics-oauth-app:'||target_agency||':'||provider);insert into tsols_private.analytics_oauth_apps values(target_agency,provider,secret);
 else perform vault.update_secret(secret,credential::text);end if;
end;$$;
create function public.read_analytics_oauth_app(target_agency uuid,provider text) returns jsonb language sql security definer set search_path='' as $$
 select s.decrypted_secret::jsonb from tsols_private.analytics_oauth_apps a join vault.decrypted_secrets s on s.id=a.secret_id where a.agency_id=target_agency and a.provider=read_analytics_oauth_app.provider;
$$;
create function public.issue_analytics_oauth_state(state_hash text,target_user uuid,target_client uuid,payload jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(target_user::text,0));
 delete from tsols_private.analytics_oauth_states where expires_at<now();
 if (select count(*) from tsols_private.analytics_oauth_states where user_id=target_user)>=10 then raise exception 'Too many connection attempts. Wait ten minutes.';end if;
 insert into tsols_private.analytics_oauth_states(state_hash,user_id,client_id,payload) values(state_hash,target_user,target_client,payload);
end;$$;
create function public.consume_analytics_oauth_state(state_hash text,target_user uuid,target_client uuid) returns jsonb language sql security definer set search_path='' as $$
 delete from tsols_private.analytics_oauth_states s where s.state_hash=consume_analytics_oauth_state.state_hash and s.user_id=target_user and s.client_id=target_client and s.expires_at>now() returning payload;
$$;
create function public.rotate_website_analytics_token(target_client uuid,provider text,expected_refresh text,new_token jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare secret uuid;stored jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(target_client::text,0));
 select c.secret_id,s.decrypted_secret::jsonb into secret,stored from tsols_private.website_analytics_credentials c join vault.decrypted_secrets s on s.id=c.secret_id where c.client_id=target_client and c.provider=rotate_website_analytics_token.provider;
 if secret is null or stored->>'refresh_token' is distinct from expected_refresh then return false;end if;
 perform vault.update_secret(secret,(stored||new_token)::text);return true;
end;$$;
revoke all on function public.store_analytics_oauth_app(uuid,text,jsonb),public.read_analytics_oauth_app(uuid,text),public.issue_analytics_oauth_state(text,uuid,uuid,jsonb),public.consume_analytics_oauth_state(text,uuid,uuid),public.rotate_website_analytics_token(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_analytics_oauth_app(uuid,text,jsonb),public.read_analytics_oauth_app(uuid,text),public.issue_analytics_oauth_state(text,uuid,uuid,jsonb),public.consume_analytics_oauth_state(text,uuid,uuid),public.rotate_website_analytics_token(uuid,text,text,jsonb) to service_role;
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
   update public.website_analytics_connections set ga4_property_id=configuration->>'ga4_property_id',ga4_email=credential->>'client_email',ga4_auth_method=case when credential->>'type'='oauth' then 'oauth' else 'key' end,ga4_verified_at=now(),updated_at=now() where client_id=target_client;
 elsif provider='search' then
   update public.website_analytics_connections set search_console_property=configuration->>'search_console_property',search_email=credential->>'client_email',search_auth_method=case when credential->>'type'='oauth' then 'oauth' else 'key' end,search_verified_at=now(),updated_at=now() where client_id=target_client;
 else
   update public.website_analytics_connections set bing_site_url=configuration->>'bing_site_url',bing_verified_at=now(),bing_auth_method=case when credential->>'type'='oauth' then 'oauth' else 'key' end,updated_at=now() where client_id=target_client;
 end if;
end; $$;

commit;
