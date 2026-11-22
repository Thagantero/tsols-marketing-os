import {useEffect,useState,type FormEvent} from 'react';
import {Activity,Bot,ClipboardList,Clock3,Pause,Play,Plus,RefreshCw} from 'lucide-react';
import {Button} from './components/ui/button';
import {displayDate,supabase} from './data';

const agents={
  content:['Content','Ideas, captions, hashtags and creative briefs.'],
  engagement:['Engagement','Classify a pasted comment and draft a reply.'],
  lead:['Lead','Review lead activity and draft a follow-up.'],
  reporting:['Reporting','Summarize the latest approved report.'],
  strategy:['Strategy','Suggest measurable improvements from recorded results.'],
  design:['Design','Draft poster and layout concepts.'],
  publishing:['Publishing','Review upcoming plans and delivery exceptions.'],
} as const;
type Kind=keyof typeof agents;
type Mode='standard'|'ai';
type Cadence=''|'daily'|'weekly';
type Status='awaiting_approval'|'queued'|'running'|'completed'|'failed'|'cancelled';
type Assignment={agent:Kind;enabled:boolean;cadence:Cadence|null};
type Task={id:string;agent:Kind;status:Status;mode:Mode;brief:string;recurring_period:string|null;attempts:number;created_at:string;
  updated_at:string;evidence:Record<string,string|number|boolean|null>|null;recommendation:string|null;failure:string|null};
type Event={id:number;task_id:string;event:string;attempt:number;detail:string|null;model:string|null;input_tokens:number|null;
  output_tokens:number|null;estimated_usd:number|null;created_at:string;agent_tasks:{agent:Kind}|null};
type Summary={agent:Kind;completed:number;review:number;failed:number;last_execution:string|null;input_tokens:number;output_tokens:number;
  estimated_usd:number;unpriced:number};
type Client={id:string;business_name:string};
const kinds=Object.keys(agents) as Kind[];
const statusText:Record<Status,string>={awaiting_approval:'Needs approval',queued:'Queued',running:'Running',
  completed:'Completed',failed:'Failed',cancelled:'Cancelled'};
const pageSize=15;
const fields='id,agent,status,mode,brief,recurring_period,attempts,created_at,updated_at,evidence,recommendation,failure';
const money=new Intl.NumberFormat('en-KE',{style:'currency',currency:'USD',maximumFractionDigits:6});
const readable=(key:string)=>key.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());

export function AgentOperations({agencyId,automation}:{agencyId:string;automation:boolean}) {
  const [clients,setClients]=useState<Client[]>();
  const [clientId,setClientId]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name').eq('agency_id',agencyId).neq('status','archived')
      .order('business_name').then(result=>{
        if(!active)return;
        if(result.error){setError('Could not load clients. Refresh and try again.');return;}
        setClients(result.data);setClientId(result.data[0]?.id??'');
      });
    return()=>{active=false;};
  },[agencyId]);

  return <>
    <header className="page-heading"><div><h1>{automation?'Automations':'AI Agents'}</h1>
      <p>{automation?'Monitor approved workflows, failures and execution history.':'Assign agents, approve tasks and review their recommendations.'}</p></div>
      {Boolean(clients?.length)&&<label>Client<select value={clientId} onChange={event=>setClientId(event.target.value)}>
        {clients?.map(client=><option value={client.id} key={client.id}>{client.business_name}</option>)}</select></label>}
    </header>
    {error?<p className="error" role="alert">{error}</p>:!clients?<p role="status">Loading clients…</p>:!clientId?
      <section className="panel form-section"><p>Add a client to start assigning agents.</p><a className="text-link" href="#/clients">Open Clients</a></section>:
      <ClientOperations key={clientId+(automation?'automation':'agents')} clientId={clientId} automation={automation}/>}
  </>;
}

