begin;

create table public.client_portal_invitations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  email text not null check (length(email)<=254 and email=lower(btrim(email))
    and email ~ '^[^@,[:space:]]+@[^@,[:space:]]+\.[^@,[:space:]]+$'),
  invited_by uuid references public.profiles(id) on delete set null default auth.uid(),
  expires_at timestamptz not null default now()+interval '14 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_user uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz
);
create index client_portal_invites_client_idx on public.client_portal_invitations(client_id,created_at desc);
create unique index client_portal_invites_active_idx on public.client_portal_invitations(client_id,email)
  where revoked_at is null;
create index client_portal_invites_claim_idx on public.client_portal_invitations(email)
  where revoked_at is null and accepted_at is null;
alter table public.client_portal_invitations enable row level security;
revoke all on public.client_portal_invitations from public,anon,authenticated;
grant select on public.client_portal_invitations to authenticated;
create policy client_portal_invites_admin_read on public.client_portal_invitations for select to authenticated
using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=client_id and m.user_id=(select auth.uid()) and m.role='administrator'));

create function tsols_private.manage_client_portal_access(target_client uuid,invite_email text,revoke_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare invitation public.client_portal_invitations; normalized text:=lower(btrim(invite_email));
begin
  perform c.id from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=target_client and m.user_id=auth.uid() and m.role='administrator'
    and (revoke_id is not null or c.status<>'archived')
  for no key update of c;
  if not found then raise exception 'This client is unavailable.' using errcode='42501'; end if;
  if revoke_id is not null then
    update public.client_portal_invitations set revoked_at=clock_timestamp()
    where id=revoke_id and client_id=target_client and revoked_at is null returning * into invitation;
    if not found then raise exception 'This invitation is unavailable.'; end if;
    if invitation.accepted_user is not null and not exists(
      select 1 from public.client_portal_invitations i where i.client_id=target_client
      and i.accepted_user=invitation.accepted_user and i.revoked_at is null
    ) then
      delete from public.client_memberships where client_id=target_client and user_id=invitation.accepted_user;
    end if;
  else
    if normalized is null or length(normalized)>254 or normalized !~ '^[^@,[:space:]]+@[^@,[:space:]]+\.[^@,[:space:]]+$'
      then raise exception 'Enter a valid client email.'; end if;
    insert into public.client_portal_invitations(client_id,email) values(target_client,normalized)
      on conflict(client_id,email) where revoked_at is null do update
      set expires_at=case when client_portal_invitations.accepted_at is null
        and client_portal_invitations.expires_at<=now() then now()+interval '14 days' else client_portal_invitations.expires_at end
      returning * into invitation;
  end if;
  return invitation.id;
end;
$$;

create function tsols_private.claim_client_portal_access()
returns integer language plpgsql security definer set search_path='' as $$
declare verified_email text; invitation record; claimed integer:=0; caller uuid:=auth.uid();
begin
  if caller is null then return 0; end if;
  select lower(btrim(email)) into verified_email
  from auth.users where id=caller and email_confirmed_at is not null;
  if verified_email is null then return 0; end if;
  for invitation in
    select i.id,i.client_id from public.client_portal_invitations i join public.clients c on c.id=i.client_id
    where i.email=verified_email and i.revoked_at is null and i.accepted_at is null
      and i.expires_at>now() and c.status<>'archived'
    order by i.id for update of i
  loop
    insert into public.profiles(id) values(caller) on conflict do nothing;
    insert into public.client_memberships(client_id,user_id) values(invitation.client_id,caller) on conflict do nothing;
    update public.client_portal_invitations set accepted_at=clock_timestamp(),accepted_user=caller where id=invitation.id;
    claimed:=claimed+1;
  end loop;
  return claimed;
end;
$$;

create function tsols_private.client_portal_page(target_client uuid,section text,page_number integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare business public.clients; result jsonb; page_size constant integer:=20; first_row integer;
begin
  if auth.uid() is null then raise exception 'Sign in to view the portal.' using errcode='42501'; end if;
  select c.* into business from public.clients c join public.client_memberships m on m.client_id=c.id
  where c.id=target_client and m.user_id=auth.uid() and c.status<>'archived';
  if not found then raise exception 'This business is unavailable.' using errcode='42501'; end if;
  if page_number is null or page_number<0 or page_number>10000 then raise exception 'Invalid page.'; end if;
  first_row:=page_number*page_size;

  case section
    when 'overview' then
      return jsonb_build_object(
        'upcoming', (select count(*) from public.content_calendar q where q.client_id=business.id
          and q.scheduled_at>=now() and q.schedule_cancelled_at is null
          and (q.status='approved' or q.content_origin='manual')),
        'leads', (select count(*) from public.leads l where l.client_id=business.id and l.status='new'),
        'reports', (select count(*) from public.reports r where r.client_id=business.id and r.status='approved'));
    when 'profile' then
      return jsonb_build_object('business_name',business.business_name,'industry',business.industry,'location',business.location,
        'description',business.description,'address',business.address,'website',business.website,
        'brand_name',(select b.brand_name from public.client_brand_profiles b where b.client_id=business.id),
        'contact_email',business.contact_email,'contact_phone',business.contact_phone);
    when 'package' then
      return jsonb_build_object('package_name',business.package_name,'status',business.status,
        'onboarding_date',business.onboarding_date,'monthly_fee_kes',business.monthly_service_fee_kes,
        'monthly_ad_budget_kes',business.monthly_ad_budget_kes);
    when 'content','calendar' then
      select coalesce(jsonb_agg(to_jsonb(rows)),'[]') into result from (
        select q.id,q.title,q.caption,q.hashtags,q.platform,q.format,
          case when q.schedule_cancelled_at is null then q.scheduled_at end as scheduled_at,
          delivery.sent_at,
          case when delivery.sent then 'Published'
               when delivery.queued then 'Queued with Buffer'
               when q.scheduled_at is not null and q.schedule_cancelled_at is null then 'Planned'
               else 'Approved' end as state
        from public.content_calendar q
        cross join lateral (
          select bool_or(d.provider_status='sent') as sent,max(d.provider_sent_at) filter(where d.provider_status='sent') as sent_at,
            bool_or(d.provider_status in ('scheduled','sending')) as queued
          from public.publishing_deliveries d where d.client_id=business.id and d.content_id=q.id and d.revision=q.revision
        ) delivery
        where q.client_id=business.id
          and (q.status='approved' or delivery.sent or delivery.queued
            or (q.content_origin='manual' and q.scheduled_at is not null and q.schedule_cancelled_at is null))
          and (section='content' or delivery.sent or delivery.queued
            or (q.scheduled_at is not null and q.schedule_cancelled_at is null))
        order by case when section='calendar' then coalesce(delivery.sent_at,q.scheduled_at,q.updated_at) else q.updated_at end desc,q.id
        offset first_row limit page_size+1
      ) rows;
    when 'leads' then
      select coalesce(jsonb_agg(to_jsonb(rows)),'[]') into result from (
        select l.id,l.name,l.phone,l.whatsapp_number,l.email,l.service,l.source,l.status,l.created_at
        from public.leads l where l.client_id=business.id order by l.created_at desc,l.id
        offset first_row limit page_size+1
      ) rows;
    when 'advertising' then
      select jsonb_build_object('campaigns',coalesce((
        select jsonb_agg(to_jsonb(rows)) from (
          select p.id,p.name,p.platform,p.objective,p.start_date,p.end_date,p.daily_budget_kes,p.monthly_budget_kes,p.target_locations
          from public.ad_campaigns p where p.client_id=business.id and p.plan_status='approved'
          order by p.start_date desc,p.id offset first_row limit page_size+1
        ) rows),'[]'),'performance',coalesce((
        select jsonb_agg(to_jsonb(totals)) from (
          select a.platform,s.currency,sum(s.spend) as spend,sum(s.impressions) as impressions,sum(s.clicks) as clicks,sum(s.leads) as leads
          from public.ad_performance_snapshots s join public.ad_accounts a on a.id=s.account_id and a.client_id=s.client_id
          where s.client_id=business.id and s.report_date between (now() at time zone 'Africa/Nairobi')::date-29 and (now() at time zone 'Africa/Nairobi')::date
          group by a.platform,s.currency order by a.platform,s.currency
        ) totals),'[]')) into result;
    when 'reports' then
      select coalesce(jsonb_agg(to_jsonb(rows)),'[]') into result from (
        select r.id,r.client_id,r.client_name,null::text as recipient_email,r.cadence,r.period_start,r.period_end,
          r.partial_period,r.version,r.observations,r.action_plan,r.status,r.created_at,r.updated_at,r.approved_at,
          (r.metrics-'top_campaigns')||jsonb_build_object('top_campaigns',coalesce((
            select jsonb_agg((item-'external_campaign_id'-'account_label')||jsonb_build_object('account_label',item->>'platform'))
            from jsonb_array_elements(coalesce(r.metrics->'top_campaigns','[]')) item
          ),'[]')) as metrics
        from public.reports r where r.client_id=business.id and r.status='approved'
        order by r.period_start desc,r.version desc,r.id offset first_row limit page_size+1
      ) rows;
    else raise exception 'Unknown portal page.';
  end case;
  return result;
end;
$$;

create function public.manage_client_portal_access(target_client uuid,invite_email text,revoke_id uuid)
returns uuid language sql security invoker set search_path='' as $$
  select tsols_private.manage_client_portal_access(target_client,invite_email,revoke_id)
$$;
create function public.claim_client_portal_access()
returns integer language sql security invoker set search_path='' as $$
  select tsols_private.claim_client_portal_access()
$$;
create function public.client_portal_page(target_client uuid,section text,page_number integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
  select tsols_private.client_portal_page(target_client,section,page_number)
$$;

revoke all on function tsols_private.manage_client_portal_access(uuid,text,uuid),
  tsols_private.claim_client_portal_access(),tsols_private.client_portal_page(uuid,text,integer),
  public.manage_client_portal_access(uuid,text,uuid),public.claim_client_portal_access(),
  public.client_portal_page(uuid,text,integer) from public,anon;
grant execute on function tsols_private.manage_client_portal_access(uuid,text,uuid),
  tsols_private.claim_client_portal_access(),tsols_private.client_portal_page(uuid,text,integer),
  public.manage_client_portal_access(uuid,text,uuid),public.claim_client_portal_access(),
  public.client_portal_page(uuid,text,integer) to authenticated;

commit;
