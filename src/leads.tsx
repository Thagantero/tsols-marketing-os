import { useEffect,useState,type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Flame, MessageSquare, Plus } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { nairobiDay,nairobiInstant,nairobiTime } from './calendar-dates';

const states=['new','contacted','qualified','booked','won','lost'];
const sources=['Manual Entry','WhatsApp','Instagram','Facebook','Website Form','Advertising','Phone Call'];
const label=(value:string)=>value.replaceAll('_',' ').replace(/^./,character=>character.toUpperCase());
const pageSize=16;
type Client={id:string;business_name:string;status:string};
type Lead={
  id:string;client_id:string;name:string;phone:string|null;whatsapp_number:string|null;email:string|null;service:string|null;source:string;
  status:string;priority:string;notes:string|null;assigned_user_id:string|null;consent_status:string;last_contact_at:string|null;
  last_reply_at:string|null;next_follow_up_at:string|null;created_at:string;updated_at:string;
};
type Activity={id:string;action:string;detail:string|null;created_at:string};
type Delivery={id:string;kind:string;status:string;reason:string|null;scheduled_at:string};
type CaptureLink={id:string;label:string;active:boolean;created_at:string};
type Settings={client_id:string;welcome_enabled:boolean;follow_up_enabled:boolean;welcome_delay_minutes:number};

function Choice({name,title,options,value}: {name:string;title:string;options:string[];value?:string}) {
  return <label>{title}<select name={name} defaultValue={value}>{options.map(option=><option key={option} value={option}>{label(option)}</option>)}</select></label>;
}