function ClientOperations({clientId,automation}:{clientId:string;automation:boolean}) {
  const [assignments,setAssignments]=useState<Assignment[]>([]);
  const [summaries,setSummaries]=useState<Summary[]>([]);
  const [tasks,setTasks]=useState<Task[]>();
  const [events,setEvents]=useState<Event[]>([]);
  const [lastTick,setLastTick]=useState<string|null>();
  const [filter,setFilter]=useState<Status|''>('');
  const [taskPage,setTaskPage]=useState(0);
  const [logPage,setLogPage]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [selected,setSelected]=useState<Kind>('content');
  const [mode,setMode]=useState<Mode>('standard');
  const supportsAI=selected==='content'||selected==='design';
  const executionMode:Mode=supportsAI?mode:'standard';
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [confirm,setConfirm]=useState<{task:Task;action:'approve'|'retry'|'cancel'|'run'}>();
  const update=()=>setRefresh(value=>value+1);

  useEffect(()=>{
    const db=supabase;
    if(!db)return;
    let active=true,loading=false;
    async function load(){
      if(!db||loading)return;
      loading=true;
      const base=db.from('agent_tasks').select(fields).eq('client_id',clientId).order('created_at',{ascending:false}).order('id');
      const results=await Promise.all([
        db.from('agent_assignments').select('agent,enabled,cadence').eq('client_id',clientId),
        db.rpc('agent_dashboard',{target_client:clientId}),
        (filter?base.eq('status',filter):base).range(taskPage*pageSize,taskPage*pageSize+pageSize),
        automation?db.from('agent_events').select('id,task_id,event,attempt,detail,model,input_tokens,output_tokens,estimated_usd,created_at,agent_tasks(agent)')
          .eq('client_id',clientId).order('id',{ascending:false}).range(logPage*pageSize,logPage*pageSize+pageSize):null,
        automation?db.rpc('agent_worker_last_tick',{target_client:clientId}):null,
      ]);
      loading=false;
      if(!active)return;
      if(results.some(result=>result?.error)){setError('Could not load agent operations. Refresh and try again.');return;}
      setAssignments(results[0].data as Assignment[]);
      setSummaries(results[1].data as Summary[]);
      setTasks(results[2].data as Task[]);
      if(results[3])setEvents(results[3].data as unknown as Event[]);
      if(results[4])setLastTick(results[4].data);
    }
    void load();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);
    return()=>{active=false;window.clearInterval(timer);};
  },[clientId,refresh,filter,taskPage,logPage,automation]);

  async function configure(kind:Kind,enabled:boolean,cadence:Cadence) {
    if(!supabase||busy)return;
    if(enabled && cadence && !window.confirm('Allow this agent to create a read-only standard recommendation on this schedule?'))return;
    setBusy(true);setNotice('');setError('');
    const result=await supabase.rpc('configure_agent',{target_client:clientId,kind,enabled,recurrence:cadence||null});
    setBusy(false);
    if(result.error){setError('Could not update the assignment.');return;}
    setNotice(enabled?'Agent assignment updated.':'Agent paused.');update();
  }

  async function request(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!supabase||busy)return;
    const form=event.currentTarget;
    const brief=String(new FormData(form).get('brief')??'').trim();
    setBusy(true);setError('');setNotice('');
    const result=await supabase.rpc('request_agent_task',{target_client:clientId,kind:selected,execution_mode:executionMode,request_brief:brief});
    setBusy(false);
    if(result.error){setError(result.error.code==='P0001'?result.error.message:'Could not create the task.');return;}
    form.reset();setFilter('');setTaskPage(0);setNotice('Task is awaiting approval.');update();
  }

  async function apply() {
    if(!supabase||!confirm||busy)return;
    const {task,action}=confirm;
    setBusy(true);setError('');setNotice('');
    try {
      if(action==='run'&&task.mode==='ai'){
        const result=await supabase.functions.invoke('run-agent',{body:{task_id:task.id,confirmed:true}});
        if(result.error){
          const body=await (result.error.context as Response|undefined)?.json?.().catch(()=>null);
          setError(typeof body?.message==='string'?body.message:'Could not confirm AI execution. Check the task and execution log.');
          return;
        }
      }else if(action==='run'){
        const result=await supabase.rpc('run_manual_agent',{task_id:task.id});
        if(result.error||!result.data){setError('This task could not be started. Inspect its status and agent assignment.');return;}
      }else {
        const result=await supabase.rpc('transition_agent_task',{task_id:task.id,action});
        if(result.error){setError(result.error.code==='P0001'?result.error.message:'Could not update this task.');return;}
      }
      setNotice(action==='run'?'Recommendation saved for review.':action==='cancel'?'Task cancelled.':'Task queued.');
    } finally {
      setBusy(false);setConfirm(undefined);update();
    }
  }

  const assignment=assignments.find(item=>item.agent===selected);
  return <>
    {error&&<p className="error notice" role="alert">{error}</p>}
    {notice&&<p className="notice" role="status">{notice}</p>}
    {!automation?<div className="agent-grid">{kinds.map(kind=>{
      const item=assignments.find(entry=>entry.agent===kind);
      const summary=summaries.find(entry=>entry.agent===kind);
      return <section className="panel agent-card" key={kind}>
        <div className="agent-card-title"><span className="event-icon"><Bot size={18}/></span><h2>{agents[kind][0]}</h2>
          <span className="agent-status">{item?.enabled?'Active':item?'Paused':'Unassigned'}</span></div>
        <p className="muted">{agents[kind][1]}</p>
        <dl className="agent-metrics">
          <div><dt>Completed</dt><dd>{summary?.completed??0}</dd></div><div><dt>Needs review</dt><dd>{summary?.review??0}</dd></div>
          <div><dt>Failed</dt><dd>{summary?.failed??0}</dd></div>
        </dl>
        <p className="muted">{summary?.last_execution?'Last run '+displayDate(summary.last_execution):'No runs yet'}</p>
        {summary&&<p className="muted">{summary.input_tokens+summary.output_tokens} AI tokens · {summary.unpriced?
          (summary.estimated_usd?money.format(summary.estimated_usd)+' priced · some runs unpriced':'Cost estimate unavailable'):
          money.format(summary.estimated_usd)+' estimated'}</p>}
        <div className="portal-actions">
          <Button variant="outline" disabled={busy} onClick={()=>void configure(kind,!item?.enabled,item?.cadence??'')}>
            {item?.enabled?<Pause size={15}/>:<Play size={15}/>} {item?.enabled?'Pause':item?'Resume':'Assign'}</Button>
          {item?.enabled&&<Button variant="ghost" onClick={()=>{setSelected(kind);document.getElementById('agent-request')?.scrollIntoView({block:'start'});}}>New task</Button>}
        </div>
      </section>;
    })}</div>:<section className="panel form-section agent-section">
      <h2><Clock3 size={20}/> Recurring workflows</h2>
      <p className="muted">{lastTick===undefined?'Checking scheduler…':lastTick===null?'Waiting for the first scheduler check':
        (Date.now()-Date.parse(lastTick)>6*60_000?'Scheduler check overdue · ':'Last scheduler check · ')+displayDate(lastTick)}</p>
      <p className="muted">Standard recommendations are queued from 8:00 a.m. Nairobi time. Weekly runs use Monday as the start of the week. OpenAI runs require manual confirmation.</p>
      {assignments.length===0?<p>Assign an agent under <a className="text-link" href="#/agents">AI Agents</a> to set its schedule.</p>:
        <div className="agent-schedule">{assignments.map(item=><label key={item.agent}>{agents[item.agent][0]} {item.enabled?'':'(paused)'}
          <select disabled={busy||item.agent==='engagement'} value={item.cadence??''} onChange={event=>void configure(item.agent,item.enabled,event.target.value as Cadence)}>
            <option value="">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>)}</div>}
    </section>}
    {!automation&&<section className="panel form-section agent-section" id="agent-request">
      <h2><Plus size={20}/> Request a task</h2>
      <form onSubmit={request}>
        <div className="form-grid">
          <label>Agent<select value={selected} onChange={event=>setSelected(event.target.value as Kind)}>
            {kinds.map(kind=><option key={kind} value={kind}>{agents[kind][0]}</option>)}</select></label>
          <label>Execution mode<select value={executionMode} onChange={event=>setMode(event.target.value as Mode)}>
            <option value="standard">Standard · uses workspace data</option>{supportsAI&&<option value="ai">Generic AI ideas · uses OpenAI</option>}</select></label>
          {selected==='engagement'&&<label className="form-wide">Comment without personal details
            <textarea rows={3} name="brief" maxLength={1600} required={selected==='engagement'}/></label>}
        </div>
        {!assignment?.enabled&&<p className="muted">Assign or resume this agent before requesting a task.</p>}
        {executionMode==='ai'&&<p className="muted">OpenAI receives a fixed template for generic ideas.</p>}
        <Button disabled={busy||!assignment?.enabled}>Request approval</Button>
      </form>
    </section>}
    <section className="panel form-section agent-section">
      <div className="agent-section-header"><h2><ClipboardList size={20}/> Task queue</h2>
        <div className="portal-actions"><label>Status<select value={filter} onChange={event=>{setFilter(event.target.value as Status|'');setTaskPage(0);}}>
          <option value="">All statuses</option>{Object.entries(statusText).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select></label><Button variant="outline" onClick={()=>{setError('');update();}}><RefreshCw size={16}/> Refresh</Button></div>
      </div>
      {!tasks?<p role="status">Loading tasks…</p>:tasks.length===0?<p className="muted">No tasks for this view.</p>:
        <div className="portal-list">{tasks.slice(0,pageSize).map(task=><details key={task.id} className="portal-list-item">
          <summary><strong>{agents[task.agent][0]} · {statusText[task.status]}</strong>
            <span className="muted">{task.mode==='ai'?'Generic AI ideas':'Standard'} · {displayDate(task.created_at)} · {task.attempts}/2 attempts{task.recurring_period?' · Recurring':''}</span></summary>
          {task.brief&&<><h3>Brief</h3><p className="portal-prewrap">{task.brief}</p></>}
          {task.failure&&<p className="error">{task.failure}</p>}
          {task.mode==='standard'&&task.evidence&&Object.keys(task.evidence).length>0&&<><h3>Verified workspace data</h3>
            <dl className="portal-facts">{Object.entries(task.evidence).map(([key,value])=><div key={key}>
              <dt>{readable(key)}</dt><dd>{value===null?'Unavailable':typeof value==='boolean'?value?'Yes':'No':value}</dd></div>)}</dl></>}
          {task.recommendation&&<><h3>{task.mode==='ai'?'AI recommendation':'Standard recommendation'}</h3><p className="portal-prewrap">{task.recommendation}</p></>}
          <div className="portal-actions">
            {task.status==='awaiting_approval'&&<Button disabled={busy} onClick={()=>setConfirm({task,action:'approve'})}>Approve task</Button>}
            {task.status==='queued'&&<Button disabled={busy} onClick={()=>setConfirm({task,action:'run'})}>Run now</Button>}
            {task.status==='failed'&&task.attempts<2&&<Button disabled={busy} onClick={()=>setConfirm({task,action:'retry'})}>Retry</Button>}
            {['awaiting_approval','queued','failed'].includes(task.status)&&<Button variant="outline" disabled={busy} onClick={()=>setConfirm({task,action:'cancel'})}>Cancel task</Button>}
          </div>
        </details>)}</div>}
      <Pagination page={taskPage} next={(tasks?.length??0)>pageSize} change={setTaskPage}/>
      {confirm&&<div className="portal-confirm" role="group" aria-label="Confirm task action">
        <p>{confirm.action==='run'&&confirm.task.mode==='ai'?'Run the generic idea prompt with OpenAI?':
          confirm.action==='approve'?'Approve this task for execution?':confirm.action==='retry'?'Requeue this task for its final attempt?':
          confirm.action==='cancel'?'Cancel this task?':'Run this approved task now?'}</p>
        <div className="portal-actions"><Button disabled={busy} onClick={()=>void apply()}>{busy?'Working…':'Confirm'}</Button>
          <Button variant="outline" disabled={busy} onClick={()=>setConfirm(undefined)}>Back</Button></div>
      </div>}
    </section>
    {automation&&<section className="panel form-section agent-section">
      <h2><Activity size={20}/> Execution history</h2>
      {events.length===0?<p className="muted">No events recorded for this client.</p>:<div className="portal-list">{events.slice(0,pageSize).map(event=>
        <article className="portal-list-item" key={event.id}><div><strong>{event.agent_tasks?agents[event.agent_tasks.agent][0]:'Agent'} · {readable(event.event)}</strong>
          <p className="muted">{displayDate(event.created_at)}{event.attempt?' · Attempt '+event.attempt:''}{event.model?' · '+event.model:''}</p>
          {event.detail&&<p>{event.detail}</p>}</div>
          {event.input_tokens!==null&&<div>{event.input_tokens} input / {event.output_tokens??'—'} output tokens{event.estimated_usd!==null?' · '+money.format(event.estimated_usd):''}</div>}
        </article>)}</div>}
      <Pagination page={logPage} next={events.length>pageSize} change={setLogPage}/>
    </section>}
  </>;
}

function Pagination({page,next,change}:{page:number;next:boolean;change:(value:number)=>void}) {
  if(!page&&!next)return null;
  return <div className="portal-actions portal-pagination">
    <Button variant="outline" disabled={page===0} onClick={()=>change(page-1)}>Previous</Button>
    <span className="muted">Page {page+1}</span><Button variant="outline" disabled={!next} onClick={()=>change(page+1)}>Next</Button>
  </div>;
}
