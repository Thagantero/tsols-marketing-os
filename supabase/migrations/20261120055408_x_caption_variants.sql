begin;
create table public.content_x_captions (
 content_id uuid not null,
 revision integer not null,
 caption text not null check(length(btrim(caption)) between 1 and 6000),
 status text not null default 'draft' check(status in ('draft','approved')),
 approved_by uuid references auth.users(id),
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(content_id,revision),
 foreign key(content_id,revision) references public.content_revisions(content_id,revision) on delete restrict
);
alter table public.content_x_captions enable row level security;
revoke all on public.content_x_captions from public,anon,authenticated;
grant select on public.content_x_captions to authenticated;
grant insert(content_id,revision,caption),update(caption,status) on public.content_x_captions to authenticated;
create policy x_captions_admin_read on public.content_x_captions for select to authenticated using (
 exists(select 1 from public.content_calendar c join public.clients b on b.id=c.client_id join public.agency_memberships m on m.agency_id=b.agency_id
 where c.id=content_x_captions.content_id and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy x_captions_admin_insert on public.content_x_captions for insert to authenticated with check (
 exists(select 1 from public.content_calendar c join public.clients b on b.id=c.client_id join public.agency_memberships m on m.agency_id=b.agency_id
 where c.id=content_x_captions.content_id and c.revision=content_x_captions.revision and b.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy x_captions_admin_update on public.content_x_captions for update to authenticated using (
 exists(select 1 from public.content_calendar c join public.clients b on b.id=c.client_id join public.agency_memberships m on m.agency_id=b.agency_id
 where c.id=content_x_captions.content_id and c.revision=content_x_captions.revision and b.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator'))
 with check (
 exists(select 1 from public.content_calendar c join public.clients b on b.id=c.client_id join public.agency_memberships m on m.agency_id=b.agency_id
 where c.id=content_x_captions.content_id and c.revision=content_x_captions.revision and b.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator'));
create function tsols_private.guard_x_caption() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if old.status='approved' then raise exception 'The approved X version is locked. Edit the original post to create a new revision.'; end if;
  if new.caption is distinct from old.caption then new.status:='draft';new.approved_at:=null;new.approved_by:=null;
  elsif new.status='approved' then
   if not exists(select 1 from public.content_calendar c where c.id=new.content_id and c.revision=new.revision and c.status='approved') then raise exception 'Approve the main post before its X version.'; end if;
   new.approved_at:=now();new.approved_by:=auth.uid();
  end if;
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end; $$;
revoke all on function tsols_private.guard_x_caption() from public,anon,authenticated;
create trigger guard_x_caption before insert or update on public.content_x_captions for each row execute function tsols_private.guard_x_caption();
commit;
