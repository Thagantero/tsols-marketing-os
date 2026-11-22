import { useEffect,useState,type FormEvent } from 'react';
import { Archive, ArrowLeft, Check, ChevronLeft, ChevronRight, Download, Mail, Plus, Sparkles } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { nairobiDay,shiftDay } from './calendar-dates';
import { edgeMessage } from './publishing';
import { WebsiteAnalytics } from './website-analytics';
import { ContentPerformance } from './content-performance';
import { coverage,formatCount,formatMoney,labelCadence,periodLabel,reportMetrics,type Report } from '../supabase/functions/report-actions/report-model';

type Client={id:string;business_name:string;status:string};
type ReportRow=Pick<Report,'id'|'cadence'|'period_start'|'period_end'|'version'|'status'|'created_at'|'partial_period'>;
type Receipt={status:'sending'|'accepted'|'failed'|'unknown';recipient_email:string;attempt_count:number;updated_at:string};
const pageSize=14;
const title=(value:string)=>value[0].toUpperCase()+value.slice(1);
const receiptLabel={sending:'Sending',accepted:'Accepted by Resend',failed:'Rejected by Resend',unknown:'Delivery unconfirmed'};

export function Reports({agencyId,initialClientId,initialView}:{agencyId:string;initialClientId?:string;initialView?:string}) {
  const [view,setView]=useState<'performance'|'website'|'reports'>(initialView==='website'?'website':'performance');
  const [clients,setClients]=useState<Client[]>();
  const [client,setClient]=useState('');
  const [cadence,setCadence]=useState<Report['cadence']>('weekly');
  const [anchor,setAnchor]=useState(shiftDay(nairobiDay(),-7));
  const [filter,setFilter]=useState('');
  const [page,setPage]=useState(0);
  const [rows,setRows]=useState<ReportRow[]>([]);
  const [total,setTotal]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<Report>();
  const [receipt,setReceipt]=useState<Receipt>();
  const [observations,setObservations]=useState('');
  const [actions,setActions]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [pendingDelivery,setPendingDelivery]=useState(false);
  const current=clients?.find(item=>item.id===client);
  const writable=Boolean(current&&current.status!=='archived');
  const dirty=Boolean(selected&&(selected.observations!==observations||selected.action_plan!==actions));

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name').then(result=>{
      if(!active)return;
      if(result.error)setError('Could not load clients.');
      setClients(result.data??[]);
      setClient(result.data?.find(row=>row.id===initialClientId)?.id??result.data?.find(row=>row.status!=='archived')?.id??result.data?.[0]?.id??'');
      if(!result.data?.length)setLoading(false);
    });
    return ()=>{active=false;};
  },[agencyId,initialClientId]);

  useEffect(()=>{
    if(!supabase||!client||selected)return;
    let active=true;
    setLoading(true);
    let query=supabase.from('reports').select('id,cadence,period_start,period_end,version,status,partial_period,created_at',{count:'exact'}).eq('client_id',client);
    query=filter?query.eq('status',filter):query.neq('status','archived');
    void query.order('period_start',{ascending:false}).order('created_at',{ascending:false}).order('id').range(page*pageSize,(page+1)*pageSize-1).then(result=>{
      if(!active)return;
      setLoading(false);
      if(result.error){setError('Could not load reports.');setRows([]);setTotal(0);return;}
      setRows(result.data as ReportRow[]);setTotal(result.count??0);
    });
    return ()=>{active=false;};
  },[client,filter,page,refresh,selected?.id]);

  useEffect(()=>{
    if(!supabase||!selected?.id)return;
    let active=true;
    setPendingDelivery(true);
    void supabase.from('report_deliveries').select('status,recipient_email,attempt_count,updated_at')
      .eq('report_id',selected.id).maybeSingle().then(result=>{
        if(!active)return;
        setPendingDelivery(false);
        if(result.error)setError('Could not load email delivery status.');
        else setReceipt((result.data as Receipt|null)??undefined);
      });
    return ()=>{active=false;};
  },[selected?.id,refresh]);

  async function perform(action:()=>Promise<void>){
    if(busy)return;
    setBusy(true);setNotice('');setError('');
    try{await action();}catch(problem){setError(problem instanceof Error?problem.message:'The report action could not finish.');}
    finally{setBusy(false);}
  }
  async function open(id:string){
    const result=await supabase!.from('reports').select('*').eq('id',id).eq('client_id',client).single();
    if(result.error||!result.data)throw new Error('Could not open the report.');
    const item=result.data as Report;
    setSelected(item);setObservations(item.observations);setActions(item.action_plan);setReceipt(undefined);
  }
  function generate(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!supabase||!writable||!anchor)return;
    void perform(async()=>{
      const result=await supabase!.rpc('create_client_report',{target_client:client,report_cadence:cadence,anchor_date:anchor});
      if(result.error||typeof result.data!=='string')throw new Error(result.error?.code==='P0001'?result.error.message:'Could not generate the report snapshot.');
      await open(result.data);setRefresh(previous=>previous+1);setNotice('Report draft created from recorded data.');
    });
  }

  function save(){
    if(!selected||!writable||selected.status!=='draft')return;
    void perform(async()=>{
      const result=await supabase!.from('reports').update({observations:observations.trim(),action_plan:actions.trim()})
        .eq('id',selected.id).eq('updated_at',selected.updated_at).select().maybeSingle();
      if(result.error||!result.data)throw new Error(result.error?.code==='P0001'?result.error.message:'Could not save. Reopen the report if it changed elsewhere.');
      const item=result.data as Report;
      setSelected(item);setObservations(item.observations);setActions(item.action_plan);setNotice('Report notes saved.');
    });
  }

  function changeStatus(status:'approved'|'archived'){
    if(!selected||!writable||dirty)return;
    if(!window.confirm(status==='approved'?'Approve this saved report version?':'Archive this report version?'))return;
    void perform(async()=>{
      const result=await supabase!.from('reports').update({status}).eq('id',selected.id).eq('updated_at',selected.updated_at).select().maybeSingle();
      if(result.error||!result.data)throw new Error(result.error?.code==='P0001'?result.error.message:'Could not update the report. Reopen it and retry.');
      setSelected(result.data as Report);setRefresh(value=>value+1);setNotice(status==='approved'?'Report approved.':'Report archived.');
    });
  }

  async function download(report:Report){
    const {buildReportPdf}=await import('../supabase/functions/report-actions/report-pdf');
    const bytes=Uint8Array.from(await buildReportPdf(report));
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    const link=document.createElement('a');
    link.href=url;link.download='TSOLS-'+report.cadence+'-'+report.period_start+'-v'+report.version+'.pdf';link.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice('Report PDF prepared.');
  }

  function providerAction(action:'summary'|'email'){
    if(!selected||!writable||busy)return;
    if(action==='email'&&(selected.status!=='approved'||!selected.recipient_email||pendingDelivery))return;
    if(action==='summary'&&selected.status!=='draft')return;
    if(!window.confirm(action==='summary'
      ? 'Send only the report’s aggregate metrics to OpenAI to draft notes?'
      : 'Send this approved PDF to '+selected.recipient_email+'?'))return;
    void perform(async()=>{
      try{
        const r=await supabase!.functions.invoke<{observations?:string;action_plan?:string;message?:string}>('report-actions',{
          body:{action,report_id:selected.id,confirmed:true},
        });
        if(r.error)throw new Error(await edgeMessage(r.error,'Could not complete the report action.'));
        if(action==='summary'){
          setObservations(r.data?.observations??'');setActions(r.data?.action_plan??'');setNotice('Review the AI draft and save any changes you want to keep.');
        }else setNotice(r.data?.message??'Email request accepted.');
      }finally{if(action==='email')setRefresh(value=>value+1);}
    });
  }

  const canEmail=selected?.status==='approved'&&Boolean(selected.recipient_email)&&(!receipt||receipt.status==='failed'&&receipt.attempt_count===1);
  return <>
    {selected&&<button className="text-link back-link" onClick={()=>{setSelected(undefined);setError('');setNotice('');}}><ArrowLeft size={16}/> Report archive</button>}
    <header className="page-heading"><div><h1>{selected?labelCadence(selected.cadence)+' report':'Reports & Analytics'}</h1>
      <p>{selected?selected.client_name+' · '+periodLabel(selected)+' · Version '+selected.version:'Real performance, connected sources and client reporting in one place.'}</p></div>
      {selected&&<Button variant="outline" disabled={busy||dirty} onClick={()=>void perform(()=>download(selected))}><Download size={16}/> Download PDF</Button>}</header>
    {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {!selected?<>
      <nav className="analytics-tabs" aria-label="Analytics view"><button aria-current={view==='performance'?'page':undefined} onClick={()=>setView('performance')}>Content performance</button><button aria-current={view==='website'?'page':undefined} onClick={()=>setView('website')}>Website & search</button><button aria-current={view==='reports'?'page':undefined} onClick={()=>setView('reports')}>Client reports</button></nav>
      {view!=='reports'?<>
        <section className="panel form-section analytics-client-bar"><label>Client workspace<select value={client} onChange={event=>setClient(event.target.value)}>{!clients?.length&&<option value="">No clients</option>}{clients?.map(item=><option value={item.id} key={item.id}>{item.business_name}</option>)}</select></label></section>
        {view==='website'?<WebsiteAnalytics key={client} clientId={client}/>:<ContentPerformance key={client} clientId={client}/>}
      </>:<>
      <form className="panel form-section" onSubmit={generate}>
        <div className="calendar-filters">
          <label>Client<select value={client} onChange={event=>{setClient(event.target.value);setPage(0);setError('');setNotice('');}}>
            {!clients?.length&&<option value="">No clients</option>}{clients?.map(item=><option value={item.id} key={item.id}>{item.business_name}</option>)}
          </select></label>
          <label>Report type<select value={cadence} onChange={event=>{const next=event.target.value as Report['cadence'];setCadence(next);
            setAnchor(next==='weekly'?shiftDay(nairobiDay(),-7):shiftDay(nairobiDay().slice(0,7)+'-01',-1));}}>
            <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
          </select></label>
          <label>Date in reporting period<input value={anchor} type="date" required min="2000-01-01" max={nairobiDay()} onChange={event=>setAnchor(event.target.value)}/></label>
        </div>
        <p className="muted">Weeks run Monday to Sunday in Nairobi time. A current period runs through today.</p>
        <div className="form-actions"><Button type="submit" disabled={!writable||busy||!anchor}><Plus size={16}/>{busy?'Generating…':'Generate report draft'}</Button></div>
      </form>
      <section className="panel">
        <div className="table-tools studio-filters"><label>Archive filter<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}>
          <option value="">Current reports</option>{['draft','approved','archived'].map(item=><option value={item} key={item}>{title(item)}</option>)}</select></label></div>
        {loading?<p className="empty" role="status">Loading reports…</p>:rows.length?<div className="table-scroll"><table>
          <thead><tr><th>Report</th><th>Period (EAT)</th><th>Version</th><th>Status</th><th>Generated</th></tr></thead>
          <tbody>{rows.map(item=><tr key={item.id}><td><button type="button" className="text-link" disabled={busy} onClick={()=>void perform(()=>open(item.id))}>{labelCadence(item.cadence)} report</button></td>
            <td>{periodLabel(item)}{item.partial_period&&<small>Partial period</small>}</td><td>{item.version}</td>
            <td><span className="status-pill">{title(item.status)}</span></td><td>{displayDate(item.created_at)}</td></tr>)}</tbody>
        </table></div>:<p className="empty">No reports match this view.</p>}
        {total>pageSize&&<div className="pagination"><span>{page*pageSize+1}–{Math.min((page+1)*pageSize,total)} of {total}</span>
          <Button variant="outline" aria-label="Previous page" disabled={loading||page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></Button>
          <Button variant="outline" aria-label="Next page" disabled={loading||(page+1)*pageSize>=total} onClick={()=>setPage(page+1)}><ChevronRight size={16}/></Button></div>}
      </section>
      </>}
    </>:<>
      <section className="panel form-section">
        <h2>Performance snapshot</h2>
        <div className="ads-stats">{reportMetrics(selected.metrics).map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        {selected.metrics.ad_native_spend.length>0&&<p className="muted">Original ad spend {selected.metrics.ad_native_spend.map(item=>formatMoney(item.amount,item.currency)).join(' · ')}</p>}
        <details className="poster-ai"><summary>Data coverage</summary>{coverage(selected).map(item=><p key={item}>{item}</p>)}</details>
      </section>
      {selected.metrics.top_campaigns.length>0&&<section className="panel form-section"><h2>Top campaigns by recorded clicks</h2>
        <div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Account</th><th>Clicks</th><th>Native spend</th></tr></thead>
          <tbody>{selected.metrics.top_campaigns.map(item=><tr key={item.account_label+':'+item.external_campaign_id}><td>{item.name}</td>
            <td>{item.account_label}</td><td>{formatCount(item.clicks)}</td><td>{formatMoney(item.native_spend,item.currency)}</td></tr>)}</tbody></table></div></section>}
      <section className="panel form-section">
        <h2>Review and recommendations</h2>
        <fieldset disabled={busy||!writable||selected.status!=='draft'} className="report-notes">
          <label>Key observations<textarea value={observations} onChange={event=>setObservations(event.target.value)} rows={4} maxLength={4000}/></label>
          <label>{selected.cadence==='weekly'?'Next week’s action plan':'Next month’s strategy'}<textarea value={actions} onChange={event=>setActions(event.target.value)} rows={5} maxLength={4000}/></label>
        </fieldset>
        <div className="studio-actions publish-actions">
          {selected.status==='draft'&&<>
            <Button disabled={busy||!writable||!dirty} onClick={save}>Save notes</Button>
            <Button variant="outline" disabled={busy||!writable} onClick={()=>providerAction('summary')}><Sparkles size={16}/> Draft AI notes</Button>
            <Button variant="outline" disabled={busy||!writable||dirty} onClick={()=>changeStatus('approved')}><Check size={16}/> Approve report</Button>
          </>}
          {selected.status!=='archived'&&<Button variant="outline" disabled={busy||!writable||dirty} onClick={()=>changeStatus('archived')}><Archive size={16}/> Archive</Button>}
        </div>
      </section>
      <section className="panel form-section"><h2>Client delivery</h2>
        <p><strong>{title(selected.status)}</strong> · {selected.recipient_email??'No client email recorded'}</p>
        {receipt&&<p className="muted">{receiptLabel[receipt.status]} · {displayDate(receipt.updated_at)}</p>}
        <Button disabled={busy||pendingDelivery||!writable||!canEmail} onClick={()=>providerAction('email')}><Mail size={16}/>{receipt?.status==='failed'?'Retry email once':'Email approved PDF'}</Button>
      </section>
    </>}
  </>;
}
