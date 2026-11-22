import {useEffect,useState,type FormEvent,type ReactNode} from 'react';
import {Button} from './components/ui/button';
import {supabase} from './data';
import {nairobiDay} from './calendar-dates';

type Plan={id:string;name:string;monthly_fee_kes:number;description:string;active:boolean};
type Terms={client_id:string;package_id:string;renewal_date:string;status:string;notes:string};
type Client={id:string;business_name:string;status:string;package_name:string|null;monthly_service_fee_kes:number|null;monthly_ad_budget_kes:number|null;billing_subscriptions:Terms|null};
type Invoice={id:string;client_name:string;package_name:string;billed_on:string;due_on:string;service_fee_kes:number;ad_budget_kes:number|null;status:string;paid_on:string|null;payment_reference:string|null;notes:string};
type Cost={id:string;incurred_on:string;description:string;category:string;amount_kes:number;reference:string|null;voided:boolean};
type Summary={billed:number;paid:number;unpaid:number;open_invoices:number;overdue:number;costs:number;margin:number;margin_pct:number|null};
type Data={plans:Plan[];clients:Client[];invoices:Invoice[];costs:Cost[];summary:Summary;ops:{publishing:number;facebook:number;agents:number;whatsapp:number}};
const categories=['Software','Contractors','Production','Operations','Other'];
const tabs=['Subscriptions','Packages','Invoices','Operating costs','Launch monitoring'] as const;
const money=new Intl.NumberFormat('en-KE',{style:'currency',currency:'KES',currencyDisplay:'code',maximumFractionDigits:2});
const cash=(value:number|null)=>value===null?'—':money.format(value);
const field=(form:FormData,key:string)=>String(form.get(key)??'').trim();
const numberField=(form:FormData,key:string)=>field(form,key)||null;
const pageSize=25;

