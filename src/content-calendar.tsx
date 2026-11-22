import { useEffect,useRef,useState,type FormEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { asDay,monday,monthStart,nairobiDay,nairobiInstant,nairobiTime,shiftDay,shiftMonth,toCalendarDate } from './calendar-dates';
import { signedMedia,type MediaClient } from './media-data';

const platforms=['Facebook','Instagram','LinkedIn','TikTok','Other'];
const formats=['Text Post','Image Post','Video Post','Poster','Carousel','Reel Idea','Video Script','Story','Promotional Announcement','Educational Post'];
const statuses={draft:'Draft',pending_approval:'Needs review',approved:'Approved',planned:'Saved calendar time',cancelled:'Cancelled'};
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
type CalendarView='month'|'week'|'day'|'list';
type Post={
  id:string;client_id:string;title:string;caption:string;hashtags:string;call_to_action:string;visual_concept:string;
  platform:string;format:string;status:'draft'|'pending_approval'|'approved';revision:number;updated_at:string;
  suggested_date:string|null;suggested_time:string|null;scheduled_at:string|null;schedule_cancelled_at:string|null;media_asset_id:string|null;content_origin:string;
  publishing_deliveries?:{revision:number;due_at:string|null;status:string;provider_status:string|null}[];
};
const dayOf=(post:Post)=>post.scheduled_at?nairobiDay(post.scheduled_at):post.suggested_date;
const timeOf=(post:Post)=>post.scheduled_at?nairobiTime(post.scheduled_at):post.suggested_time?.slice(0,5);
const stateOf=(post:Post)=>post.schedule_cancelled_at?'cancelled':post.scheduled_at?'planned':post.status;
function calendarStatus(post:Post) {
  if(post.schedule_cancelled_at)return 'Cancelled';
  if(!post.scheduled_at)return post.suggested_date?'Suggested time':statuses[post.status];
  const due=Date.parse(post.scheduled_at);
  const deliveries=post.publishing_deliveries?.filter(row=>row.revision===post.revision&&row.due_at&&Date.parse(row.due_at)===due)??[];
  if(deliveries.some(row=>row.status==='rejected'||row.status==='unknown'||row.provider_status==='error'))return 'Delivery needs attention';
  if(deliveries.length&&deliveries.every(row=>row.provider_status==='sent'))return 'Published';
  if(deliveries.length&&deliveries.every(row=>row.provider_status==='cancelled'))return 'Cancelled in Buffer';
  if(deliveries.some(row=>row.provider_status==='scheduled'))return 'Scheduled in Buffer';
  if(deliveries.length)return 'Awaiting Buffer confirmation';
  return 'Calendar only';
}
const titleMonth=new Intl.DateTimeFormat('en-KE',{timeZone:'UTC',month:'long',year:'numeric'});
const titleDay=new Intl.DateTimeFormat('en-KE',{timeZone:'UTC',weekday:'short',day:'numeric',month:'short'});
const titleShort=new Intl.DateTimeFormat('en-KE',{timeZone:'UTC',day:'numeric',month:'short'});
const isDate=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&!Number.isNaN(toCalendarDate(day).valueOf())&&asDay(toCalendarDate(day))===day;

function visibleDates(view:CalendarView,anchor:string,from:string,to:string) {
  if(view==='day')return [anchor,shiftDay(anchor,1)] as const;
  if(view==='week')return [monday(anchor),shiftDay(monday(anchor),7)] as const;
  if(view==='list'&&isDate(from)&&isDate(to)&&from<=to)return [from,shiftDay(to,1)] as const;
  const first=monthStart(anchor),next=shiftMonth(anchor,1);
  if(view==='list')return [first,next] as const;
  const before=monday(first);
  const after=monday(next)===next?next:shiftDay(monday(next),7);
  return [before,after] as const;
}

export function ContentCalendar({agencyId,initialClientId}:{agencyId:string;initialClientId?:string}) {
  const [clients,setClients]=useState<MediaClient[]>([]);
  const [client,setClient]=useState('');
  const [platform,setPlatform]=useState('');
  const [format,setFormat]=useState('');
  const [status,setStatus]=useState('');
  const [view,setView]=useState<CalendarView>('month');
  const [anchor,setAnchor]=useState(nairobiDay());
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [posts,setPosts]=useState<Post[]>([]);
  const [approved,setApproved]=useState<Post[]>([]);
  const [selected,setSelected]=useState<Post>();
  const [preview,setPreview]=useState<{url:string;video:boolean}>();
  const [load,setLoad]=useState(true);
  const [busy,setBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [error,setError]=useState('');
  const [detailError,setDetailError]=useState('');
  const [message,setMessage]=useState('');
  const [truncated,setTruncated]=useState(false);
  const [scheduleDay,setScheduleDay]=useState('');
  const [scheduleTime,setScheduleTime]=useState('07:00');
  const dialog=useRef<HTMLDialogElement>(null);
  const [start,end]=visibleDates(view,anchor,from,to);
  const days:string[]=[];
  if(view!=='list')for(let day=start;day<end;day=shiftDay(day,1))days.push(day);
  const clientNames=new Map(clients.map(item=>[item.id,item.business_name]));
  const selectedClient=clients.find(item=>item.id===client);
  const writable=selected && clients.some(item=>item.id===selected.client_id&&item.status!=='archived');

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name').then(result=>{
      if(!active)return;
      if(result.error){setError('Could not load calendar clients.');setLoad(false);return;}
      setClients(result.data);
      setClient(result.data.some(item=>item.id===initialClientId)?initialClientId??'':'');
      if(!result.data.length)setLoad(false);
    });
    return ()=>{active=false;};
  },[agencyId,initialClientId]);

  useEffect(()=>{
    if(!supabase||!clients.length)return;
    let active=true;
    setLoad(true);
    const db=supabase;
    const clientIds=client?[client]:clients.map(item=>item.id);
    let query=db.from('content_calendar').select('*,publishing_deliveries(revision,due_at,status,provider_status)').in('client_id',clientIds).or(
      `and(scheduled_at.gte.${nairobiInstant(start,'00:00')},scheduled_at.lt.${nairobiInstant(end,'00:00')}),and(scheduled_at.is.null,suggested_date.gte.${start},suggested_date.lt.${end})`
    );
    if(platform)query=query.eq('platform',platform);
    if(format)query=query.eq('format',format);
    if(status==='planned')query=query.not('scheduled_at','is',null).is('schedule_cancelled_at',null);
    else if(status==='cancelled')query=query.not('schedule_cancelled_at','is',null);
    else if(status)query=query.eq('status',status).is('scheduled_at',null);
    const writableIds=clientIds.filter(id=>clients.some(item=>item.id===id&&item.status!=='archived'));
    let unplanned=db.from('content_calendar').select('*').in('client_id',writableIds)
      .eq('status','approved').is('scheduled_at',null);
    if(platform)unplanned=unplanned.eq('platform',platform);
    if(format)unplanned=unplanned.eq('format',format);
    void Promise.all([
      query.order('scheduled_at',{ascending:true,nullsFirst:false}).order('suggested_date').order('id').limit(301),
      writableIds.length ? unplanned.order('updated_at',{ascending:false}).limit(16) : Promise.resolve({data:[],error:null}),
    ]).then(([result,queue])=>{
      if(!active)return;
      setLoad(false);
      if(result.error||queue.error){setError('Could not load calendar posts.');setPosts([]);setApproved([]);return;}
      const items=(result.data as Post[]).slice(0,300).sort((a,b)=>(`${dayOf(a)} ${timeOf(a)??''}`).localeCompare(`${dayOf(b)} ${timeOf(b)??''}`));
      setPosts(items);setApproved(queue.data as Post[]);setTruncated(result.data.length>300);
    });
    return ()=>{active=false;};
  },[clients,client,start,end,platform,format,status,refresh]);

  useEffect(()=>{
    if(!selected?.media_asset_id || !supabase)return;
    let active=true;
    void supabase.from('media_assets').select('object_path,mime_type').eq('id',selected.media_asset_id).single().then(async result=>{
      if(result.error||!active)return;
      try {
        const urls=await signedMedia([result.data.object_path]);
        if(active&&urls[result.data.object_path])setPreview({url:urls[result.data.object_path],video:result.data.mime_type==='video/mp4'});
      } catch {if(active)setPreview(undefined);}
    });
    return ()=>{active=false;};
  },[selected?.media_asset_id]);

  function open(post:Post) {
    if(selected?.media_asset_id!==post.media_asset_id)setPreview(undefined);
    setSelected(post);setDetailError('');
    setScheduleDay(dayOf(post)??anchor);setScheduleTime(timeOf(post)??'07:00');
    dialog.current?.showModal();
  }

  function move(amount:number) {
    if(view==='list'){setFrom('');setTo('');}
    setAnchor(previous=>view==='month'||view==='list'?shiftMonth(previous,amount):shiftDay(previous,view==='week'?amount*7:amount));
  }

  async function mutate(operation:()=>Promise<void>,label:string) {
    if(!selected||!writable||busy)return;
    setBusy(true);setDetailError('');setMessage('');
    try {await operation();setRefresh(value=>value+1);setMessage(label);dialog.current?.close();}
    catch(failure){setDetailError(failure instanceof Error?failure.message:'The post could not be updated.');}
    finally {setBusy(false);}
  }

  async function update(fields:Record<string,string|null>) {
    if(!selected||!supabase)return;
    const result=await supabase.from('content_calendar').update(fields).eq('id',selected.id)
      .eq('updated_at',selected.updated_at).select('id').maybeSingle();
    if(result.error?.code==='P0001')throw new Error(result.error.message);
    if(result.error||!result.data)throw new Error('Could not update the post. Reopen it in case it changed elsewhere.');
    if(fields.scheduled_at)setAnchor(nairobiDay(fields.scheduled_at));
  }

  function schedule(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!isDate(scheduleDay)||!/^\d{2}:\d{2}$/.test(scheduleTime)){setDetailError('Choose a valid date and time.');return;}
    const instant=nairobiInstant(scheduleDay,scheduleTime);
    if(new Date(instant).getTime()<=Date.now()){setDetailError('Choose a future date and time.');return;}
    void mutate(()=>update({scheduled_at:instant,schedule_cancelled_at:null}),'Post planned.');
  }

  async function duplicate() {
    if(!selected||!supabase)return;
    const {client_id,title,caption,hashtags,call_to_action,visual_concept,platform,format,media_asset_id}=selected;
    const result=await supabase.from('content_calendar').insert({
      client_id,title:`${title.slice(0,172)} (copy)`,caption,hashtags,call_to_action,visual_concept,platform,format,media_asset_id,
      suggested_date:dayOf(selected),suggested_time:timeOf(selected)??null,content_origin:selected.content_origin,
    });
    if(result.error)throw new Error('Could not duplicate the post.');
  }

  const heading=view==='day'?titleDay.format(toCalendarDate(anchor)):
    view==='week'?`${titleShort.format(toCalendarDate(start))} – ${titleShort.format(toCalendarDate(shiftDay(end,-1)))}`:titleMonth.format(toCalendarDate(anchor));
  const eligibleClient=client?selectedClient:clients.find(item=>item.status!=='archived');
  return <>
    <header className="page-heading"><div><h1>Content Calendar</h1><p>View suggested dates and delivery status in Nairobi time. Schedule publishing from Content Studio.</p></div>
      {eligibleClient&&eligibleClient.status!=='archived'&&<Button asChild><a href={`#/studio/${eligibleClient.id}/new/${anchor}`}><Plus size={17}/> Create post</a></Button>}
    </header>
    {error&&<p className="notice error" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}
    <section className="panel form-section">
      <div className="calendar-controls">
        <div className="studio-actions"><Button variant="outline" aria-label="Previous period" onClick={()=>move(-1)}><ChevronLeft size={17}/></Button>
          <Button variant="outline" aria-label="Next period" onClick={()=>move(1)}><ChevronRight size={17}/></Button>
          <Button variant="outline" onClick={()=>{setAnchor(nairobiDay());setFrom('');setTo('');}}>Today</Button></div>
        <h2>{heading}</h2>
        <label className="calendar-view"><span className="sr-only">Calendar view</span><select value={view} onChange={event=>setView(event.target.value as CalendarView)}>
          {['month','week','day','list'].map(item=><option key={item} value={item}>{item[0].toUpperCase()+item.slice(1)}</option>)}
        </select></label>
      </div>
      <div className="calendar-filters">
        <label>Client<select value={client} onChange={event=>setClient(event.target.value)}><option value="">All clients</option>{clients.map(item=><option key={item.id} value={item.id}>{item.business_name}</option>)}</select></label>
        <label>Platform<select value={platform} onChange={event=>setPlatform(event.target.value)}><option value="">All platforms</option>{platforms.map(item=><option key={item}>{item}</option>)}</select></label>
        <label>Content type<select value={format} onChange={event=>setFormat(event.target.value)}><option value="">All types</option>{formats.map(item=><option key={item}>{item}</option>)}</select></label>
        <label>Status<select value={status} onChange={event=>setStatus(event.target.value)}><option value="">All statuses</option>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        {view==='list'&&<><label>From<input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>Through<input type="date" min={from||undefined} value={to} onChange={event=>setTo(event.target.value)}/></label></>}
      </div>
      {load&&<p className="empty" role="status">Loading calendar…</p>}
      {truncated&&<p className="notice">Showing the first 300 posts. Narrow the filters to see a smaller date range.</p>}
      {(view==='month'||view==='week')?<div className="calendar-scroll">
        <div className="calendar-grid">
          {weekdays.map(day=><div key={day} className="calendar-weekday">{day}</div>)}
          {days.map(day=><div key={day} className={`calendar-cell ${view==='month'&&day.slice(0,7)!==anchor.slice(0,7)?'outside-month':''} ${day===nairobiDay()?'calendar-today':''}`}>
            <button type="button" className="calendar-day-button" aria-label={`Open ${titleDay.format(toCalendarDate(day))}`} onClick={()=>{setAnchor(day);setView('day');}}>{Number(day.slice(-2))}</button>
            {posts.filter(item=>dayOf(item)===day).map(item=><button type="button" title={item.title} className={`calendar-item ${stateOf(item)}`} key={item.id} onClick={()=>open(item)}>
              <small>{timeOf(item)||'No time'} · {calendarStatus(item)}</small><strong>{item.title}</strong>
            </button>)}
          </div>)}
        </div>
      </div>:!load&&(posts.length?<div className="calendar-list">{posts.map(item=><button className="activity-row" key={item.id} onClick={()=>open(item)}>
        <span className="event-icon"><CalendarDays size={16}/></span><span><strong>{item.title}</strong><small>{clientNames.get(item.client_id)} · {item.platform} · {calendarStatus(item)}</small></span>
        <time>{dayOf(item)&&titleShort.format(toCalendarDate(dayOf(item)!))} · {timeOf(item)||'No time'}</time>
      </button>)}</div>:<p className="empty">No posts match this period and filters.</p>)}
    </section>
    <section className="panel form-section"><h2>Posts ready to plan</h2>
      {!approved.length?<p className="muted">Save a manual post or approve an AI draft to add it to the planning queue.</p>:approved.slice(0,15).map(item=><button key={item.id} className="activity-row" onClick={()=>open(item)}>
        <span className="event-icon"><Clock3 size={16}/></span><span><strong>{item.title}</strong><small>{clientNames.get(item.client_id)} · {item.platform}</small></span>
      </button>)}
      {approved.length>15&&<p className="muted">Filter by client to narrow the queue.</p>}
    </section>
    <dialog ref={dialog} className="panel confirmation calendar-dialog">
      {selected&&<><h2>{selected.title}</h2>
        <p>{clientNames.get(selected.client_id)} · {selected.platform} · {calendarStatus(selected)} · Revision {selected.revision}</p>
        {preview&&(preview.video
          ? <video className="calendar-preview" src={preview.url} controls preload="metadata" aria-label="Attached video"/>
          : <img className="calendar-preview" src={preview.url} alt="Attached creative"/>)}
        <p className="calendar-caption">{selected.caption||'No caption yet.'}</p>
        {selected.hashtags&&<p>{selected.hashtags}</p>}
        {selected.call_to_action&&<p>{selected.call_to_action}</p>}
        {selected.scheduled_at&&<p>{selected.schedule_cancelled_at?'Cancelled plan':'Planned for'} {displayDate(selected.scheduled_at)} EAT</p>}
        {detailError&&<p className="notice error" role="alert">{detailError}</p>}
        {writable&&selected.status==='approved'&&<form className="calendar-schedule-form" onSubmit={schedule}>
          <fieldset disabled={busy}><div className="form-grid">
            <label>Date<input required type="date" min={nairobiDay()} value={scheduleDay} onChange={event=>setScheduleDay(event.target.value)}/></label>
            <label>Time (EAT)<input required type="time" value={scheduleTime} onChange={event=>setScheduleTime(event.target.value)}/></label>
          </div><div className="studio-actions calendar-time-presets">{['07:00','13:00','19:00'].map(time=><Button key={time} type="button" variant="outline" onClick={()=>setScheduleTime(time)}>{time}</Button>)}</div>
          <p className="muted">Starting time suggestions for planning.</p>
          <div className="form-actions">
            {selected.scheduled_at&&!selected.schedule_cancelled_at&&<Button type="button" variant="outline" onClick={()=>void mutate(()=>update({schedule_cancelled_at:new Date().toISOString()}),'Schedule cancelled.')}>Cancel schedule</Button>}
            <Button type="submit">{selected.scheduled_at&&!selected.schedule_cancelled_at?'Update calendar time':'Save calendar time'}</Button>
          </div></fieldset>
        </form>}
        <div className="form-actions studio-actions">
          <Button variant="outline" disabled={busy} onClick={()=>dialog.current?.close()}>Close</Button>
          {!busy&&<Button variant="outline" asChild><a href={`#/studio/${selected.client_id}/${selected.id}`} >{writable&&selected.status==='approved'?'Schedule in Buffer':'Open in Studio'}</a></Button>}
          {writable&&<Button variant="outline" disabled={busy} onClick={()=>void mutate(duplicate,'Post duplicated as a new draft.')}>Duplicate</Button>}
          {writable&&selected.content_origin!=='manual'&&selected.status!=='approved'&&<Button disabled={busy||!selected.caption.trim()} onClick={()=>void mutate(()=>update({status:'approved'}),'Revision approved.')}>Approve draft</Button>}
        </div>
      </>}
    </dialog>
  </>;
}
