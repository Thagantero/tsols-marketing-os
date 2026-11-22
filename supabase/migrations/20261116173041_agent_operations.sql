begin;

create type public.agent_kind as enum ('content','engagement','lead','reporting','strategy','design','publishing');

create table public.agent_assignments (
  client_id uuid not null references public.clients(id) on delete restrict,
  agent public.agent_kind not null,
  enabled boolean not null default true,
  cadence text check(cadence in ('daily','weekly')),
  configured_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key(client_id,agent),
  check(agent<>'engagement' or cadence is null)
);
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  agent public.agent_kind not null,
  mode text not null check(mode='standard' or (mode='ai' and agent in ('content','design'))),
  brief text not null default '' check(length(brief)<=1600 and (mode='standard' or brief='')),
  status text not null default 'awaiting_approval' check(status in ('awaiting_approval','queued','running','completed','failed','cancelled')),
  recurring_period date,
  requested_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  attempts integer not null default 0 check(attempts between 0 and 2),
  evidence jsonb,
  recommendation text check(length(recommendation)<=6000),
  failure text,
  foreign key(client_id,agent) references public.agent_assignments(client_id,agent) on delete restrict,
  unique(id,client_id),
  unique(client_id,agent,recurring_period)
);
create unique index agent_tasks_open_manual_idx on public.agent_tasks(client_id,agent,mode,md5(brief))
  where recurring_period is null and status in ('awaiting_approval','queued','running');
create index agent_tasks_client_idx on public.agent_tasks(client_id,created_at desc,id);
create index agent_tasks_dispatch_idx on public.agent_tasks(mode,approved_at,id) where status='queued';
create index agent_tasks_running_idx on public.agent_tasks(started_at,id) where status='running';

create table public.agent_events (
  id bigint generated always as identity primary key,
  task_id uuid not null,
  client_id uuid not null,
  event text not null check(event in ('requested','approved','started','completed','failed','requeued','cancelled')),
  attempt integer not null default 0,
  detail text,
  model text,
  input_tokens integer check(input_tokens>=0),
  output_tokens integer check(output_tokens>=0),
  estimated_usd numeric(12,6) check(estimated_usd>=0),
  created_at timestamptz not null default now(),
  foreign key(task_id,client_id) references public.agent_tasks(id,client_id) on delete restrict
);
create index agent_events_client_idx on public.agent_events(client_id,created_at desc,id desc);
create index agent_events_task_idx on public.agent_events(task_id,id);

alter table public.agent_assignments enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_events enable row level security;
revoke all on public.agent_assignments,public.agent_tasks,public.agent_events from public,anon,authenticated;
grant select on public.agent_assignments,public.agent_tasks,public.agent_events to authenticated;
create policy agent_assignments_admin on public.agent_assignments for select to authenticated
  using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=agent_assignments.client_id and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy agent_tasks_admin on public.agent_tasks for select to authenticated
  using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=agent_tasks.client_id and m.user_id=(select auth.uid()) and m.role='administrator'));
create policy agent_events_admin on public.agent_events for select to authenticated
  using (exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=agent_events.client_id and m.user_id=(select auth.uid()) and m.role='administrator'));

create function tsols_private.agent_admin(target_client uuid)
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.clients c join public.agency_memberships m on m.agency_id=c.agency_id
    where c.id=target_client and m.user_id=auth.uid() and m.role='administrator')
$$;

create function tsols_private.record_agent_event(task public.agent_tasks,event text,detail text default null,
  model text default null,tokens_in integer default null,tokens_out integer default null,price numeric default null)
returns void language sql set search_path='' as $$
  insert into public.agent_events(task_id,client_id,event,attempt,detail,model,input_tokens,output_tokens,estimated_usd)
  values(task.id,task.client_id,event,task.attempts,detail,model,tokens_in,tokens_out,price)
$$;

