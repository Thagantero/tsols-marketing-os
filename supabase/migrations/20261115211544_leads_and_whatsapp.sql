begin;

create function tsols_private.lead_phone(value text) returns text
language plpgsql immutable set search_path='' as $$
declare digits text;
begin
  if value is null or btrim(value)='' then return null; end if;
  digits:=regexp_replace(btrim(value),'[ ()-]','','g');
  if digits ~ '^0[17][0-9]{8}$' then digits:='+254'||substr(digits,2);
  elsif digits ~ '^254[17][0-9]{8}$' then digits:='+'||digits;
  elsif digits ~ '^00[1-9][0-9]{6,14}$' then digits:='+'||substr(digits,3); end if;
  if digits !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Use a Kenyan mobile number or an international number with its country code.'; end if;
  return digits;
end;
$$;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  name text not null check(length(btrim(name)) between 1 and 160),
  phone text,
  whatsapp_number text,
  email text check(length(email)<=254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  service text check(length(service)<=200),
  source text not null check(source in ('WhatsApp','Instagram','Facebook','Website Form','Advertising','Phone Call','Manual Entry')),
  status text not null default 'new' check(status in ('new','contacted','qualified','booked','won','lost')),
  priority text not null default 'normal' check(priority in ('normal','hot')),
  notes text check(length(notes)<=3000),
  assigned_user_id uuid references public.profiles(id) on delete set null,
  consent_status text not null default 'not_recorded' check(consent_status in ('not_recorded','opted_in','opted_out')),
  last_contact_at timestamptz,
  last_reply_at timestamptz,
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,client_id),
  check(phone is not null or whatsapp_number is not null or email is not null)
);
create index leads_client_latest_idx on public.leads(client_id,created_at desc,id);
create index leads_client_urgent_idx on public.leads(client_id,priority,status);
create unique index leads_client_contact_idx on public.leads(client_id,coalesce(whatsapp_number,phone)) where coalesce(whatsapp_number,phone) is not null;
create unique index leads_client_email_idx on public.leads(client_id,lower(email)) where email is not null;

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  client_id uuid not null,
  action text not null,
  detail text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(lead_id,client_id) references public.leads(id,client_id) on delete restrict
);
create index lead_activities_recent_idx on public.lead_activities(lead_id,created_at desc);

create table public.messaging_consents (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  client_id uuid not null,
  phone_number text not null,
  consent text not null check(consent in ('opted_in','opted_out')),
  evidence text not null check(length(btrim(evidence)) between 5 and 500),
  created_at timestamptz not null default now(),
  foreign key(lead_id,client_id) references public.leads(id,client_id) on delete restrict
);
create index messaging_consent_history_idx on public.messaging_consents(lead_id,created_at desc);

create table public.lead_intake_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  label text not null check(length(btrim(label)) between 1 and 100),
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  rate_start timestamptz not null default now(),
  rate_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index lead_intake_client_idx on public.lead_intake_links(client_id);

create table public.whatsapp_settings (
  client_id uuid primary key references public.clients(id) on delete restrict,
  welcome_enabled boolean not null default false,
  follow_up_enabled boolean not null default false,
  welcome_delay_minutes integer not null default 5 check(welcome_delay_minutes between 0 and 60)
);

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  client_id uuid not null,
  kind text not null check(kind in ('welcome','follow_up')),
  scheduled_at timestamptz not null,
  status text not null default 'queued' check(status in ('queued','sending','accepted','sent','delivered','read','skipped','failed','unknown')),
  reason text,
  provider_id text unique,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(lead_id,kind),
  foreign key(lead_id,client_id) references public.leads(id,client_id) on delete restrict
);
create index whatsapp_due_idx on public.whatsapp_messages(client_id,scheduled_at) where status='queued';

create table tsols_private.whatsapp_webhook_events (
  provider_id text primary key,
  received_at timestamptz not null default now()
);

alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.messaging_consents enable row level security;
alter table public.lead_intake_links enable row level security;
alter table public.whatsapp_settings enable row level security;
alter table public.whatsapp_messages enable row level security;
revoke all on public.leads,public.lead_activities,public.messaging_consents,public.lead_intake_links,public.whatsapp_settings,public.whatsapp_messages from public,anon,authenticated;
grant select on public.leads,public.lead_activities,public.messaging_consents,public.whatsapp_settings,public.whatsapp_messages to authenticated;
grant select(id,client_id,label,active,created_at) on public.lead_intake_links to authenticated;
grant insert(client_id,name,phone,whatsapp_number,email,service,source,status,priority,notes,assigned_user_id,next_follow_up_at) on public.leads to authenticated;
grant update(name,phone,whatsapp_number,email,service,source,status,priority,notes,assigned_user_id,next_follow_up_at,last_contact_at) on public.leads to authenticated;
grant insert(lead_id,client_id,phone_number,consent,evidence) on public.messaging_consents to authenticated;
grant insert(client_id,label,token_hash),update(active) on public.lead_intake_links to authenticated;
grant insert(client_id,welcome_enabled,follow_up_enabled,welcome_delay_minutes),update(welcome_enabled,follow_up_enabled,welcome_delay_minutes) on public.whatsapp_settings to authenticated;
grant insert(lead_id,client_id,kind,scheduled_at) on public.whatsapp_messages to authenticated;

create policy admin_leads_read on public.leads for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=leads.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_leads_insert on public.leads for insert to authenticated with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=leads.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_leads_update on public.leads for update to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=leads.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=leads.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_lead_activity on public.lead_activities for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=lead_activities.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_read_consents on public.messaging_consents for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=messaging_consents.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_record_consents on public.messaging_consents for insert to authenticated with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=messaging_consents.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_intake_links on public.lead_intake_links for all to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=lead_intake_links.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=lead_intake_links.client_id and c.status<>'archived' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_whatsapp_settings on public.whatsapp_settings for all to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=whatsapp_settings.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
) with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=whatsapp_settings.client_id and c.status='active' and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_whatsapp_messages_read on public.whatsapp_messages for select to authenticated using (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  where c.id=whatsapp_messages.client_id and m.user_id=(select auth.uid()) and m.role='administrator')
);
create policy admin_whatsapp_messages_queue on public.whatsapp_messages for insert to authenticated with check (
  exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
  join public.leads l on l.client_id=c.id
  where c.id=whatsapp_messages.client_id and l.id=whatsapp_messages.lead_id and l.consent_status='opted_in'
    and l.whatsapp_number is not null and l.status not in ('booked','won','lost') and c.status='active'
    and m.user_id=(select auth.uid()) and m.role='administrator')
);

grant select(id,status) on public.clients to service_role;
grant select,insert,update on public.leads,public.messaging_consents,public.whatsapp_messages to service_role;
grant select,update on public.lead_intake_links to service_role;
grant select on public.whatsapp_settings to service_role;
grant select,insert on public.lead_activities to service_role;
grant usage on schema tsols_private to service_role;
grant select(provider_id), insert on tsols_private.whatsapp_webhook_events to service_role;

create function tsols_private.clean_lead() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.phone:=tsols_private.lead_phone(new.phone);
  new.whatsapp_number:=tsols_private.lead_phone(new.whatsapp_number);
  new.email:=nullif(lower(btrim(new.email)),'');
  new.name:=btrim(new.name);
  if new.assigned_user_id is not null and not exists(
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=new.client_id and m.user_id=new.assigned_user_id
  ) then raise exception 'Choose a member of the lead’s agency.'; end if;
  if tg_op='UPDATE' and new.whatsapp_number is distinct from old.whatsapp_number then
    new.consent_status:='not_recorded';
    new.last_reply_at:=null;
  end if;
  new.updated_at:=clock_timestamp();
  return new;
end;
$$;
revoke all on function tsols_private.clean_lead() from public,anon,authenticated;
create trigger clean_lead_values before insert or update on public.leads for each row execute function tsols_private.clean_lead();

