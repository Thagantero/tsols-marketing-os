begin;

create table public.media_assets (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 180),
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  bytes integer not null check (bytes between 1 and 8388608),
  source text not null check (source in ('upload','drive','poster','ai_poster')),
  generation_metadata jsonb not null default '{}' check (jsonb_typeof(generation_metadata) = 'object' and length(generation_metadata::text) <= 2000),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique(id,client_id),
  check (object_path = client_id::text || '/' || id::text || case mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end)
);
create index media_assets_client_created_idx on public.media_assets(client_id,created_at desc,id);
alter table public.media_assets enable row level security;
revoke all on public.media_assets from public, anon, authenticated;
grant select on public.media_assets to authenticated;
grant insert(id,client_id,name,object_path,mime_type,bytes,source,generation_metadata) on public.media_assets to authenticated;
grant update(approved_at) on public.media_assets to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('tsols-media','tsols-media',false,8388608,array['image/jpeg','image/png','image/webp']);

create policy tsols_media_object_read on storage.objects for select to authenticated using (
  bucket_id = 'tsols-media' and exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id::text = split_part(objects.name,'/',1)
      and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy tsols_media_object_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'tsols-media' and objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' and exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id::text = split_part(objects.name,'/',1) and c.status <> 'archived'
      and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy tsols_media_cleanup_unregistered on storage.objects for delete to authenticated using (
  bucket_id = 'tsols-media' and owner_id = (select auth.uid())::text
    and not exists (select 1 from public.media_assets a where a.object_path = objects.name)
    and exists (
      select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
      where c.id::text = split_part(objects.name,'/',1)
        and m.user_id = (select auth.uid()) and m.role = 'administrator'
    )
);
create policy tsols_media_assets_read on public.media_assets for select to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id = media_assets.client_id and m.user_id = (select auth.uid()) and m.role = 'administrator')
);
create policy tsols_media_assets_register on public.media_assets for insert to authenticated with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id = media_assets.client_id and c.status <> 'archived' and m.user_id = (select auth.uid()) and m.role = 'administrator')
  and exists (select 1 from storage.objects o where o.bucket_id='tsols-media' and o.name=media_assets.object_path
    and o.owner_id = (select auth.uid())::text)
);
create policy tsols_media_assets_approve on public.media_assets for update to authenticated using (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id = media_assets.client_id and c.status <> 'archived' and m.user_id = (select auth.uid()) and m.role = 'administrator')
) with check (
  exists (select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id = media_assets.client_id and c.status <> 'archived' and m.user_id = (select auth.uid()) and m.role = 'administrator')
);

create function tsols_private.record_media_approval() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.approved_at := coalesce(old.approved_at, clock_timestamp());
  return new;
end;
$$;
create trigger tsols_media_approval_stamp before update of approved_at on public.media_assets
for each row execute function tsols_private.record_media_approval();

alter table public.content_calendar add column media_asset_id uuid;
alter table public.content_calendar add constraint content_media_same_client
  foreign key(media_asset_id,client_id) references public.media_assets(id,client_id) on delete restrict;
alter table public.content_calendar add column scheduled_at timestamptz;
alter table public.content_calendar add column schedule_cancelled_at timestamptz;
create index content_calendar_schedule_idx on public.content_calendar(client_id,scheduled_at)
where scheduled_at is not null;
grant insert(media_asset_id), update(media_asset_id,scheduled_at,schedule_cancelled_at) on public.content_calendar to authenticated;

create or replace function tsols_private.guard_content_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.title,new.caption,new.hashtags,new.call_to_action,new.visual_concept,new.suggested_date,new.suggested_time,new.platform,new.format,new.media_asset_id)
  is distinct from
     (old.title,old.caption,old.hashtags,old.call_to_action,old.visual_concept,old.suggested_date,old.suggested_time,old.platform,old.format,old.media_asset_id) then
    if new.status is distinct from old.status or new.scheduled_at is distinct from old.scheduled_at
      or new.schedule_cancelled_at is distinct from old.schedule_cancelled_at then
      raise exception 'Save content before changing its approval or schedule.';
    end if;
    new.revision := old.revision + 1;
    new.status := 'draft';
    new.scheduled_at := null;
    new.schedule_cancelled_at := null;
  elsif new.status is distinct from old.status then
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

create or replace function tsols_private.record_content_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.revision <> old.revision then
    insert into public.content_revisions(content_id,revision,snapshot,author_id)
    values (new.id,new.revision,to_jsonb(new) - array['id','client_id','status','revision','created_at','updated_at','scheduled_at','schedule_cancelled_at'],auth.uid());
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status <> 'approved' then
    insert into public.content_approvals(content_id,revision,approved_by)
    values (new.id,new.revision,auth.uid());
  end if;
  return null;
end;
$$;

commit;