export function Billing({agencyId}:{agencyId:string}){
  const [tab,setTab]=useState<typeof tabs[number]>('Subscriptions');
  const [month,setMonth]=useState(nairobiDay().slice(0,7));
  const [data,setData]=useState<Data>();
  const [clientId,setClientId]=useState('');
  const [plan,setPlan]=useState<Plan|null>();
  const [invoice,setInvoice]=useState<Invoice>();
  const [page,setPage]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const selected=data?.clients.find(item=>item.id===clientId)??data?.clients.find(item=>item.status!=='archived');
  const period=month+'-01';
  const nextMonth=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
  const today=nairobiDay();

  useEffect(()=>{
    const db=supabase;
    if(!db)return;
    let active=true;
    void Promise.all([
      db.from('billing_packages').select('id,name,monthly_fee_kes,description,active').eq('agency_id',agencyId).order('name'),
      db.from('clients').select('id,business_name,status,package_name,monthly_service_fee_kes,monthly_ad_budget_kes,billing_subscriptions(client_id,package_id,renewal_date,status,notes)')
        .eq('agency_id',agencyId).order('business_name'),
      db.from('billing_invoices').select('id,client_name,package_name,billed_on,due_on,service_fee_kes,ad_budget_kes,status,paid_on,payment_reference,notes,clients!inner(agency_id)')
        .eq('clients.agency_id',agencyId).eq('billing_month',period).order('billed_on',{ascending:false}).order('id').range(page*pageSize,page*pageSize+pageSize),
      db.from('billing_costs').select('id,incurred_on,description,category,amount_kes,reference,voided').eq('agency_id',agencyId)
        .gte('incurred_on',period).lt('incurred_on',nextMonth).order('incurred_on',{ascending:false}).order('id').range(page*pageSize,page*pageSize+pageSize),
      db.rpc('billing_month_summary',{target_agency:agencyId,period}),
      tab==='Launch monitoring'?db.rpc('billing_launch_exceptions',{target_agency:agencyId}):null,
    ]).then(([plans,clients,invoices,costs,summary,ops])=>{
      if(!active)return;
      if([plans,clients,invoices,costs,summary].some(result=>result.error)){setError('Could not load billing records. Refresh and try again.');return;}
      setData({plans:plans.data as Plan[],clients:clients.data as unknown as Client[],invoices:invoices.data as unknown as Invoice[],
        costs:costs.data as Cost[],summary:summary.data as Summary,
        ops:ops?.data??{publishing:-1,facebook:-1,agents:-1,whatsapp:-1}});
    });
    return()=>{active=false;};
  },[agencyId,period,nextMonth,page,refresh,tab]);

  async function save(operation:()=>PromiseLike<{error:{code?:string;message:string}|null}>, feedback:string, complete?:()=>void){
    if(busy)return;
    setBusy(true);setError('');setNotice('');
    try{
      const result=await operation();
      if(result.error){setError(result.error.code==='P0001'?result.error.message:'Could not save. Check the fields and try again.');return;}
      setNotice(feedback);setRefresh(value=>value+1);complete?.();
    }catch{setError('Could not confirm this update. Refresh before trying again.');}
    finally{setBusy(false);}
  }
  function submit(event:FormEvent<HTMLFormElement>,action:(form:FormData)=>void){
    event.preventDefault();
    if(supabase&&!busy)action(new FormData(event.currentTarget));
  }
  function switchTab(value:typeof tabs[number]){
    setTab(value);setPage(0);setPlan(undefined);setInvoice(undefined);setError('');setNotice('');
  }
  const list=tab==='Invoices'?data?.invoices:tab==='Operating costs'?data?.costs:undefined;
  const s=data?.summary;

  return <>
    <header className="page-heading"><div><h1>Packages &amp; Billing</h1><p>Manage service fees, renewals, invoices and operating costs in KES.</p></div>
      <label>Billing month<input type="month" value={month} onChange={event=>{if(event.target.value){setMonth(event.target.value);setPage(0);setInvoice(undefined);}}}/></label></header>
    {s&&<div className="agent-grid billing-metrics">
      <Stat label="Service fees billed" value={cash(s.billed)}/>
      <Stat label="Payments recorded" value={cash(s.paid)}/>
      <Stat label={s.overdue+' overdue · '+s.open_invoices+' open'} value={cash(s.unpaid)}/>
      <Stat label="Operating costs" value={cash(s.costs)}/>
      <Stat label={'Estimated gross margin'+(s.margin_pct===null?'':' · '+s.margin_pct+'%')} value={cash(s.margin)}/>
    </div>}
    <nav className="tabs" aria-label="Billing pages">{tabs.map(item=><button key={item} type="button" aria-current={tab===item?'page':undefined} onClick={()=>switchTab(item)}>{item}</button>)}</nav>
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="error notice" role="alert">{error}</p>}
    {!data&&!error&&<p role="status">Loading billing…</p>}
    {data&&tab==='Subscriptions'&&<section className="panel form-section">
      <h2>Client subscriptions</h2>
      <p className="muted">Manage package pricing and record the advertising budget separately. Existing invoices retain their original amounts.</p>
      <label>Client<select value={selected?.id??''} onChange={event=>setClientId(event.target.value)}>
        {data.clients.filter(client=>client.status!=='archived').map(client=><option key={client.id} value={client.id}>{client.business_name}</option>)}
      </select></label>
      {selected&&<form key={selected.id+':'+refresh} className="billing-form" onSubmit={event=>submit(event,form=>void save(()=>supabase!.rpc('save_billing_terms',{
        target_client:selected.id,package_id:field(form,'package'),fee:numberField(form,'fee'),ad_budget:numberField(form,'budget'),
        renewal:field(form,'renewal'),subscription_status:field(form,'status'),detail:field(form,'notes'),
      }),'Subscription saved.'))}>
        <div className="form-grid">
          <label>Package<select name="package" defaultValue={data.plans.find(item=>item.active&&(selected.billing_subscriptions?item.id===selected.billing_subscriptions.package_id:item.name===selected.package_name))?.id??''} required>
            <option value="">Choose package</option>{data.plans.filter(item=>item.active).map(item=><option value={item.id} key={item.id}>{item.name} · {cash(item.monthly_fee_kes)}</option>)}
          </select></label>
          <Amount label="Agreed fee (blank uses package price)" name="fee" value={selected.monthly_service_fee_kes}/>
          <Amount label="Monthly ad budget" name="budget" value={selected.monthly_ad_budget_kes}/>
          <label>Renewal date<input name="renewal" type="date" defaultValue={selected.billing_subscriptions?.renewal_date??today} required/></label>
          <label>Status<select name="status" defaultValue={selected.billing_subscriptions?.status??'active'}><option value="active">Active</option><option value="paused">Paused</option><option value="ended">Ended</option></select></label>
          <label className="form-wide">Internal notes<textarea name="notes" rows={2} maxLength={1000} defaultValue={selected.billing_subscriptions?.notes??''}/></label>
        </div>
        <Button disabled={busy}>Save subscription</Button>
      </form>}
      {!selected&&<p>No eligible clients. Add a client first.</p>}
      <div className="portal-list">{data.clients.filter(item=>item.billing_subscriptions).map(item=><article className="portal-list-item" key={item.id}>
        <div><strong>{item.business_name}</strong><p className="muted">{item.package_name} · {item.billing_subscriptions?.status} · Renews {item.billing_subscriptions?.renewal_date}</p></div>
        <div>{cash(item.monthly_service_fee_kes)} service / month</div></article>)}</div>
    </section>}
    {data&&tab==='Packages'&&<section className="panel form-section">
      <h2>Package catalogue</h2><Button variant="outline" onClick={()=>setPlan(null)}>Add package</Button>
      <div className="portal-list">{data.plans.map(item=><article className="portal-list-item" key={item.id}>
        <div><strong>{item.name} · {cash(item.monthly_fee_kes)}/month</strong><p className="muted">{item.active?'Active':'Archived'} · {item.description}</p></div>
        <Button variant="outline" onClick={()=>setPlan(item)}>Edit</Button></article>)}</div>
      {plan!==undefined&&<form key={plan?.id??'new'} className="billing-form" onSubmit={event=>submit(event,form=>{
        const changes={name:field(form,'name'),monthly_fee_kes:field(form,'fee'),description:field(form,'description')};
        void save(()=>plan?supabase!.from('billing_packages').update({...changes,active:field(form,'active')==='on'}).eq('id',plan.id).eq('agency_id',agencyId)
          :supabase!.from('billing_packages').insert({agency_id:agencyId,...changes}),'Package saved.',()=>setPlan(undefined));
      })}><div className="form-grid">
        <label>Name<input name="name" maxLength={100} defaultValue={plan?.name} required/></label><Amount label="Monthly service fee" name="fee" value={plan?.monthly_fee_kes} required/>
        <label className="form-wide">Includes<textarea name="description" maxLength={800} defaultValue={plan?.description}/></label>
        {plan&&<label>Status<select name="active" defaultValue={plan.active?'on':'off'}><option value="on">Active</option><option value="off">Archived</option></select></label>}
      </div><div className="portal-actions"><Button disabled={busy}>Save package</Button><Button type="button" variant="outline" onClick={()=>setPlan(undefined)}>Cancel</Button></div></form>}
    </section>}
    {data&&tab==='Invoices'&&<section className="panel form-section">
      <h2>Invoices</h2>
      <form className="billing-form" onSubmit={event=>submit(event,form=>void save(()=>supabase!.rpc('issue_billing_invoice',{
        target_client:field(form,'client'),period,issued:field(form,'issued'),due:field(form,'due'),detail:field(form,'notes'),
      }),'Invoice recorded.'))}>
        <div className="form-grid"><label>Client<select name="client" required defaultValue={selected?.id}>
          <option value="">Choose client</option>{data.clients.filter(item=>item.billing_subscriptions?.status==='active'&&item.status!=='archived')
          .map(item=><option key={item.id} value={item.id}>{item.business_name} · {cash(item.monthly_service_fee_kes)}</option>)}</select></label>
          <label>Invoice date<input name="issued" type="date" defaultValue={today} max={today} required/></label>
          <label>Due date<input name="due" type="date" defaultValue={today} required/></label>
          <label>Notes<input name="notes" maxLength={1000}/></label></div>
        <Button disabled={busy}>Record invoice</Button>
      </form>
      {data.invoices.length===0&&<p className="muted">No invoices for this month.</p>}
      <div className="portal-list">{data.invoices.slice(0,pageSize).map(item=><details className="portal-list-item" key={item.id}>
        <summary><strong>{item.client_name} · {cash(item.service_fee_kes)}</strong>
          <span className="muted">{item.status==='unpaid'&&item.due_on<today?'Overdue':item.status} · Due {item.due_on}</span></summary>
        <p>{item.package_name} · Invoiced {item.billed_on}</p><p>Ad budget tracked separately · {cash(item.ad_budget_kes)}</p>
        {item.notes&&<p>{item.notes}</p>}{item.payment_reference&&<p>Paid {item.paid_on} · {item.payment_reference}</p>}
        {item.status==='unpaid'&&<div className="portal-actions">
          <Button variant="outline" onClick={()=>setInvoice(item)}>Record payment</Button>
          <Button variant="ghost" disabled={busy} onClick={()=>{if(window.confirm('Void this unpaid invoice?'))void save(()=>supabase!.rpc('complete_billing_invoice',{
            invoice_id:item.id,action:'void',reference:null,payment_date:null,
          }),'Invoice voided.');}}>Void</Button></div>}
      </details>)}</div>
      {invoice&&<form key={invoice.id} className="billing-form" onSubmit={event=>submit(event,form=>void save(()=>supabase!.rpc('complete_billing_invoice',{
        invoice_id:invoice.id,action:'pay',reference:field(form,'reference'),payment_date:field(form,'paid'),
      }),'Payment recorded.',()=>setInvoice(undefined)))}>
        <h3>Record full payment for {invoice.client_name} · {cash(invoice.service_fee_kes)}</h3>
        <div className="form-grid"><label>Payment reference<input name="reference" required maxLength={120}/></label>
          <label>Payment date<input name="paid" type="date" defaultValue={today} min={invoice.billed_on} max={today} required/></label></div>
        <div className="portal-actions"><Button disabled={busy}>Save payment</Button><Button type="button" variant="outline" onClick={()=>setInvoice(undefined)}>Cancel</Button></div>
      </form>}
    </section>}
    {data&&tab==='Operating costs'&&<section className="panel form-section">
      <h2>Operating costs</h2><p className="muted">Record agency operating expenses. Client advertising budgets are tracked with subscriptions.</p>
      <form className="billing-form" onSubmit={event=>{
        const element=event.currentTarget;
        submit(event,form=>void save(()=>supabase!.from('billing_costs').insert({agency_id:agencyId,incurred_on:field(form,'date'),
          description:field(form,'description'),category:field(form,'category'),amount_kes:field(form,'amount'),reference:field(form,'reference')||null}),
        'Operating cost recorded.',()=>element.reset()));
      }}>
        <div className="form-grid"><label>Description<input name="description" maxLength={160} required/></label>
          <label>Category<select name="category">{categories.map(item=><option key={item}>{item}</option>)}</select></label>
          <Amount label="Amount" name="amount" minimum={.01} required/><label>Date<input name="date" type="date" defaultValue={today} max={today} required/></label>
          <label>Reference<input name="reference" maxLength={120}/></label></div><Button disabled={busy}>Record cost</Button>
      </form>
      <div className="portal-list">{data.costs.slice(0,pageSize).map(item=><article className="portal-list-item" key={item.id}>
        <div><strong>{item.description} · {cash(item.amount_kes)}</strong><p className="muted">{item.incurred_on} · {item.category}{item.voided?' · Voided':''}{item.reference?' · '+item.reference:''}</p></div>
        {!item.voided&&<Button variant="outline" disabled={busy} onClick={()=>{if(window.confirm('Void this operating cost?'))void save(()=>supabase!.from('billing_costs')
          .update({voided:true}).eq('id',item.id).eq('agency_id',agencyId),'Cost voided.');}}>Void</Button>}</article>)}</div>
      {data.costs.length===0&&<p className="muted">No costs for this month.</p>}
    </section>}
    {data&&tab==='Launch monitoring'&&<section className="panel form-section">
      <h2>Integration exceptions · last 7 days</h2>
      <div className="agent-grid">
        {([['Buffer delivery exceptions',data.ops.publishing,'#/publishing'],['Facebook direct exceptions',data.ops.facebook,'#/studio'],
          ['Failed agent executions',data.ops.agents,'#/automations'],['Failed WhatsApp messages',data.ops.whatsapp,'#/leads']] as const).map(([label,value,href])=>
          <Stat key={label} label={<a className="text-link" href={href}>{label}</a>} value={value<0?'Unavailable':String(value)}/>)}
      </div>
      <Button variant="outline" onClick={()=>setRefresh(value=>value+1)}>Refresh exceptions</Button>
      <p className="muted">Review provider receipts, test the client sign-in flow, and verify a backup restore before onboarding paying clients.</p>
    </section>}
    {list&&(page>0||list.length>pageSize)&&<div className="portal-actions portal-pagination">
      <Button variant="outline" disabled={page===0} onClick={()=>setPage(value=>value-1)}>Previous</Button>
      <span>Page {page+1}</span><Button variant="outline" disabled={list.length<=pageSize} onClick={()=>setPage(value=>value+1)}>Next</Button>
    </div>}
  </>;
}
function Stat({label,value}:{label:ReactNode;value:string}){return <div className="panel billing-stat"><span className="muted">{label}</span><strong>{value}</strong></div>;}
function Amount({label,name,value,minimum=0,required=false}:{label:string;name:string;value?:number|null;minimum?:number;required?:boolean}){
  return <label>{label}<input name={name} type="number" min={minimum} max="9999999999.99" step=".01" defaultValue={value??''} required={required}/></label>;
}
