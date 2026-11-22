import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Building2, CalendarDays, ChartNoAxesCombined, ClipboardList, Download, FileText, LayoutDashboard, LogOut, Package, Users } from 'lucide-react';
import { BrandMark } from './auth';
import { Button } from './components/ui/button';
import { displayDate, supabase, type Assigned } from './data';
import { formatCount, formatMoney, labelCadence, periodLabel, reportMetrics, type Report } from '../supabase/functions/report-actions/report-model';

const tabs = [
  {id:'overview',name:'Overview',icon:LayoutDashboard}, {id:'content',name:'My Content',icon:FileText},
  {id:'calendar',name:'My Calendar',icon:CalendarDays}, {id:'leads',name:'My Leads',icon:Users},
  {id:'advertising',name:'My Advertising',icon:ChartNoAxesCombined}, {id:'reports',name:'My Reports',icon:ClipboardList},
  {id:'profile',name:'My Business Profile',icon:Building2}, {id:'package',name:'My Package',icon:Package},
] as const;
type Section = typeof tabs[number]['id'];
type Content = {id:string;title:string;caption:string;hashtags:string;platform:string;format:string;scheduled_at:string|null;sent_at:string|null;state:string};
type Lead = {id:string;name:string;phone:string|null;whatsapp_number:string|null;email:string|null;service:string|null;source:string;status:string;created_at:string};
type Campaign = {id:string;name:string;platform:'meta'|'google';objective:string;start_date:string;end_date:string|null;daily_budget_kes:number|null;monthly_budget_kes:number|null;target_locations:{name:string}[]};
type Performance = {platform:Campaign['platform'];currency:string;spend:number;impressions:number;clicks:number;leads:number|null};
type Advertising = {campaigns:Campaign[];performance:Performance[]};
type Overview = {upcoming:number;leads:number;reports:number};
type Profile = {business_name:string;industry:string;location:string;description:string|null;address:string|null;website:string|null;brand_name:string|null;contact_email:string|null;contact_phone:string|null};
type PackageInfo = {package_name:string|null;status:string;onboarding_date:string|null;monthly_fee_kes:number|null;monthly_ad_budget_kes:number|null};

const selectSection = (route:string) => tabs.find(tab=>tab.id===route.split('/')[1])?.id??'overview';
const textValue = (value:string|number|null) => value===null || value==='' ? '—' : value;
const platformName = (platform:Campaign['platform']) => platform==='meta'?'Meta':'Google';
const formatDate = (day:string) => new Intl.DateTimeFormat('en-KE',{dateStyle:'medium',timeZone:'Africa/Nairobi'}).format(new Date(day+'T12:00:00Z'));

export function ClientPortal({assigned, route, signOut, agencyAccess}: {assigned:Assigned[];route:string;signOut:()=>Promise<void>;agencyAccess:boolean}) {
  const [businessId,setBusinessId] = useState(assigned[0].id);
  const business=assigned.find(entry=>entry.id===businessId)??assigned[0];
  const section=selectSection(route);
  const passwordDialog=useRef<HTMLDialogElement>(null);
  return <main className="client-portal">
    <header className="portal-header"><a href="#/portal/overview" aria-label="TSOLS portal overview"><BrandMark/></a>
      <div className="portal-actions">
        {agencyAccess && <Button variant="ghost" asChild><a href="/app/">Agency workspace</a></Button>}
        <Button variant="ghost" onClick={()=>passwordDialog.current?.showModal()}>Set password</Button>
        <Button variant="outline" onClick={signOut}><LogOut size={16}/> Sign out</Button>
      </div>
    </header>
    <div className="portal-main">
      <div className="portal-identity">
        <div><p className="eyebrow">CLIENT PORTAL</p><h1>{business.business_name}</h1><p className="muted">{business.industry} · {business.location}</p></div>
        {assigned.length>1 && <label>Business<select value={business.id} onChange={event=>setBusinessId(event.target.value)}>
          {assigned.map(item=><option key={item.id} value={item.id}>{item.business_name}</option>)}
        </select></label>}
      </div>
      <nav className="portal-navigation" aria-label="Client portal">{tabs.map(({id,name,icon:Icon})=><a key={id} href={'#/portal/'+id}
        aria-current={section===id?'page':undefined}><Icon size={17}/>{name}</a>)}</nav>
      <PortalPage key={business.id+'/'+section} businessId={business.id} section={section}/>
    </div>
    <dialog ref={passwordDialog} className="panel confirmation"><PortalPassword close={()=>passwordDialog.current?.close()}/></dialog>
  </main>;
}

