begin;

create table public.content_calendar (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 180),
  caption text not null default '' check (length(caption) <= 6000),
  hashtags text not null default '' check (length(hashtags) <= 1000),
  call_to_action text not null default '' check (length(call_to_action) <= 300),
  visual_concept text not null default '' check (length(visual_concept) <= 2000),
  suggested_date date,
  suggested_time time check (suggested_time is null or suggested_date is not null),
  platform text not null check (platform in ('Facebook','Instagram','LinkedIn','TikTok','Other')),
  format text not null check (format in ('Image Post','Poster','Carousel','Reel Idea','Video Script','Story','Promotional Announcement','Educational Post')),
  status text not null default 'draft' check (status in ('draft','pending_approval','approved')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_calendar_client_updated_idx on public.content_calendar(client_id, updated_at desc, id);

create table public.content_revisions (
  content_id uuid not null references public.content_calendar(id) on delete restrict,
  revision integer not null,
  snapshot jsonb not null,
  author_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (content_id, revision)
);

create table public.content_approvals (
  content_id uuid not null,
  revision integer not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  primary key (content_id, revision),
  foreign key (content_id, revision) references public.content_revisions(content_id, revision) on delete restrict
);

alter table public.content_calendar enable row level security;
alter table public.content_revisions enable row level security;
alter table public.content_approvals enable row level security;

revoke all on public.content_calendar, public.content_revisions, public.content_approvals from anon, authenticated, public;
grant select on public.content_calendar, public.content_revisions, public.content_approvals to authenticated;
grant insert(client_id,title,caption,hashtags,call_to_action,visual_concept,suggested_date,suggested_time,platform,format)
  on public.content_calendar to authenticated;
grant update(title,caption,hashtags,call_to_action,visual_concept,suggested_date,suggested_time,platform,format,status)
  on public.content_calendar to authenticated;

create policy admin_content_read on public.content_calendar for select to authenticated using (
  exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id = c.agency_id
    where c.id = content_calendar.client_id and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy admin_content_insert on public.content_calendar for insert to authenticated with check (
  exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id = c.agency_id
    where c.id = content_calendar.client_id and c.status <> 'archived'
      and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy admin_content_update on public.content_calendar for update to authenticated using (
  exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id = c.agency_id
    where c.id = content_calendar.client_id and c.status <> 'archived'
      and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
) with check (
  exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id = c.agency_id
    where c.id = content_calendar.client_id and c.status <> 'archived'
      and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy admin_content_revisions on public.content_revisions for select to authenticated using (
  exists (
    select 1 from public.content_calendar item
    join public.clients c on c.id = item.client_id
    join public.agency_memberships m on m.agency_id = c.agency_id
    where item.id = content_revisions.content_id and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);
create policy admin_content_approvals on public.content_approvals for select to authenticated using (
  exists (
    select 1 from public.content_calendar item
    join public.clients c on c.id = item.client_id
    join public.agency_memberships m on m.agency_id = c.agency_id
    where item.id = content_approvals.content_id and m.user_id = (select auth.uid()) and m.role = 'administrator'
  )
);

create schema if not exists tsols_private;
revoke all on schema tsols_private from public, anon, authenticated;

create function tsols_private.guard_content_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.title,new.caption,new.hashtags,new.call_to_action,new.visual_concept,new.suggested_date,new.suggested_time,new.platform,new.format)
  is distinct from
     (old.title,old.caption,old.hashtags,old.call_to_action,old.visual_concept,old.suggested_date,old.suggested_time,old.platform,old.format) then
    if new.status is distinct from old.status then
      raise exception 'Save the content before changing its status.';
    end if;
    new.revision := old.revision + 1;
    new.status := 'draft';
  elsif new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status = 'pending_approval')
      or (old.status = 'pending_approval' and new.status in ('draft','approved'))) then
      raise exception 'This workflow transition is unavailable.';
    end if;
    if new.status <> 'draft' and length(btrim(new.caption)) = 0 then
      raise exception 'Add a caption before requesting approval.';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger studio_revision_guard before update on public.content_calendar
for each row execute function tsols_private.guard_content_revision();

create function tsols_private.record_content_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.revision <> old.revision then
    insert into public.content_revisions(content_id,revision,snapshot,author_id)
    values (new.id,new.revision,to_jsonb(new) - array['id','client_id','status','revision','created_at','updated_at'],auth.uid());
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status <> 'approved' then
    insert into public.content_approvals(content_id,revision,approved_by)
    values (new.id,new.revision,auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function tsols_private.record_content_revision() from public, anon, authenticated;
create trigger studio_revision_record after insert or update on public.content_calendar
for each row execute function tsols_private.record_content_revision();

create table tsols_private.generation_quota (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  hour_start timestamptz not null,
  calls integer not null check (calls between 1 and 6),
  primary key (agency_id, hour_start)
);

create function tsols_private.reserve_generation(target_client uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  agency uuid;
  used integer;
  now_hour timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is null then return false; end if;
  select c.agency_id into agency
  from public.clients c join public.agency_memberships m on m.agency_id = c.agency_id
  where c.id = target_client and c.status <> 'archived' and m.user_id = auth.uid() and m.role = 'administrator';
  if agency is null then return false; end if;
  delete from tsols_private.generation_quota where agency_id = agency and hour_start < now_hour - interval '1 day';
  insert into tsols_private.generation_quota as q(agency_id,hour_start,calls)
  values (agency,now_hour,1)
  on conflict (agency_id,hour_start) do update set calls = q.calls + 1 where q.calls < 6
  returning calls into used;
  return used is not null;
end;
$$;
revoke all on function tsols_private.reserve_generation(uuid) from public, anon;
grant usage on schema tsols_private to authenticated;
grant execute on function tsols_private.reserve_generation(uuid) to authenticated;

create function public.reserve_content_generation(target_client uuid) returns boolean
language sql security invoker set search_path = '' as $$
  select tsols_private.reserve_generation(target_client)
$$;
revoke all on function public.reserve_content_generation(uuid) from public, anon;
grant execute on function public.reserve_content_generation(uuid) to authenticated;

commit;
