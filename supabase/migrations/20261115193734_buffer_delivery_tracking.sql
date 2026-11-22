begin;

alter table public.publishing_deliveries
  add column due_at timestamptz,
  add column provider_status text check (provider_status in ('draft','scheduled','sending','sent','error','needs_approval','cancelled')),
  add column attempt_count integer not null default 1 check (attempt_count between 1 and 2),
  add column failure_code text check (failure_code in ('request_rejected','rate_limited','connection','unconfirmed','provider_error')),
  add column status_checked_at timestamptz;
create index publishing_deliveries_recent_by_client on public.publishing_deliveries(client_id,submitted_at desc);

create table public.publishing_events (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null,
  revision integer not null,
  account_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  status text not null,
  provider_status text,
  failure_code text,
  attempt_count integer not null,
  created_at timestamptz not null default now(),
  foreign key(content_id,revision,account_id)
    references public.publishing_deliveries(content_id,revision,account_id) on delete restrict
);
create index publishing_events_delivery_time_idx on public.publishing_events(content_id,revision,account_id,created_at desc);
alter table public.publishing_events enable row level security;
revoke all on public.publishing_events from public, anon, authenticated;
grant select on public.publishing_events to authenticated;
create policy publishing_events_admin_read on public.publishing_events for select to authenticated using (
  exists (
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=publishing_events.client_id and m.user_id=(select auth.uid()) and m.role='administrator'
  )
);

create function tsols_private.record_publishing_event() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or (new.status,new.provider_status,new.failure_code,new.attempt_count)
    is distinct from (old.status,old.provider_status,old.failure_code,old.attempt_count) then
    insert into public.publishing_events(content_id,revision,account_id,client_id,status,provider_status,failure_code,attempt_count)
    values(new.content_id,new.revision,new.account_id,new.client_id,new.status,new.provider_status,new.failure_code,new.attempt_count);
  end if;
  return null;
end;
$$;
revoke all on function tsols_private.record_publishing_event() from public, anon, authenticated;
create trigger buffer_delivery_log after insert or update on public.publishing_deliveries
for each row execute function tsols_private.record_publishing_event();

create function tsols_private.check_buffer_claim() returns trigger
language plpgsql set search_path='' as $$
declare post public.content_calendar;
begin
  if new.status<>'sending' then return new; end if;
  if tg_op='UPDATE' then
    if old.status<>'rejected' or old.external_post_id is not null or old.attempt_count<>1 or new.attempt_count<>2
      or new.due_at is distinct from old.due_at then
      raise exception 'This delivery cannot be retried.';
    end if;
  end if;
  select * into post from public.content_calendar where id=new.content_id and client_id=new.client_id for update;
  if not found or post.revision<>new.revision or post.status<>'approved' then
    raise exception 'The selected revision is no longer ready.';
  end if;
  if new.due_at is not null and (new.due_at is distinct from post.scheduled_at or post.schedule_cancelled_at is not null
    or new.due_at <= clock_timestamp() + interval '2 minutes') then
    raise exception 'The calendar plan is unavailable or too close to send.';
  end if;
  return new;
end;
$$;
grant select on public.content_calendar to service_role;
grant update (updated_at) on public.content_calendar to service_role;
create trigger buffer_delivery_claim before insert or update of status on public.publishing_deliveries
for each row execute function tsols_private.check_buffer_claim();

create function tsols_private.guard_delegated_calendar_plan() returns trigger
language plpgsql set search_path='' as $$
begin
  if (new.revision,new.scheduled_at,new.schedule_cancelled_at) is distinct from (old.revision,old.scheduled_at,old.schedule_cancelled_at)
    and exists (
      select 1 from public.publishing_deliveries d where d.content_id=old.id and d.revision=old.revision
        and d.due_at is not null and (
          d.status in ('sending','unknown') or
          (d.status='submitted' and coalesce(d.provider_status,'scheduled') not in ('sent','error','cancelled'))
        )
    ) then raise exception 'This revision has a live Buffer schedule. Cancel all queued deliveries in Publishing before editing the plan.';
  end if;
  return new;
end;
$$;
create trigger studio_z_buffer_plan_guard before update on public.content_calendar
for each row execute function tsols_private.guard_delegated_calendar_plan();

commit;
