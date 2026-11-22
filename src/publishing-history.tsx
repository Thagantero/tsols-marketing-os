import { useEffect,useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { deliveryFields,deliveryLabel,edgeMessage,failureLabels,needsAttention,publishingAction,type Delivery } from './publishing';

type Client={id:string;business_name:string};
type History=Delivery&{submitted_at:string;content_calendar:{title:string}|null;publishing_accounts:{name:string;platform:string}|null};
type Event=Pick<Delivery,'status'|'provider_status'|'failure_code'|'attempt_count'>&{id:string;created_at:string};
type BufferOrganization={id:string;name:string};
const rowsPerPage=20;

export function PublishingHistory({agencyId}:{agencyId:string}) {
  const [clients,setClients]=useState<Client[]>();
  const [client,setClient]=useState('');
  const [filter,setFilter]=useState('');
  const [rows,setRows]=useState<History[]>([]);
  const [selected,setSelected]=useState<History>();
  const [events,setEvents]=useState<Event[]>([]);
  const [refresh,setRefresh]=useState(0);
  const [page,setPage]=useState(0);
  const [total,setTotal]=useState(0);
  const [attention,setAttention]=useState(0);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [organizations,setOrganizations]=useState<BufferOrganization[]>();
  const [lookupBusy,setLookupBusy]=useState(false);
  const [lookupMessage,setLookupMessage]=useState('');

  async function findOrganizations() {
    if(!supabase||lookupBusy)return;
    setLookupBusy(true);setLookupMessage('');setOrganizations(undefined);
    try{
      const result=await supabase.functions.invoke<{organizations:BufferOrganization[]}>('publish-post',{
        body:{action:'organizations',agency_id:agencyId},
      });
      if(result.error) {
        setLookupMessage(await edgeMessage(result.error,'Could not look up Buffer organizations.'));
        return;
      }
      setOrganizations(result.data?.organizations??[]);
    }catch{setLookupMessage('Could not contact the publishing function. Try again.');}
    finally{setLookupBusy(false);}
  }

  async function copyId(value:string) {
    try{await navigator.clipboard.writeText(value);setLookupMessage('ID copied.');}
    catch{setLookupMessage('Select and copy the ID shown below.');}
  }

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name').eq('agency_id',agencyId).order('business_name').then(result=>{
      if(!active)return;
      if(result.error)setError('Could not load clients.');
      setClients(result.data??[]);
    });
    return ()=>{active=false;};
  },[agencyId]);

  useEffect(()=>{
    if(!supabase||!clients)return;
    const ids=client?[client]:clients.map(item=>item.id);
    if(!ids.length){setRows([]);setLoading(false);return;}
    let active=true;
    setLoading(true);
    const db=supabase;
    const attentionFilter='status.in.(rejected,unknown),provider_status.eq.error';
    let query=db.from('publishing_deliveries').select(deliveryFields+',submitted_at,content_calendar(title),publishing_accounts(name,platform)',{count:'exact'}).in('client_id',ids);
    if(filter==='attention')query=query.or(attentionFilter);
    else if(filter)query=query.eq('provider_status',filter);
    void Promise.all([
      query.order('submitted_at',{ascending:false}).order('content_id').order('revision').order('account_id').range(page*rowsPerPage,(page+1)*rowsPerPage-1),
      db.from('publishing_deliveries').select('content_id',{count:'exact',head:true}).in('client_id',ids).or(attentionFilter),
    ]).then(([result,alerts])=>{
      if(!active)return;
      setLoading(false);
      if(result.error||alerts.error){setError('Could not load publishing history.');setRows([]);return;}
      setRows(result.data as unknown as History[]);
      setTotal(result.count??0);
      setAttention(alerts.count??0);
    });
    return ()=>{active=false;};
  },[clients,client,filter,page,refresh]);

  useEffect(()=>{
    if(!supabase||!selected)return;
    let active=true;
    setEvents([]);
    void supabase.from('publishing_events').select('id,status,provider_status,failure_code,attempt_count,created_at')
      .eq('content_id',selected.content_id).eq('revision',selected.revision).eq('account_id',selected.account_id)
      .order('created_at',{ascending:false}).limit(40).then(result=>{
        if(!active)return;
        if(result.error)setError('Could not load the delivery log.');
        else setEvents(result.data as Event[]);
      });
    return ()=>{active=false;};
  },[selected,refresh]);

  async function action(mode:'sync'|'cancel',row:History){
    if(busy)return;
    if(mode==='cancel'&&!window.confirm('Cancel this scheduled post in Buffer for '+(row.publishing_accounts?.name??'this account')+'?'))return;
    setBusy(true);setNotice('');setError('');
    try{
      const [updated]=await publishingAction(mode,{id:row.content_id,client_id:row.client_id,revision:row.revision},[row.account_id]);
      if(updated&&selected?.content_id===row.content_id&&selected?.revision===row.revision&&selected?.account_id===row.account_id){
        setSelected({...selected,...updated});
      }
      setNotice(mode==='cancel'?'Buffer confirmed cancellation.':'Buffer status refreshed.');
    }catch(failure){setError(failure instanceof Error?failure.message:'Could not update the delivery.');}
    finally{setBusy(false);setRefresh(value=>value+1);}
  }

  return <>
    <header className="page-heading"><div><h1>Publishing</h1><p>Track delivery to each connected account.</p></div>
      <Button asChild><a href="#/studio">Open Content Studio</a></Button></header>
    <details className="panel form-section buffer-setup">
      <summary>Buffer setup</summary>
      <div className="buffer-id"><p><strong>Agency ID</strong> <code>{agencyId}</code></p>
        <Button variant="outline" onClick={()=>void copyId(agencyId)}><Copy size={15}/> Copy agency ID</Button></div>
      <p className="muted">In the TSOLS project, only the Buffer API key is needed in Supabase. The agency and organization IDs are configured for this workspace.</p>
      <Button variant="outline" disabled={lookupBusy} onClick={()=>void findOrganizations()}>{lookupBusy?'Checking Buffer…':'Find Buffer organization ID'}</Button>
      {lookupMessage&&<p className="notice" role="status">{lookupMessage}</p>}
      {organizations&&(organizations.length ? <>
        <p className="muted">Copy the ID for the organization you want to use and save it as <code>BUFFER_ORGANIZATION_ID</code> in Supabase.</p>
        {organizations.map(org=><div className="buffer-id" key={org.id}><p><strong>{org.name}</strong> <code>{org.id}</code></p>
          <Button variant="outline" aria-label={'Copy organization ID for '+org.name} onClick={()=>void copyId(org.id)}><Copy size={15}/> Copy</Button></div>)}
      </>:<p className="muted">Buffer returned no organizations for this key.</p>)}
    </details>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {notice&&<p role="status" className="notice">{notice}</p>}
    {attention>0&&<div className="notice error publish-alert" role="status"><AlertTriangle size={17}/>
      <span>{attention} {attention===1?'delivery needs':'deliveries need'} attention.</span>
      <Button variant="outline" onClick={()=>{setFilter('attention');setPage(0);}}>Show issues</Button></div>}
    <section className="panel">
      <div className="table-tools studio-filters">
        <label>Client<select value={client} onChange={event=>{setClient(event.target.value);setPage(0);setSelected(undefined);}}>
          <option value="">All clients</option>{clients?.map(item=><option value={item.id} key={item.id}>{item.business_name}</option>)}
        </select></label>
        <label>Status<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}>
          <option value="">All statuses</option><option value="attention">Needs attention</option><option value="scheduled">Scheduled in Buffer</option>
          <option value="sent">Published</option><option value="cancelled">Cancelled in Buffer</option>
        </select></label>
      </div>
      {loading?<p className="empty" role="status">Loading delivery history…</p>:rows.length===0?<p className="empty">No deliveries match these filters. Publish or send a schedule from Content Studio.</p>:
        <div className="table-scroll"><table>
          <thead><tr><th>Post</th><th>Destination</th><th>Status</th><th>Time (EAT)</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(row=><tr key={[row.content_id,row.revision,row.account_id].join(':')}>
            <td><a href={'#/studio/'+row.client_id+'/'+row.content_id}>{row.content_calendar?.title??'Content Studio post'}</a><small>Revision {row.revision}</small></td>
            <td>{row.publishing_accounts?.name??'Account'}<small>{row.publishing_accounts?.platform}</small></td>
            <td><span className={'status-pill '+(needsAttention(row)?'paused':row.provider_status==='sent'?'active':'')}>{deliveryLabel(row)}</span>
              {row.failure_code&&<small>{failureLabels[row.failure_code]}</small>}</td>
            <td>{displayDate(row.provider_sent_at??row.due_at??row.submitted_at)}<small>{row.provider_sent_at?'Published time':row.due_at?'Scheduled time':'Submitted time'}</small></td>
            <td><div className="studio-actions">
              <Button variant="outline" onClick={()=>setSelected(row)}>Log</Button>
              {row.external_post_id&&row.provider_status!=='cancelled'&&(row.provider_status!=='sent'||!row.provider_sent_at)&&<Button variant="outline" disabled={busy} onClick={()=>void action('sync',row)}><RefreshCw size={15}/> Refresh</Button>}
              {row.due_at&&row.provider_status==='scheduled'&&<Button variant="outline" disabled={busy} onClick={()=>void action('cancel',row)}>Cancel in Buffer</Button>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      {total>rowsPerPage&&<div className="pagination"><span>{page*rowsPerPage+1}–{Math.min((page+1)*rowsPerPage,total)} of {total}</span>
        <Button variant="outline" aria-label="Previous page" disabled={loading||!page} onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></Button>
        <Button variant="outline" aria-label="Next page" disabled={loading||(page+1)*rowsPerPage>=total} onClick={()=>setPage(page+1)}><ChevronRight size={16}/></Button></div>}
    </section>
    {selected&&<section className="panel form-section publishing-event-log">
      <div className="calendar-controls"><div><h2>Delivery log</h2><p className="muted">{selected.content_calendar?.title} · {selected.publishing_accounts?.name} · Revision {selected.revision}</p></div>
        <Button variant="outline" onClick={()=>setSelected(undefined)}>Close log</Button></div>
      {selected.external_post_id&&<p className="muted">Buffer post ID <code>{selected.external_post_id}</code></p>}
      {!events.length&&<p className="muted">No logged changes yet.</p>}
      {events.map(event=><div className="activity-row" key={event.id}><span><strong>{deliveryLabel(event)}</strong><small>Attempt {event.attempt_count}{event.failure_code?' · '+failureLabels[event.failure_code]:''}</small></span>
        <time dateTime={event.created_at}>{displayDate(event.created_at)}</time></div>)}
    </section>}
  </>;
}