create function tsols_private.log_lead() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    insert into public.lead_activities(lead_id,client_id,action,detail,actor_id)
      values(new.id,new.client_id,'Lead captured',new.source,auth.uid());
  else
    if new.status is distinct from old.status then
      insert into public.lead_activities(lead_id,client_id,action,detail,actor_id)
        values(new.id,new.client_id,'Status updated',old.status||' → '||new.status,auth.uid());
    end if;
    if new.notes is distinct from old.notes then
      insert into public.lead_activities(lead_id,client_id,action,actor_id)
        values(new.id,new.client_id,'Notes updated',auth.uid());
    end if;
    if new.last_contact_at is distinct from old.last_contact_at and auth.uid() is not null then
      insert into public.lead_activities(lead_id,client_id,action,actor_id)
        values(new.id,new.client_id,'Contact logged',auth.uid());
    end if;
    if new.next_follow_up_at is distinct from old.next_follow_up_at then
      insert into public.lead_activities(lead_id,client_id,action,actor_id)
        values(new.id,new.client_id,'Follow-up date changed',auth.uid());
    end if;
  end if;
  if new.priority='hot' and (tg_op='INSERT' or old.priority<>'hot') then
    insert into public.lead_activities(lead_id,client_id,action,actor_id)
      values(new.id,new.client_id,'Hot lead flagged',auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function tsols_private.log_lead() from public,anon,authenticated;
create trigger log_lead_changes after insert or update on public.leads for each row execute function tsols_private.log_lead();

create function tsols_private.record_whatsapp_consent() returns trigger
language plpgsql security definer set search_path='' as $$
declare current_number text; old_consent text;
begin
  if auth.uid() is not null and not exists(
    select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=new.client_id and c.status<>'archived' and m.user_id=auth.uid() and m.role='administrator'
  ) then raise exception 'Lead access is unavailable.'; end if;
  select whatsapp_number,consent_status into current_number,old_consent from public.leads
    where id=new.lead_id and client_id=new.client_id for update;
  if current_number is null or current_number is distinct from tsols_private.lead_phone(new.phone_number) then
    raise exception 'Consent must match the lead’s current WhatsApp number.';
  end if;
  new.phone_number:=current_number;
  update public.leads set consent_status=new.consent where id=new.lead_id;
  insert into public.lead_activities(lead_id,client_id,action,detail,actor_id)
    values(new.lead_id,new.client_id,'WhatsApp consent updated',replace(new.consent,'_',' '),auth.uid());
  if new.consent='opted_out' then
    update public.whatsapp_messages set status='skipped',reason='opted_out',updated_at=clock_timestamp()
      where lead_id=new.lead_id and status='queued';
  elsif old_consent<>'opted_in' then
    insert into public.whatsapp_messages(lead_id,client_id,kind,scheduled_at)
      select new.lead_id,new.client_id,'welcome',now()+make_interval(mins=>s.welcome_delay_minutes)
      from public.whatsapp_settings s join public.clients c on c.id=s.client_id
      where s.client_id=new.client_id and s.welcome_enabled and c.status='active'
      on conflict(lead_id,kind) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function tsols_private.record_whatsapp_consent() from public,anon,authenticated;
create trigger record_consent_before_insert before insert on public.messaging_consents for each row execute function tsols_private.record_whatsapp_consent();

create function public.capture_website_lead(token_digest text,payload jsonb) returns text
language plpgsql security invoker set search_path='' as $$
declare link public.lead_intake_links; lead uuid; mobile text; intent text;
begin
  select i.* into link from public.lead_intake_links i join public.clients c on c.id=i.client_id
    where i.token_hash=token_digest and i.active and c.status='active' for update of i;
  if not found then return 'invalid_token'; end if;
  if link.rate_start>now()-interval '1 minute' and link.rate_count>=15 then return 'rate_limited'; end if;
  update public.lead_intake_links set
    rate_count=case when rate_start>now()-interval '1 minute' then rate_count+1 else 1 end,
    rate_start=case when rate_start>now()-interval '1 minute' then rate_start else now() end where id=link.id;
  mobile:=nullif(payload->>'whatsapp_number','');
  intent:=payload->>'intent';
  insert into public.leads(client_id,name,phone,whatsapp_number,email,service,source,priority,notes)
    values(link.client_id,payload->>'name',nullif(payload->>'phone',''),mobile,nullif(payload->>'email',''),
      nullif(payload->>'service',''),'Website Form',case when intent in ('booking','quotation','urgent') then 'hot' else 'normal' end,
      case when intent in ('booking','quotation','urgent') then 'Website request: '||intent else null end)
    on conflict do nothing returning id into lead;
  if lead is null then return 'accepted'; end if;
  if (payload->>'whatsapp_opt_in')::boolean is true and mobile is not null then
    insert into public.messaging_consents(lead_id,client_id,phone_number,consent,evidence)
      values(lead,link.client_id,mobile,'opted_in','Affirmative WhatsApp opt-in on the website form, capture link '||link.id::text);
  end if;
  return 'accepted';
end;
$$;

create function public.claim_whatsapp_jobs(sender_client uuid)
returns table(message_id uuid,recipient text,message_kind text) language plpgsql security invoker set search_path='' as $$
begin
  update public.whatsapp_messages m set status='skipped',reason='ineligible',updated_at=clock_timestamp()
    from public.leads l,public.clients c
    where m.client_id=sender_client and l.id=m.lead_id and l.client_id=m.client_id and c.id=m.client_id
      and m.status='queued' and m.scheduled_at<=now()
      and (l.consent_status<>'opted_in' or l.whatsapp_number is null or c.status<>'active'
        or l.status in ('booked','won','lost') or l.last_reply_at is not null
        or (m.kind='follow_up' and l.last_contact_at is null));
  return query
    with next_jobs as (
      select m.id,l.whatsapp_number
      from public.whatsapp_messages m join public.leads l on l.id=m.lead_id and l.client_id=m.client_id
      join public.clients c on c.id=m.client_id
      where m.client_id=sender_client and m.status='queued' and m.scheduled_at<=now()
        and l.consent_status='opted_in' and l.whatsapp_number is not null and c.status='active'
        and l.status not in ('booked','won','lost') and l.last_reply_at is null
        and (m.kind='welcome' or l.last_contact_at<=now()-interval '24 hours')
        and not exists(select 1 from public.whatsapp_messages earlier
          where earlier.lead_id=m.lead_id and m.kind='follow_up' and earlier.kind='welcome' and earlier.status='queued')
        and not exists(select 1 from public.whatsapp_messages older where older.lead_id=m.lead_id and older.id<>m.id
          and older.attempted_at>now()-interval '24 hours' and older.status in ('sending','accepted','sent','delivered','read','unknown'))
      order by m.scheduled_at,m.id limit 10 for update of m,l skip locked
    ), changed as (
      update public.whatsapp_messages m set status='sending',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
       from next_jobs n where m.id=n.id
      returning m.id,n.whatsapp_number,m.kind
    ) select * from changed;
end;
$$;

create function public.record_whatsapp_reply(sender_client uuid,provider_event text,phone_value text,unsubscribe boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare l public.leads; seen text;
begin
  insert into tsols_private.whatsapp_webhook_events(provider_id) values(provider_event) on conflict do nothing returning provider_id into seen;
  if seen is null then return; end if;
  select * into l from public.leads where client_id=sender_client and whatsapp_number=tsols_private.lead_phone(phone_value)
    order by created_at desc limit 1 for update;
  if not found then return; end if;
  update public.leads set last_reply_at=clock_timestamp() where id=l.id;
  insert into public.lead_activities(lead_id,client_id,action,detail)
    values(l.id,l.client_id,'WhatsApp reply received',case when unsubscribe then 'Opt-out request' else 'Review reply in WhatsApp' end);
  if unsubscribe and l.consent_status<>'opted_out' then
    insert into public.messaging_consents(lead_id,client_id,phone_number,consent,evidence)
      values(l.id,l.client_id,l.whatsapp_number,'opted_out','Opt-out received from the lead via approved WhatsApp webhook.');
  end if;
end;
$$;

create function tsols_private.log_whatsapp_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or new.status is distinct from old.status then
    insert into public.lead_activities(lead_id,client_id,action,detail)
      values(new.lead_id,new.client_id,'WhatsApp '||replace(new.kind,'_',' '),new.status);
  end if;
  if tg_op='UPDATE' and old.status='sending' and new.status='accepted' then
    update public.leads set last_contact_at=clock_timestamp() where id=new.lead_id;
    if new.kind='welcome' then
      insert into public.whatsapp_messages(lead_id,client_id,kind,scheduled_at)
      select new.lead_id,new.client_id,'follow_up',clock_timestamp()+interval '24 hours'
      from public.whatsapp_settings s where s.client_id=new.client_id and s.follow_up_enabled
      on conflict(lead_id,kind) do nothing;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function tsols_private.log_whatsapp_delivery() from public,anon,authenticated;
create trigger whatsapp_delivery_history after insert or update on public.whatsapp_messages
for each row execute function tsols_private.log_whatsapp_delivery();

revoke all on function public.capture_website_lead(text,jsonb),public.claim_whatsapp_jobs(uuid),
  public.record_whatsapp_reply(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.capture_website_lead(text,jsonb),public.claim_whatsapp_jobs(uuid),
  public.record_whatsapp_reply(uuid,text,text,boolean) to service_role;

commit;