create function tsols_private.agent_evidence(job public.agent_tasks)
returns jsonb language plpgsql stable set search_path='' as $$
declare latest public.reports; facts jsonb:='{}'; day_start timestamptz;
begin
  day_start:=now()-interval '30 days';
  if job.agent in ('lead','strategy') then
    select jsonb_build_object('leads_in_last_30_days',count(*),'new_leads',count(*) filter(where status='new'),
      'hot_open_leads',count(*) filter(where priority='hot' and status not in ('won','lost')),
      'overdue_follow_ups',count(*) filter(where next_follow_up_at<now() and status not in ('won','lost')))
    into facts from public.leads where client_id=job.client_id and created_at>=day_start;
  end if;
  if job.agent in ('reporting','strategy') then
    select * into latest from public.reports where client_id=job.client_id and status='approved'
      order by period_end desc,version desc,approved_at desc limit 1;
    facts:=facts||jsonb_build_object('approved_report_available',found);
    if latest.id is not null then
      facts:=facts||jsonb_build_object('report_period_start',latest.period_start,'report_period_end',latest.period_end,
        'partial_period',latest.partial_period,'confirmed_posts',latest.metrics->'posts_published',
        'failed_deliveries',latest.metrics->'failed_deliveries','crm_leads',latest.metrics->'new_leads',
        'qualified_leads',latest.metrics->'qualified_leads','ad_impressions',latest.metrics->'ad_impressions',
        'ad_clicks',latest.metrics->'ad_clicks','reported_ad_leads',latest.metrics->'ad_leads');
    end if;
  end if;
  if job.agent in ('publishing','content','design') then
    select jsonb_build_object('upcoming_plans',count(*) filter(where q.scheduled_at>now() and q.schedule_cancelled_at is null),
      'approved_items',count(*) filter(where q.status='approved'),
      'items_awaiting_content_review',count(*) filter(where q.status='pending_approval'))
    into facts from public.content_calendar q where q.client_id=job.client_id and q.updated_at>=day_start;
    if job.agent='publishing' then
      facts:=facts||(select jsonb_build_object('delivery_errors',count(*) filter(where d.provider_status='error' or d.status='rejected'),
        'unconfirmed_deliveries',count(*) filter(where d.status='unknown'))
        from public.publishing_deliveries d where d.client_id=job.client_id and d.submitted_at>=day_start);
    end if;
  end if;
  return facts;
end;
$$;

create function tsols_private.standard_agent_recommendation(job public.agent_tasks,facts jsonb)
returns text language plpgsql immutable set search_path='' as $$
begin
  case job.agent
    when 'content' then return 'Idea: Answer a question customers often ask. Turn the answer into a 3-step carousel or a 20-second video.'||E'\n\n'||
      'Caption draft: Curious how this works? Start with one practical step you can try today. Save this guide or ask us a question.'||E'\n\n'||
      'Hashtag starters: #QuickTips #AskUs. Add a verified industry or location tag.'||E'\n\n'||
      'Creative brief: Open with the question, show one action per scene, then close with the business’s call to action.';
    when 'engagement' then
      if lower(job.brief) ~ '(refund|complaint|scam|worst|broken|never received|angry|terrible)' then
        return 'Suggested classification: Complaint or support issue. Escalate to a team member.'||E'\n\n'||
          'Reply draft: Thanks for telling us. We’d like to understand what happened and help. Please message us privately with the relevant details.';
      elsif job.brief ~ '\?' then
        return 'Suggested classification: Question. Check the correct answer with the business.'||E'\n\n'||
          'Reply draft: Thanks for asking. We’ll check the details and get back to you with an answer.';
      else
        return 'Suggested classification: General comment. Review the tone before replying.'||E'\n\n'||
          'Reply draft: Thanks for taking the time to share your feedback.';
      end if;
    when 'lead' then return
      case when coalesce((facts->>'hot_open_leads')::int,0)>0 then 'Review hot open leads first. ' else 'Review newly captured leads for service fit and intent. ' end||
      'Check open follow-ups and consent before contacting anyone.'||E'\n\n'||
      'Follow-up draft: Hi, thanks for your interest. What would you like help with and when would be a good time to talk?';
    when 'reporting' then return
      case when (facts->>'approved_report_available')::boolean
        then 'Use the latest approved snapshot as the basis for your observations. Compare confirmed publishing, CRM leads and imported advertising with a comparable approved period before drawing conclusions.'
        else 'Generate and approve a report snapshot before writing a performance summary.' end;
    when 'strategy' then return
      case when (facts->>'approved_report_available')::boolean
        then 'Test two variants of one call to action. Keep the offer and audience consistent. Compare confirmed publishing, clicks and qualified leads in comparable reporting windows.'
        else 'Establish a baseline by approving a report and recording how incoming leads found the business. Then test one change at a time.' end;
    when 'design' then return 'Poster concept: Lead with one clear benefit, place a single product or service image in the centre, and leave room for a short call to action. Verify the approved logo, colours and imagery in Content Studio.';
    when 'publishing' then return
      case when coalesce((facts->>'delivery_errors')::int,0)+coalesce((facts->>'unconfirmed_deliveries')::int,0)>0
        then 'Check failed or unconfirmed deliveries in Publishing and confirm their state in Buffer before retrying. '
        else 'Review upcoming slots and confirm the destination accounts. ' end||
      'Open the content revision in Content Studio to use the usual publishing controls.';
  end case;