export function LeadsHub({agencyId,user,initialClientId,initialHot=false}:{agencyId:string;user:string;initialClientId?:string;initialHot?:boolean}) {
  const [clients,setClients]=useState<Client[]>();
  const [client,setClient]=useState('');
  const [rows,setRows]=useState<Lead[]>([]);
  const [selected,setSelected]=useState<Lead>();
  const [mode,setMode]=useState<'inbox'|'edit'|'new'|'settings'>('inbox');
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState('');
  const [hotOnly,setHotOnly]=useState(initialHot);
  const [hot,setHot]=useState(0);
  const [page,setPage]=useState(0);
  const [total,setTotal]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [activity,setActivity]=useState<Activity[]>([]);
  const [messages,setMessages]=useState<Delivery[]>([]);
  const [evidence,setEvidence]=useState('');
  const [links,setLinks]=useState<CaptureLink[]>([]);
  const [settings,setSettings]=useState<Settings>();
  const [captureToken,setCaptureToken]=useState('');
  const [linkLabel,setLinkLabel]=useState('');
  const current=clients?.find(item=>item.id===client);
  const writable=Boolean(current&&current.status!=='archived');
  const enabledClient=current?.status==='active';

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name').then(result=>{
      if(!active)return;
      if(result.error)setError('Could not load clients.');
      setClients(result.data??[]);
      setClient(result.data?.find(item=>item.id===initialClientId)?.id??result.data?.find(item=>item.status==='active')?.id??result.data?.[0]?.id??'');
      if(!result.data?.length)setLoading(false);
    });
    return ()=>{active=false;};
  },[agencyId,initialClientId]);

  useEffect(()=>{
    if(!supabase||!client||mode!=='inbox')return;
    let active=true;
    const db=supabase;
    setLoading(true);
    const timer=window.setTimeout(async()=>{
      let query=db.from('leads').select('*',{count:'exact'}).eq('client_id',client);
      const input=search.trim().replace(/[\\%_*]/g,character=>'\\'+character);
      if(input){
        if(input.includes('@'))query=query.ilike('email','%'+input+'%');
        else if(/^\+?[0-9]{2,}$/.test(input)){
          const digits=input.replace(/^\+|^0/g,'');
          query=query.or('phone.ilike.%'+digits+'%,whatsapp_number.ilike.%'+digits+'%');
        }else query=query.ilike('name','%'+input+'%');
      }
      if(filter)query=query.eq('status',filter);
      if(hotOnly)query=query.eq('priority','hot').not('status','in','(booked,won,lost)');
      const [result,urgent]=await Promise.all([
        query.order('created_at',{ascending:false}).order('id').range(page*pageSize,(page+1)*pageSize-1),
        db.from('leads').select('id',{count:'exact',head:true}).eq('client_id',client).eq('priority','hot').not('status','in','(booked,won,lost)'),
      ]);
      if(!active)return;
      setLoading(false);
      if(result.error||urgent.error){setError('Could not load the lead inbox.');setRows([]);setTotal(0);return;}
      setRows(result.data as Lead[]);setTotal(result.count??0);setHot(urgent.count??0);
    },160);
    return ()=>{active=false;clearTimeout(timer);};
  },[client,search,filter,hotOnly,page,refresh,mode]);

  useEffect(()=>{
    if(!supabase||!selected?.id||mode!=='edit')return;
    let active=true;
    const db=supabase;
    void Promise.all([
      db.from('lead_activities').select('id,action,detail,created_at').eq('lead_id',selected.id).order('created_at',{ascending:false}).limit(30),
      db.from('whatsapp_messages').select('id,kind,status,reason,scheduled_at').eq('lead_id',selected.id).order('scheduled_at'),
    ]).then(([events,deliveries])=>{
      if(!active)return;
      if(events.error||deliveries.error)setError('Could not load lead activity.');
      setActivity(events.data??[]);setMessages(deliveries.data??[]);
    });
    return ()=>{active=false;};
  },[selected?.id,refresh,mode]);

  useEffect(()=>{
    if(!supabase||!client||mode!=='settings')return;
    let active=true;
    const db=supabase;
    void Promise.all([
      db.from('lead_intake_links').select('id,label,active,created_at').eq('client_id',client).order('created_at',{ascending:false}).limit(30),
      db.from('whatsapp_settings').select('*').eq('client_id',client).maybeSingle(),
    ]).then(([tokens,config])=>{
      if(!active)return;
      if(tokens.error||config.error)setError('Could not load intake and WhatsApp settings.');
      setLinks(tokens.data??[]);
      setSettings(config.data??{client_id:client,welcome_enabled:false,follow_up_enabled:false,welcome_delay_minutes:5});
    });
    return ()=>{active=false;};
  },[client,mode,refresh]);

  function navigate(next:typeof mode,lead?:Lead){
    setMode(next);setSelected(lead);setError('');setNotice('');setEvidence('');setCaptureToken('');setSettings(undefined);
    setActivity([]);setMessages([]);
  }
  function reload(){setRefresh(previous=>previous+1);}
  async function perform(fn:()=>Promise<void>){
    if(busy||!supabase)return;
    setBusy(true);setError('');setNotice('');
    try{await fn();}
    catch(failure){setError(failure instanceof Error?failure.message:'The request could not finish.');}
    finally{setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!supabase||!writable)return;
    const db=supabase;
    const form=new FormData(event.currentTarget);
    const field=(name:string)=>String(form.get(name)??'').trim();
    const followDate=field('follow_up_date'),followTime=field('follow_up_time');
    if(followDate&&!followTime){setError('Choose a follow-up time.');return;}
    if(!field('name')||!(field('phone')||field('whatsapp_number')||field('email'))){setError('Enter a name and at least one contact method.');return;}
    const details={
      name:field('name'),phone:field('phone')||null,whatsapp_number:field('whatsapp_number')||null,email:field('email')||null,
      service:field('service')||null,source:field('source'),status:field('status'),priority:field('priority'),
      notes:field('notes')||null,assigned_user_id:form.has('assigned')?user:selected?.assigned_user_id===user?null:selected?.assigned_user_id??null,
      next_follow_up_at:followDate&&followTime?nairobiInstant(followDate,followTime):null,
    };
    await perform(async()=>{
      const result=selected?await db.from('leads').update(details).eq('id',selected.id).eq('updated_at',selected.updated_at).select().maybeSingle():
        await db.from('leads').insert({...details,client_id:client}).select().single();
      if(result.error?.code==='23505')throw new Error('This phone number or email already exists for the selected client. Search the inbox for the existing lead.');
      if(result.error?.code==='P0001')throw new Error(result.error.message);
      if(result.error||!result.data)throw new Error('Could not save the lead. Check the contact details or reopen the record.');
      setSelected(result.data as Lead);setMode('edit');setNotice('Lead saved.');reload();
    });
  }
  async function currentLead(id:string){
    const result=await supabase!.from('leads').select('*').eq('id',id).single();
    if(result.error)throw new Error('Could not reload the lead.');
    setSelected(result.data as Lead);reload();
  }
  function consent(value:'opted_in'|'opted_out'){
    if(!selected?.whatsapp_number||!writable)return;
    const proof=evidence.trim();
    if(value==='opted_in'&&proof.length<5){setError('Describe when and how the lead opted in to WhatsApp.');return;}
    if(value==='opted_in'&&!window.confirm('Record the lead’s affirmative WhatsApp opt-in? If enabled for this client, this may queue an approved welcome template.'))return;
    const lead=selected;
    void perform(async()=>{
      const result=await supabase!.from('messaging_consents').insert({
        lead_id:lead.id,client_id:lead.client_id,phone_number:lead.whatsapp_number,consent:value,
        evidence:proof||'Administrator recorded the lead’s opt-out.',
      });
      if(result.error)throw new Error(result.error.code==='P0001'?result.error.message:'Could not record consent.');
      await currentLead(lead.id);setEvidence('');setNotice(value==='opted_in'?'WhatsApp opt-in recorded.':'Opt-out recorded. Queued messages were stopped.');
    });
  }
  function queue(kind:'welcome'|'follow_up'){
    if(!selected||!enabledClient||selected.consent_status!=='opted_in'||messages.some(item=>item.kind===kind))return;
    const lead=selected;
    if(kind==='follow_up'&&!lead.last_contact_at){setError('Log the initial contact before queueing a follow-up.');return;}
    if(!window.confirm('Queue the approved '+(kind==='welcome'?'welcome':'follow-up')+' WhatsApp template for this opted-in lead?'))return;
    void perform(async()=>{
      const due=kind==='follow_up'?Math.max(Date.now(),Date.parse(lead.last_contact_at!)+86400000):Date.now();
      const result=await supabase!.from('whatsapp_messages').insert({
        lead_id:lead.id,client_id:lead.client_id,kind,scheduled_at:new Date(due).toISOString(),
      });
      if(result.error)throw new Error(result.error.code==='23505'?'This template is already queued or recorded.':'Could not queue this message. Verify the lead and its consent.');
      reload();setNotice('Approved template queued. Sending requires a connected WhatsApp worker.');
    });
  }
  function captureLink(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!enabledClient||!linkLabel.trim())return;
    void perform(async()=>{
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      const hex=(items:Uint8Array)=>Array.from(items,b=>b.toString(16).padStart(2,'0')).join('');
      const token=hex(bytes);
      const hash=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))));
      const result=await supabase!.from('lead_intake_links').insert({client_id:client,label:linkLabel.trim(),token_hash:hash});
      if(result.error)throw new Error('Could not create a capture token.');
      setCaptureToken(token);setLinkLabel('');reload();
    });
  }
  function saveSettings(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!enabledClient)return;
    const form=new FormData(event.currentTarget);
    const welcome=form.has('welcome_enabled'),followUp=form.has('follow_up_enabled');
    if((welcome||followUp)&&!window.confirm('Enable this client’s approved WhatsApp automation for opted-in leads?'))return;
    void perform(async()=>{
      const result=await supabase!.from('whatsapp_settings').upsert({client_id:client,welcome_enabled:welcome,
        follow_up_enabled:followUp,welcome_delay_minutes:Number(form.get('welcome_delay_minutes'))},{onConflict:'client_id'});
      if(result.error)throw new Error('Could not save WhatsApp settings.');
      reload();setNotice('Automation preferences saved.');
    });
  }

  const detail=mode==='edit'||mode==='new';
  return <>
    {mode!=='inbox'&&<button className="text-link back-link" onClick={()=>navigate('inbox')}><ArrowLeft size={16}/> Lead inbox</button>}
    <header className="page-heading"><div>
      <h1>{mode==='settings'?'Lead capture & WhatsApp':mode==='new'?'Add lead':selected?.name??'Leads & WhatsApp'}</h1>
      <p>{mode==='inbox'?'Track enquiries, hot leads, and upcoming follow-ups.':current?.business_name}</p></div>
      {mode==='inbox'&&<div className="studio-actions"><Button variant="outline" disabled={!writable} onClick={()=>navigate('settings')}>Capture & WhatsApp settings</Button>
        <Button disabled={!writable} onClick={()=>navigate('new')}><Plus size={16}/> Add lead</Button></div>}
    </header>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {notice&&<p role="status" className="notice">{notice}</p>}
    {mode==='inbox'&&<>
      {hot>0&&<div className="notice error publish-alert"><Flame size={17}/><span>{hot} open {hot===1?'hot lead':'hot leads'} for this client.</span>
        <Button variant="outline" onClick={()=>{setHotOnly(true);setFilter('');setPage(0);}}>View hot leads</Button></div>}
      <section className="panel">
        <div className="table-tools studio-filters">
          <label>Client<select value={client} onChange={event=>{setClient(event.target.value);setPage(0);setHot(0);setError('');}}>
            {!clients?.length&&<option value="">No clients</option>}{clients?.map(item=><option value={item.id} key={item.id}>{item.business_name}</option>)}
          </select></label>
          <label>Find a lead<input placeholder="Name, phone or email" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label>
          <label>Status<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}>
            <option value="">All statuses</option>{states.map(item=><option key={item} value={item}>{label(item)}</option>)}
          </select></label>
          {hotOnly&&<Button variant="outline" onClick={()=>{setHotOnly(false);setPage(0);}}>Clear hot lead filter</Button>}
        </div>
        {loading?<p className="empty" role="status">Loading leads…</p>:rows.length?<div className="table-scroll"><table>
          <thead><tr><th>Lead</th><th>Source</th><th>Status</th><th>Consent</th><th>Next follow-up</th></tr></thead>
          <tbody>{rows.map(item=><tr key={item.id}><td><button type="button" className="text-link" onClick={()=>navigate('edit',item)}>{item.name}</button>
            <small>{item.phone||item.whatsapp_number||item.email}</small></td><td>{item.source}</td>
            <td>{label(item.status)}{item.priority==='hot'&&<small className="lead-hot">Hot lead</small>}</td>
            <td>{label(item.consent_status)}</td><td>{item.next_follow_up_at?displayDate(item.next_follow_up_at):'—'}</td></tr>)}</tbody>
        </table></div>:<p className="empty">No leads match this view.</p>}
        {total>pageSize&&<div className="pagination"><span>{page*pageSize+1}–{Math.min((page+1)*pageSize,total)} of {total}</span>
          <Button variant="outline" aria-label="Previous page" disabled={loading||page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></Button>
          <Button variant="outline" aria-label="Next page" disabled={loading||(page+1)*pageSize>=total} onClick={()=>setPage(page+1)}><ChevronRight size={16}/></Button></div>}
      </section>
    </>}
    {detail&&<form key={selected?.id??'new'} className="panel form-section" onSubmit={save}>
      <fieldset disabled={busy||!writable}><div className="form-grid">
        <label>Name<input name="name" maxLength={160} defaultValue={selected?.name} required/></label>
        <label>Service interested in<input name="service" maxLength={200} defaultValue={selected?.service??''}/></label>
        <label>Phone<input name="phone" type="tel" maxLength={40} placeholder="0712 345 678" defaultValue={selected?.phone??''}/></label>
        <label>WhatsApp number<input name="whatsapp_number" type="tel" maxLength={40} defaultValue={selected?.whatsapp_number??''}/></label>
        <label>Email<input name="email" type="email" maxLength={254} defaultValue={selected?.email??''}/></label>
        <Choice name="source" title="Source" options={sources} value={selected?.source}/>
        <Choice name="status" title="Status" options={states} value={selected?.status}/><Choice name="priority" title="Priority" options={['normal','hot']} value={selected?.priority}/>
        <label>Follow-up date<input type="date" name="follow_up_date" defaultValue={selected?.next_follow_up_at?nairobiDay(selected.next_follow_up_at):''}/></label>
        <label>Follow-up time (EAT)<input type="time" name="follow_up_time" defaultValue={selected?.next_follow_up_at?nairobiTime(selected.next_follow_up_at):'09:00'}/></label>
        <label className="form-wide">Notes<textarea name="notes" maxLength={3000} rows={3} defaultValue={selected?.notes??''}/></label>
        <label className="lead-checkbox"><input type="checkbox" name="assigned" defaultChecked={selected?.assigned_user_id===user}/> Assign to me</label>
      </div>
      <div className="form-actions"><Button type="submit">{busy?'Saving…':'Save lead'}</Button></div></fieldset>
    </form>}
    {mode==='edit'&&selected&&<>
      <section className="panel form-section">
        <h2>WhatsApp consent & follow-up</h2>
        <p>Status <strong>{label(selected.consent_status)}</strong>{selected.whatsapp_number?' · '+selected.whatsapp_number:''}</p>
        <p className="muted">Last contact {selected.last_contact_at?displayDate(selected.last_contact_at):'—'} · Last WhatsApp reply {selected.last_reply_at?displayDate(selected.last_reply_at):'—'}</p>
        <label>Consent evidence<input value={evidence} maxLength={500} onChange={event=>setEvidence(event.target.value)} placeholder="Where and when the lead agreed to receive WhatsApp messages"/></label>
        <div className="studio-actions publish-actions">
          <Button variant="outline" disabled={busy||!writable||!selected.whatsapp_number} onClick={()=>consent('opted_in')}>Record opt-in</Button>
          <Button variant="outline" disabled={busy||!writable||!selected.whatsapp_number} onClick={()=>consent('opted_out')}>Record opt-out</Button>
          <Button variant="outline" disabled={busy||!writable} onClick={()=>void perform(async()=>{
            const result=await supabase!.from('leads').update({last_contact_at:new Date().toISOString()}).eq('id',selected.id).eq('updated_at',selected.updated_at).select('id').maybeSingle();
            if(result.error||!result.data)throw new Error('Could not log contact. Reload the lead first.');
            await currentLead(selected.id);setNotice('Contact time logged.');
          })}>Log contact now</Button>
        </div>
        <div className="studio-actions publish-actions">
          <Button disabled={busy||!enabledClient||selected.consent_status!=='opted_in'||Boolean(selected.last_reply_at)||['booked','won','lost'].includes(selected.status)||messages.some(item=>item.kind==='welcome')} onClick={()=>queue('welcome')}><MessageSquare size={15}/> Queue welcome</Button>
          <Button variant="outline" disabled={busy||!enabledClient||selected.consent_status!=='opted_in'||!selected.last_contact_at||Boolean(selected.last_reply_at)||['booked','won','lost'].includes(selected.status)||messages.some(item=>item.kind==='follow_up')} onClick={()=>queue('follow_up')}>Queue 24-hour follow-up</Button>
        </div>
        {messages.map(message=><p className="muted" key={message.id}>{label(message.kind)} · {label(message.status)} · {displayDate(message.scheduled_at)}{message.reason?' · '+label(message.reason):''}</p>)}
      </section>
      <section className="panel form-section"><h2>Lead activity</h2>
        {!activity.length&&<p className="muted">No activity recorded yet.</p>}
        {activity.map(item=><div className="activity-row" key={item.id}><span><strong>{item.action}</strong>{item.detail&&<small>{item.detail}</small>}</span><time dateTime={item.created_at}>{displayDate(item.created_at)}</time></div>)}
      </section>
    </>}
    {mode==='settings'&&<>
      <section className="panel form-section"><h2>Website form intake</h2>
        <p className="muted">Create a token for your website’s server to submit leads to this client. Store it on the server and share it only with the form administrator.</p>
        <form onSubmit={captureLink} className="account-linker"><label>Form name<input value={linkLabel} onChange={event=>setLinkLabel(event.target.value)} maxLength={100} required/></label>
          <Button type="submit" disabled={busy||!enabledClient}>Create capture token</Button></form>
        {captureToken&&<div className="notice capture-token"><p>Copy this token now. It is shown once.</p><code>{captureToken}</code>
          <Button variant="outline" onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(captureToken);setNotice('Capture token copied.');})}><Copy size={15}/> Copy token</Button></div>}
        {links.map(item=><div className="activity-row" key={item.id}><span><strong>{item.label}</strong><small>{item.active?'Active':'Disabled'}</small></span>
          {item.active&&<Button variant="outline" disabled={busy||!writable} onClick={()=>void perform(async()=>{
            const result=await supabase!.from('lead_intake_links').update({active:false}).eq('id',item.id);
            if(result.error)throw new Error('Could not disable this token.');
            setCaptureToken('');reload();setNotice('Capture token disabled.');
          })}>Disable token</Button>}</div>)}
      </section>
      <form className="panel form-section" onSubmit={saveSettings}><h2>WhatsApp automation</h2>
        <p className="muted">Requires a connected Meta sender and approved templates. Send preferences apply to new opt-ins and welcome deliveries.</p>
        {settings&&<fieldset key={refresh} disabled={busy||!enabledClient}>
          <label className="lead-checkbox"><input type="checkbox" name="welcome_enabled" defaultChecked={settings.welcome_enabled}/> Queue a welcome template after consent</label>
          <label>Welcome delay (minutes)<input name="welcome_delay_minutes" type="number" min={0} max={60} defaultValue={settings.welcome_delay_minutes} required/></label>
          <label className="lead-checkbox"><input type="checkbox" name="follow_up_enabled" defaultChecked={settings.follow_up_enabled}/> If there’s no reply, follow up after 24 hours</label>
          <div className="form-actions"><Button type="submit">Save automation settings</Button></div>
        </fieldset>}
      </form>
    </>}
  </>;
}
