begin;

create table public.facebook_page_deliveries (
  content_id uuid not null,
  revision integer not null,
  client_id uuid not null,
  page_id text not null default '103605634352615' check(page_id='103605634352615'),
  status text not null default 'sending' check(status in ('sending','published','rejected','unknown')),
  provider_post_id text check(provider_post_id ~ '^[0-9]+(_[0-9]+)?$'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(content_id,revision,page_id),
  foreign key(content_id,client_id) references public.content_calendar(id,client_id),
  foreign key(content_id,revision) references public.content_approvals(content_id,revision),
  check((status='published')=(provider_post_id is not null and sent_at is not null))
);
create index facebook_deliveries_client_idx on public.facebook_page_deliveries(client_id,created_at desc);
alter table public.facebook_page_deliveries enable row level security;
revoke all on public.facebook_page_deliveries from public,anon,authenticated;
grant select on public.facebook_page_deliveries to authenticated;
grant select,update(status,provider_post_id,sent_at) on public.facebook_page_deliveries to service_role;
create policy facebook_delivery_admin_read on public.facebook_page_deliveries for select to authenticated
using (exists(select 1 from public.clients c join public.agency_memberships a on a.agency_id=c.agency_id
  where c.id=facebook_page_deliveries.client_id and a.user_id=(select auth.uid()) and a.role='administrator'));

create function tsols_private.claim_facebook_delivery(content uuid, expected_revision integer, actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare post public.content_calendar; reserved uuid;
begin
  select q.* into post from public.content_calendar q join public.clients c on c.id=q.client_id
  join public.agency_memberships a on a.agency_id=c.agency_id
  where q.id=content and q.revision=expected_revision and q.status='approved'
    and q.client_id='f91d40c1-547a-4626-8f96-fc527fa9c486'
    and c.agency_id='a8816370-4462-4741-8ac9-79d31b51f2af' and c.status<>'archived'
    and a.user_id=actor and a.role='administrator'
  for no key update of q;
  if not found then return null; end if;
  insert into public.facebook_page_deliveries(content_id,revision,client_id)
    values(post.id,post.revision,post.client_id) on conflict do nothing returning content_id into reserved;
  if reserved is null then return null; end if;
  return jsonb_build_object('caption',post.caption,'hashtags',post.hashtags,
    'call_to_action',post.call_to_action,'media_asset_id',post.media_asset_id);
end;
$$;
create function public.claim_facebook_delivery(content uuid, expected_revision integer, actor uuid)
returns jsonb language sql set search_path='' as $$
  select tsols_private.claim_facebook_delivery(content,expected_revision,actor)
$$;
revoke all on function public.claim_facebook_delivery(uuid,integer,uuid),
 tsols_private.claim_facebook_delivery(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.claim_facebook_delivery(uuid,integer,uuid),
 tsols_private.claim_facebook_delivery(uuid,integer,uuid) to service_role;
commit;