end;
$$;

create function tsols_private.configure_agent(target_client uuid,kind public.agent_kind,enabled boolean,recurrence text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not tsols_private.agent_admin(target_client) or not exists(select 1 from public.clients where id=target_client and status<>'archived')
    then raise exception 'This client is unavailable.' using errcode='42501'; end if;
  insert into public.agent_assignments(client_id,agent,enabled,cadence,configured_by)
  values(target_client,kind,enabled,recurrence,auth.uid())
  on conflict(client_id,agent) do update set enabled=excluded.enabled,cadence=excluded.cadence,
    updated_at=now(),configured_by=excluded.configured_by;
end;
$$;

create function tsols_private.request_agent_task(target_client uuid,kind public.agent_kind,execution_mode text,request_brief text)
returns uuid language plpgsql security definer set search_path='' as $$
declare job public.agent_tasks; normalized text:=btrim(coalesce(request_brief,'')); active boolean;
begin
  if not tsols_private.agent_admin(target_client) or not exists(select 1 from public.clients where id=target_client and status<>'archived')
    then raise exception 'This client is unavailable.' using errcode='42501'; end if;
  if execution_mode is null or execution_mode not in ('standard','ai') or length(normalized)>1600
    or (execution_mode='ai' and (normalized<>'' or kind not in ('content','design'))) or (kind='engagement' and normalized='')
    then raise exception 'Check the execution mode and task brief.'; end if;
  select enabled into active from public.agent_assignments where client_id=target_client and agent=kind for update;
  if not coalesce(active,false) then raise exception 'Enable this agent for the business first.'; end if;
  select * into job from public.agent_tasks where client_id=target_client and agent=kind
    and mode=execution_mode and brief=normalized and recurring_period is null
    and status in ('awaiting_approval','queued','running') limit 1;
  if found then return job.id; end if;
  if (select count(*) from public.agent_tasks where client_id=target_client and agent=kind
    and status in ('awaiting_approval','queued','running'))>=20 then raise exception 'This agent has 20 open tasks. Review the queue first.'; end if;
  insert into public.agent_tasks(client_id,agent,mode,brief,requested_by)
    values(target_client,kind,execution_mode,normalized,auth.uid()) returning * into job;
  perform tsols_private.record_agent_event(job,'requested');
  return job.id;
end;
$$;

create function tsols_private.transition_agent_task(task_id uuid,action text)
returns void language plpgsql security definer set search_path='' as $$
declare job public.agent_tasks; next_status text; event text;
begin
  select * into job from public.agent_tasks where id=task_id for update;
  if not found or not tsols_private.agent_admin(job.client_id)
    then raise exception 'This task is unavailable.' using errcode='42501'; end if;
  case
    when action='approve' and job.status='awaiting_approval' then next_status:='queued';event:='approved';
    when action='retry' and job.status='failed' and job.attempts<2 then next_status:='queued';event:='requeued';
    when action='cancel' and job.status in ('awaiting_approval','queued','failed') then next_status:='cancelled';event:='cancelled';
    else raise exception 'This task cannot make that transition.';
  end case;
  if action<>'cancel' and not exists(select 1 from public.agent_assignments a join public.clients c on c.id=a.client_id
    where a.client_id=job.client_id and a.agent=job.agent and a.enabled and c.status<>'archived')
    then raise exception 'Resume this agent before continuing.'; end if;
  update public.agent_tasks set status=next_status,updated_at=clock_timestamp(),failure=null,
    approved_at=case when action='approve' then clock_timestamp() else approved_at end,
    approved_by=case when action='approve' then auth.uid() else approved_by end
    where id=task_id returning * into job;
  perform tsols_private.record_agent_event(job,event);
end;
$$;

create function tsols_private.start_agent_task(task_id uuid, execution_mode text, operator uuid)
returns public.agent_tasks language plpgsql security definer set search_path='' as $$
declare job public.agent_tasks;
begin
  select t.* into job from public.agent_tasks t
    join public.agent_assignments a on a.client_id=t.client_id and a.agent=t.agent
    join public.clients c on c.id=t.client_id
    where t.id=task_id and t.mode=execution_mode and t.status='queued' and t.approved_at is not null
      and t.attempts<2 and a.enabled and c.status<>'archived'
      and (operator is null or exists(select 1 from public.agency_memberships m where m.agency_id=c.agency_id
        and m.user_id=operator and m.role='administrator'))
    for update of t skip locked
    for share of a,c skip locked;
  if not found then return null; end if;
  update public.agent_tasks set status='running',attempts=attempts+1,started_at=clock_timestamp(),
    updated_at=clock_timestamp(),evidence=tsols_private.agent_evidence(job),failure=null
    where id=task_id returning * into job;
  perform tsols_private.record_agent_event(job,'started');
  return job;
end;
$$;

create function tsols_private.finish_agent_task(task_id uuid,attempt integer,output_text text,error_text text,model text,
  tokens_in integer,tokens_out integer,price numeric)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.agent_tasks; final_status text:=case when error_text is null then 'completed' else 'failed' end;
begin
  update public.agent_tasks t set status=final_status,recommendation=output_text,failure=error_text,
    updated_at=clock_timestamp() where t.id=task_id and t.status='running' and t.attempts=attempt returning * into job;
  if not found then return false; end if;
  perform tsols_private.record_agent_event(job,final_status,error_text,model,tokens_in,tokens_out,price);
  return true;
end;
$$;

create function tsols_private.run_standard_agent(task_id uuid,operator uuid)
returns boolean language plpgsql set search_path='' as $$
declare job public.agent_tasks;
begin
  job:=tsols_private.start_agent_task(task_id,'standard',operator);
  if job.id is null then return false; end if;
  begin
    return tsols_private.finish_agent_task(job.id,job.attempts,
      tsols_private.standard_agent_recommendation(job,job.evidence),null,null,null,null,0);
  exception when others then
    perform tsols_private.finish_agent_task(job.id,job.attempts,null,'Could not build this recommendation. Review the input and retry.',null,null,null,null);
    return false;
  end;
end;
$$;

create function tsols_private.run_manual_agent(task_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then return false; end if;
  return tsols_private.run_standard_agent(task_id,auth.uid());
end;
$$;

create function public.configure_agent(target_client uuid,kind public.agent_kind,enabled boolean,recurrence text)
returns void language sql set search_path='' as $$ select tsols_private.configure_agent(target_client,kind,enabled,recurrence) $$;
create function public.request_agent_task(target_client uuid,kind public.agent_kind,execution_mode text,request_brief text)
returns uuid language sql set search_path='' as $$ select tsols_private.request_agent_task(target_client,kind,execution_mode,request_brief) $$;
create function public.transition_agent_task(task_id uuid,action text)
returns void language sql set search_path='' as $$ select tsols_private.transition_agent_task(task_id,action) $$;
create function public.run_manual_agent(task_id uuid)
returns boolean language sql set search_path='' as $$ select tsols_private.run_manual_agent(task_id) $$;
create function public.start_ai_agent(task_id uuid,operator uuid)
returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('id',task.id,'client_id',task.client_id,'attempts',task.attempts)
  from tsols_private.start_agent_task(task_id,'ai',operator) task where operator is not null and task.id is not null
$$;
create function public.finish_ai_agent(task_id uuid,attempt integer,output_text text,error_text text,model text,tokens_in integer,tokens_out integer,price numeric)
returns boolean language sql set search_path='' as $$
  select tsols_private.finish_agent_task(task_id,attempt,output_text,error_text,model,tokens_in,tokens_out,price)
$$;

create function public.agent_dashboard(target_client uuid)
returns table(agent public.agent_kind, completed bigint, review bigint, failed bigint, last_execution timestamptz,
  input_tokens bigint, output_tokens bigint, estimated_usd numeric, unpriced bigint)
language sql stable security invoker set search_path='' as $$
  with task_stats as (
    select t.agent,count(*) filter(where status='completed') completed,
      count(*) filter(where status='awaiting_approval') review,count(*) filter(where status='failed') failed
    from public.agent_tasks t where t.client_id=target_client group by t.agent
  ), run_stats as (
    select t.agent,max(e.created_at) filter(where event='started') last_execution,
      coalesce(sum(e.input_tokens),0) input_tokens,coalesce(sum(e.output_tokens),0) output_tokens,
      coalesce(sum(e.estimated_usd),0) estimated_usd,
      count(*) filter(where t.mode='ai' and (e.input_tokens is not null or e.output_tokens is not null) and e.estimated_usd is null) unpriced
    from public.agent_events e join public.agent_tasks t on t.id=e.task_id and t.client_id=e.client_id
    where e.client_id=target_client group by t.agent
  )
  select a.agent,coalesce(t.completed,0),coalesce(t.review,0),coalesce(t.failed,0),e.last_execution,
    coalesce(e.input_tokens,0),coalesce(e.output_tokens,0),coalesce(e.estimated_usd,0),coalesce(e.unpriced,0)
  from public.agent_assignments a left join task_stats t on t.agent=a.agent left join run_stats e on e.agent=a.agent
  where a.client_id=target_client
$$;
revoke all on function public.agent_dashboard(uuid) from public,anon;
grant execute on function public.agent_dashboard(uuid) to authenticated;

create table tsols_private.agent_worker_heartbeat (
  singleton boolean primary key default true check(singleton),
  completed_at timestamptz not null
);
revoke all on tsols_private.agent_worker_heartbeat from public,anon,authenticated;

create function tsols_private.agent_worker_last_tick(target_client uuid)
returns timestamptz language sql stable security definer set search_path='' as $$
  select completed_at from tsols_private.agent_worker_heartbeat
  where tsols_private.agent_admin(target_client)
$$;
create function public.agent_worker_last_tick(target_client uuid)
returns timestamptz language sql stable set search_path='' as $$
  select tsols_private.agent_worker_last_tick(target_client)
$$;
revoke all on function public.agent_worker_last_tick(uuid),tsols_private.agent_worker_last_tick(uuid) from public,anon;
grant execute on function public.agent_worker_last_tick(uuid),tsols_private.agent_worker_last_tick(uuid) to authenticated;

create function tsols_private.agent_tick()
returns integer language plpgsql set search_path='' as $$
declare task public.agent_tasks; stalled record; today date:=(now() at time zone 'Africa/Nairobi')::date;
  work record; completed integer:=0;
begin
  for stalled in select id,attempts from public.agent_tasks where status='running' and started_at<now()-interval '10 minutes'
    order by started_at limit 30 for update skip locked
  loop
    perform tsols_private.finish_agent_task(stalled.id,stalled.attempts,null,'Execution timed out. Check any provider usage before retrying.',null,null,null,null);
  end loop;

  for task in
    insert into public.agent_tasks(client_id,agent,mode,status,recurring_period,requested_by,approved_by,approved_at)
    select a.client_id,a.agent,'standard','queued',
      case a.cadence when 'daily' then today else date_trunc('week',today::timestamp)::date end,
      a.configured_by,a.configured_by,now()
      from public.agent_assignments a join public.clients c on c.id=a.client_id
      where a.enabled and a.cadence is not null and c.status='active' and a.configured_by is not null
      and exists(select 1 from public.agency_memberships m where m.agency_id=c.agency_id and m.user_id=a.configured_by and m.role='administrator')
      and extract(hour from now() at time zone 'Africa/Nairobi')>=8
    on conflict(client_id,agent,recurring_period) do nothing returning *
  loop
    perform tsols_private.record_agent_event(task,'requested','Recurring workflow');
    perform tsols_private.record_agent_event(task,'approved','Recurring permission');
  end loop;

  for work in select t.id from public.agent_tasks t join public.agent_assignments a
    on a.client_id=t.client_id and a.agent=t.agent join public.clients c on c.id=t.client_id
    where t.status='queued' and t.mode='standard' and a.enabled and c.status<>'archived'
    order by t.approved_at,t.id limit 20 for update of t skip locked
  loop
    if tsols_private.run_standard_agent(work.id,null) then completed:=completed+1; end if;
  end loop;
  insert into tsols_private.agent_worker_heartbeat(singleton,completed_at) values(true,clock_timestamp())
    on conflict(singleton) do update set completed_at=excluded.completed_at;
  return completed;
end;
$$;

revoke all on function tsols_private.agent_admin(uuid),
  tsols_private.record_agent_event(public.agent_tasks,text,text,text,integer,integer,numeric),
  tsols_private.agent_evidence(public.agent_tasks),tsols_private.standard_agent_recommendation(public.agent_tasks,jsonb),
  tsols_private.configure_agent(uuid,public.agent_kind,boolean,text),tsols_private.request_agent_task(uuid,public.agent_kind,text,text),
  tsols_private.transition_agent_task(uuid,text),tsols_private.start_agent_task(uuid,text,uuid),
  tsols_private.finish_agent_task(uuid,integer,text,text,text,integer,integer,numeric),tsols_private.run_standard_agent(uuid,uuid),
  tsols_private.run_manual_agent(uuid),tsols_private.agent_tick(),
  public.configure_agent(uuid,public.agent_kind,boolean,text),public.request_agent_task(uuid,public.agent_kind,text,text),
  public.transition_agent_task(uuid,text),public.run_manual_agent(uuid),
  public.start_ai_agent(uuid,uuid),public.finish_ai_agent(uuid,integer,text,text,text,integer,integer,numeric)
  from public,anon,authenticated;
grant execute on function tsols_private.configure_agent(uuid,public.agent_kind,boolean,text),
  tsols_private.request_agent_task(uuid,public.agent_kind,text,text),tsols_private.transition_agent_task(uuid,text),
  tsols_private.run_manual_agent(uuid),public.configure_agent(uuid,public.agent_kind,boolean,text),
  public.request_agent_task(uuid,public.agent_kind,text,text),public.transition_agent_task(uuid,text),public.run_manual_agent(uuid)
  to authenticated;
grant usage on schema tsols_private to service_role;
grant execute on function tsols_private.start_agent_task(uuid,text,uuid),
  tsols_private.finish_agent_task(uuid,integer,text,text,text,integer,integer,numeric),
  public.start_ai_agent(uuid,uuid),public.finish_ai_agent(uuid,integer,text,text,text,integer,integer,numeric)
  to service_role;

commit;
