begin;

alter table public.media_assets drop constraint media_assets_mime_type_check,
  drop constraint media_assets_bytes_check, drop constraint media_assets_check;
alter table public.media_assets
  add constraint media_assets_supported_type check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4')),
  add constraint media_assets_size_by_type check (bytes between 1 and case when mime_type='video/mp4' then 52428800 else 8388608 end),
  add constraint media_assets_path_by_type check (
    object_path=client_id::text || '/' || id::text || case mime_type
      when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' else '.mp4' end
  );
update storage.buckets set file_size_limit=52428800,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4'] where id='tsols-media' and not public;
alter policy tsols_media_object_upload on storage.objects with check (
  bucket_id = 'tsols-media' and objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|mp4)$'
  and exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id::text=split_part(objects.name,'/',1) and c.status<>'archived'
      and m.user_id=(select auth.uid()) and m.role='administrator')
);

alter table public.content_calendar drop constraint content_calendar_format_check,
  add constraint content_calendar_format_check check (
    format in ('Text Post','Image Post','Video Post','Poster','Carousel','Reel Idea','Video Script','Story','Promotional Announcement','Educational Post')
  );

alter table public.content_calendar add column content_origin text not null default 'unclassified'
  check (content_origin in ('unclassified','manual','ai'));
alter table public.content_calendar alter column content_origin set default 'ai';
grant insert(content_origin) on public.content_calendar to authenticated;
alter table public.content_approvals add column approval_kind text not null default 'review'
  check (approval_kind in ('review','manual'));

alter table public.content_calendar add unique(id,client_id);

create table public.publishing_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  buffer_channel_id text not null unique check (length(buffer_channel_id) between 1 and 160),
  name text not null check (length(btrim(name)) between 1 and 180),
  platform text not null check (length(platform) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(id,client_id)
);
create index publishing_accounts_client_idx on public.publishing_accounts(client_id);

create table public.publishing_deliveries (
  content_id uuid not null,
  client_id uuid not null,
  revision integer not null,
  account_id uuid not null,
  status text not null default 'sending' check (status in ('sending','submitted','rejected','unknown')),
  external_post_id text,
  submitted_at timestamptz not null default now(),
  primary key (content_id,revision,account_id),
  foreign key(content_id,client_id) references public.content_calendar(id,client_id) on delete restrict,
  foreign key(content_id,revision) references public.content_approvals(content_id,revision) on delete restrict,
  foreign key(account_id,client_id) references public.publishing_accounts(id,client_id) on delete restrict,
  check ((status='submitted')=(external_post_id is not null))
);
create index publishing_deliveries_account_idx on public.publishing_deliveries(account_id,client_id);

alter table public.publishing_accounts enable row level security;
alter table public.publishing_deliveries enable row level security;
revoke all on public.publishing_accounts, public.publishing_deliveries from public, anon, authenticated;
grant select on public.publishing_accounts, public.publishing_deliveries to authenticated;
grant insert(client_id,buffer_channel_id,name,platform) on public.publishing_accounts to authenticated;
grant update(active) on public.publishing_accounts to authenticated;
grant select, insert, update on public.publishing_deliveries to service_role;

create policy publishing_accounts_read on public.publishing_accounts for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_accounts.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy publishing_accounts_add on public.publishing_accounts for insert to authenticated with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_accounts.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy publishing_accounts_enable on public.publishing_accounts for update to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_accounts.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_accounts.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy publishing_deliveries_read on public.publishing_deliveries for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_deliveries.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);

create or replace function tsols_private.guard_content_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.content_origin='manual' and (length(btrim(new.caption))>0 or new.media_asset_id is not null) then
      new.status := 'approved';
    end if;
    return new;
  end if;
  if (new.title,new.caption,new.hashtags,new.call_to_action,new.visual_concept,new.suggested_date,new.suggested_time,new.platform,new.format,new.media_asset_id)
  is distinct from
     (old.title,old.caption,old.hashtags,old.call_to_action,old.visual_concept,old.suggested_date,old.suggested_time,old.platform,old.format,old.media_asset_id) then
    if new.status is distinct from old.status or new.scheduled_at is distinct from old.scheduled_at
      or new.schedule_cancelled_at is distinct from old.schedule_cancelled_at then
      raise exception 'Save content before changing its approval or schedule.';
    end if;
    new.revision := old.revision + 1;
    new.status := case when new.content_origin='manual' and (length(btrim(new.caption))>0 or new.media_asset_id is not null)
      then 'approved' else 'draft' end;
    new.scheduled_at := null;
    new.schedule_cancelled_at := null;
  elsif new.status is distinct from old.status then
    if new.content_origin='manual' then
      raise exception 'Manual posts become ready when a caption or media is saved.';
    end if;
    if new.scheduled_at is distinct from old.scheduled_at or new.schedule_cancelled_at is distinct from old.schedule_cancelled_at then
      raise exception 'Approve the revision before planning its schedule.';
    end if;
    if not ((old.status = 'draft' and new.status = 'pending_approval')
      or (old.status = 'pending_approval' and new.status in ('draft','approved'))) then
      raise exception 'This workflow transition is unavailable.';
    end if;
    if new.status <> 'draft' and length(btrim(new.caption)) = 0 then
      raise exception 'Add a caption before requesting approval.';
    end if;
    if new.status = 'approved' and new.media_asset_id is not null and not exists (
      select 1 from public.media_assets a where a.id=new.media_asset_id and a.client_id=new.client_id and a.approved_at is not null
    ) then
      raise exception 'Approve the attached image in Media Library before approving the post.';
    end if;
  elsif (new.scheduled_at,new.schedule_cancelled_at) is distinct from (old.scheduled_at,old.schedule_cancelled_at) then
    if new.status <> 'approved' or not exists (
      select 1 from public.content_approvals a where a.content_id=old.id and a.revision=old.revision
    ) then
      raise exception 'Approve the saved revision before planning its schedule.';
    end if;
    if new.schedule_cancelled_at is not null then
      if old.scheduled_at is null or old.schedule_cancelled_at is not null or new.scheduled_at is distinct from old.scheduled_at then
        raise exception 'Only an active schedule can be cancelled.';
      end if;
      new.schedule_cancelled_at := clock_timestamp();
    elsif new.scheduled_at is null or new.scheduled_at <= clock_timestamp() then
      raise exception 'Select a future date and time.';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger studio_manual_ready_on_insert before insert on public.content_calendar
for each row execute function tsols_private.guard_content_revision();

create or replace function tsols_private.record_content_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.revision <> old.revision then
    insert into public.content_revisions(content_id,revision,snapshot,author_id)
    values (new.id,new.revision,to_jsonb(new) - array['id','client_id','status','revision','created_at','updated_at','scheduled_at','schedule_cancelled_at'],auth.uid());
  end if;
  if new.status='approved' and (tg_op='INSERT' or old.status<>'approved' or new.revision<>old.revision) then
    insert into public.content_approvals(content_id,revision,approved_by,approval_kind)
    values (new.id,new.revision,auth.uid(),case when new.content_origin='manual' then 'manual' else 'review' end);
  end if;
  return null;
end;
$$;

commit;