function PortalPassword({close}:{close:()=>void}) {
  const [busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState<{ok:boolean;message:string}>();
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form=event.currentTarget;
    setBusy(true);setFeedback(undefined);
    try{
      const password=String(new FormData(form).get('password')??'');
      const {error}=await supabase.auth.updateUser({password});
      if(error)throw error;
      form.reset();
      setFeedback({ok:true,message:'Password saved. You can use it at your next sign-in.'});
    }catch{setFeedback({ok:false,message:'Could not save the password. Sign in again and try a stronger password.'});}
    finally{setBusy(false);}
  }
  return <form onSubmit={save}>
    <h2>Set your portal password</h2>
    <p>Use at least 12 characters.</p>
    <label>New password<input name="password" type="password" minLength={12} autoComplete="new-password" required/></label>
    {feedback&&<p role={feedback.ok?'status':'alert'} className={feedback.ok?'notice':'error'}>{feedback.message}</p>}
    <div className="form-actions">
      <Button variant="outline" type="button" onClick={()=>{setFeedback(undefined);close();}}>Close</Button>
      <Button disabled={busy}>{busy?'Saving…':'Save password'}</Button>
    </div>
  </form>;
}

function PortalPage({businessId,section}: {businessId:string;section:Section}) {
  const [page,setPage]=useState(0);
  const [retry,setRetry]=useState(0);
  const [response,setResponse]=useState<{page:number; data:unknown}>();
  const [error,setError]=useState('');
  const [downloadError,setDownloadError]=useState('');
  const [downloading,setDownloading]=useState('');
  const title=tabs.find(tab=>tab.id===section)!.name;

  useEffect(()=>{
    let active=true;
    void supabase?.rpc('client_portal_page',{target_client:businessId,section,page_number:page}).then(result=>{
      if(!active)return;
      if(result.error){setError('Could not open this page. Your access may have changed.');return;}
      setResponse({page,data:result.data});
    });
    return()=>{active=false;};
  },[businessId,section,page,retry]);

  async function download(report:Report) {
    if (downloading) return;
    setDownloadError('');setDownloading(report.id);
    try {
      const {buildReportPdf}=await import('../supabase/functions/report-actions/report-pdf');
      const bytes=Uint8Array.from(await buildReportPdf(report));
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;link.download='TSOLS-'+report.cadence+'-'+report.period_start+'-v'+report.version+'.pdf';
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch {setDownloadError('Could not prepare this PDF. Try again.');}
    finally {setDownloading('');}
  }

  if(error)return <section className="panel portal-panel"><h2>{title}</h2><p className="error" role="alert">{error}</p>
    <Button variant="outline" onClick={()=>{setError('');setResponse(undefined);setRetry(value=>value+1);}}>Try again</Button></section>;
  if(!response || response.page!==page)return <section className="panel portal-panel" aria-busy="true"><h2>{title}</h2><p role="status">Loading…</p></section>;
  const data=response.data;
  const rows=Array.isArray(data)?data:section==='advertising'?(data as Advertising).campaigns:[];
  const visible=rows.slice(0,20);
  let body:ReactNode;

  switch(section) {
    case 'overview': {
      const summary=data as Overview;
      body=<div className="portal-summary">
        {([['Upcoming planned posts',summary.upcoming,'calendar'],['New leads',summary.leads,'leads'],['Available reports',summary.reports,'reports']] as const).map(([name,value,tab])=>
          <a href={'#/portal/'+tab} key={tab}><span>{name}</span><strong>{formatCount(value)}</strong><ArrowRight size={17}/></a>)}
      </div>;
      break;
    }
    case 'content':
    case 'calendar':
      body=<PortalList empty={section==='calendar'?'No planned or published posts yet.':'No approved, queued or published content yet.'}>
        {(visible as Content[]).map(item=><details className="portal-list-item" key={item.id}><summary><strong>{item.title}</strong>
          <span className="muted">{item.platform} · {item.state}{item.sent_at?' · '+displayDate(item.sent_at):item.scheduled_at?' · '+displayDate(item.scheduled_at):''}</span></summary>
          <p>{item.format}</p>{section==='content' && <><p className="portal-prewrap">{item.caption}</p>{item.hashtags&&<p className="portal-prewrap muted">{item.hashtags}</p>}</>}
        </details>)}
      </PortalList>;
      break;
    case 'leads':
      body=<PortalList empty="No leads have been recorded yet.">
        {(visible as Lead[]).map(item=><details className="portal-list-item" key={item.id}><summary><strong>{item.name}</strong>
          <span className="muted">{item.source} · {item.status} · {displayDate(item.created_at)}</span></summary>
          <Facts entries={ [['Service',item.service],['Phone',item.phone],['WhatsApp',item.whatsapp_number],['Email',item.email]] }/>
        </details>)}
      </PortalList>;
      break;
    case 'advertising': {
      const performance=(data as Advertising).performance;
      body=<>
        <h3>Imported results · last 30 days</h3>
        <PortalList empty="No ad results have been imported for this period.">{performance.map(item=><article className="portal-list-item portal-ad-row" key={item.platform+item.currency}>
          <strong>{platformName(item.platform)} · {item.currency}</strong>
          <Facts entries={ [['Spend',formatMoney(item.spend,item.currency)],['Impressions',formatCount(item.impressions)],
            ['Clicks',formatCount(item.clicks)],['Reported leads',formatCount(item.leads)]] }/>
        </article>)}</PortalList>
        <h3>Approved campaign plans</h3>
        <PortalList empty="No approved campaign plans yet.">{(visible as Campaign[]).map(item=><details className="portal-list-item" key={item.id}>
          <summary><strong>{item.name}</strong><span className="muted">{platformName(item.platform)} · {item.objective}</span></summary>
          <Facts entries={ [['Start date',formatDate(item.start_date)],['End date',item.end_date?formatDate(item.end_date):'Ongoing'],
            ['Daily budget',item.daily_budget_kes===null?null:formatMoney(item.daily_budget_kes)],
            ['Monthly budget',item.monthly_budget_kes===null?null:formatMoney(item.monthly_budget_kes)],
            ['Target locations',item.target_locations.map(location=>location.name).join(', ')]] }/>
        </details>)}</PortalList>
      </>;
      break;
    }
    case 'reports':
      body=<PortalList empty="Your reports will appear here after approval.">
        {(visible as Report[]).map(item=><details className="portal-list-item" key={item.id}><summary>
          <strong>{labelCadence(item.cadence)} report</strong><span className="muted">{periodLabel(item)} · Version {item.version}</span></summary>
          <Facts entries={reportMetrics(item.metrics).map(([label,value])=>[label,value])}/>
          {item.observations && <><h3>Observations</h3><p className="portal-prewrap">{item.observations}</p></>}
          {item.action_plan && <><h3>Next steps</h3><p className="portal-prewrap">{item.action_plan}</p></>}
          <Button variant="outline" disabled={Boolean(downloading)} onClick={()=>void download(item)}><Download size={16}/>{downloading===item.id?'Preparing…':'Download PDF'}</Button>
        </details>)}
      </PortalList>;
      break;
    case 'profile': {
      const item=data as Profile;
      body=<><Facts entries={ [['Business name',item.business_name],['Brand',item.brand_name],['Industry',item.industry],['Location',item.location],
        ['Address',item.address],['Email',item.contact_email],['Phone',item.contact_phone],['Website',item.website]] }/>
        {item.description&&<p className="portal-prewrap">{item.description}</p>}</>;
      break;
    }
    case 'package': {
      const item=data as PackageInfo;
      body=<Facts entries={ [['Package',item.package_name],['Status',item.status],
        ['Onboarding date',item.onboarding_date?formatDate(item.onboarding_date):null],
        ['Monthly service fee',item.monthly_fee_kes===null?null:formatMoney(item.monthly_fee_kes)],
        ['Monthly advertising budget',item.monthly_ad_budget_kes===null?null:formatMoney(item.monthly_ad_budget_kes)]] }/>;
      break;
    }
  }

  return <section className="panel portal-panel"><h2>{title}</h2>
    {downloadError&&<p role="alert" className="error">{downloadError}</p>}{body}
    {(page>0 || rows.length>20) && <div className="portal-actions portal-pagination">
      <Button variant="outline" disabled={page===0} onClick={()=>setPage(value=>value-1)}><ArrowLeft size={16}/> Previous</Button>
      <span className="muted">Page {page+1}</span>
      <Button variant="outline" disabled={rows.length<=20} onClick={()=>setPage(value=>value+1)}>Next <ArrowRight size={16}/></Button>
    </div>}
  </section>;
}

function Facts({entries}:{entries:[string,string|number|null][]}) {
  return <dl className="portal-facts">{entries.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{textValue(value)}</dd></div>)}</dl>;
}

function PortalList({empty,children}:{empty:string;children:ReactNode[]}) {
  return children.length?<div className="portal-list">{children}</div>:<p className="muted">{empty}</p>;
}
