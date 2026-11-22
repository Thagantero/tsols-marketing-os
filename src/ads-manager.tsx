import { useEffect,useState,type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, CloudDownload, Plus, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { monthStart,nairobiDay } from './calendar-dates';
import { edgeMessage } from './publishing';

const platforms={meta:'Meta Ads',google:'Google Ads'};
type Platform=keyof typeof platforms;
type Client={id:string;business_name:string;status:string};
type BudgetMode='daily'|'monthly';
type Target={scope:'local'|'country';name:string};
type Plan={id:string;client_id:string;platform:Platform;name:string;objective:string;budget_mode:BudgetMode;monthly_budget_kes:number|null;daily_budget_kes:number|null;
  start_date:string;start_time:string;end_date:string|null;end_time:string|null;target_location:string;target_locations:Target[];min_age:number|null;max_age:number|null;audience_gender:string;creative:string|null;external_campaign_id:string|null;plan_status:'draft'|'approved'|'archived';revision:number;updated_at:string};
type Account={id:string;platform:Platform;label:string;external_account_id:string;currency:string|null;reporting_timezone:string|null;last_verified_at:string|null};
type Snapshot={external_campaign_id:string;campaign_name:string;report_date:string;currency:string;spend:number;spend_kes:number|null;impressions:number;reach:number|null;clicks:number;leads:number|null;conversions:number|null;conversion_label:string|null;fx_rate_kes:number|null;fx_source:string|null;fx_as_of:string|null};
type Summary={row_count:number;native_spend:number|null;reported_spend_kes:number|null;missing_fx:number;impressions:number|null;clicks:number|null;leads:number|null;lead_rows:number;conversions:number|null};
type ImportRun={id:string;date_from:string;date_to:string;row_count:number;created_at:string};
type Budget={budget_limit:number|null;approved_amount:number};
const planLimit=14;
const snapshotLimit=18;
const objectives=['Leads','Sales','Traffic','Awareness','Engagement'];
const title=(value:string)=>value[0].toUpperCase()+value.slice(1);
const count=(value:number|string|null|undefined)=>value==null?'—':new Intl.NumberFormat('en-KE',{maximumFractionDigits:2}).format(Number(value));
const money=(value:number|string|null|undefined,currency='KES')=>value==null?'—':new Intl.NumberFormat('en-KE',{style:'currency',currency,maximumFractionDigits:2}).format(Number(value));

function PlatformOptions({name='platform',value}: {name?:string;value?:Platform}) {
  return <label>Platform<select name={name} defaultValue={value}>{Object.entries(platforms).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label>;
}

export function AdsManager({agencyId,initialClientId}:{agencyId:string;initialClientId?:string}) {
  const [clients,setClients]=useState<Client[]>();
  const [client,setClient]=useState('');
  const [view,setView]=useState<'plans'|'performance'>('plans');
  const [editor,setEditor]=useState<Plan|'new'>();
  const [dirty,setDirty]=useState(false);
  const [budgetMode,setBudgetMode]=useState<BudgetMode>('monthly');
  const [period,setPeriod]=useState<'fixed'|'ongoing'>('fixed');
  const [targets,setTargets]=useState<Target[]>([]);
  const [targetScope,setTargetScope]=useState<Target['scope']>('local');
  const [targetName,setTargetName]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [plans,setPlans]=useState<Plan[]>([]);
  const [planCount,setPlanCount]=useState(0);
  const [planPage,setPlanPage]=useState(0);
  const [planStatus,setPlanStatus]=useState('');
  const [loading,setLoading]=useState(true);
  const [budgetMonth,setBudgetMonth]=useState(monthStart(nairobiDay()));
  const [budget,setBudget]=useState<Budget>();
  const current=clients?.find(item=>item.id===client);
  const writable=Boolean(current&&current.status!=='archived');

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name').then(result=>{
      if(!active)return;
      if(result.error)setError('Could not load clients.');
      setClients(result.data??[]);
      setClient(result.data?.find(item=>item.id===initialClientId)?.id??result.data?.find(item=>item.status!=='archived')?.id??result.data?.[0]?.id??'');
      if(!result.data?.length)setLoading(false);
    });
    return ()=>{active=false;};
  },[agencyId,initialClientId]);

  useEffect(()=>{
    if(!supabase||!client||view!=='plans')return;
    let active=true;
    setLoading(true);
    let query=supabase.from('ad_campaigns').select('*',{count:'exact'}).eq('client_id',client);
    query=planStatus?query.eq('plan_status',planStatus):query.neq('plan_status','archived');
    void query.order('updated_at',{ascending:false}).order('id').range(planPage*planLimit,(planPage+1)*planLimit-1).then(result=>{
      if(!active)return;
      setLoading(false);
      if(result.error){setError('Could not load campaign plans.');setPlans([]);setPlanCount(0);return;}
      setPlans(result.data as Plan[]);setPlanCount(result.count??0);
    });
    return ()=>{active=false;};
  },[client,view,planStatus,planPage,refresh]);

  useEffect(()=>{
    if(!supabase||!client||view!=='plans')return;
    let active=true;
    setBudget(undefined);
    void supabase.rpc('ad_budget_for_month',{target_client:client,month_start:budgetMonth}).then(result=>{
      if(!active)return;
      if(result.error)setError('Could not check the client’s budget.');
      else setBudget(result.data?.[0] as Budget|undefined);
    });
    return ()=>{active=false;};
  },[client,view,budgetMonth,refresh]);

  function changed(){setRefresh(value=>value+1);}
  function open(plan?:Plan|'new'){
    const saved=plan&&plan!=='new'?plan:undefined;
    setError('');setNotice('');setDirty(false);setEditor(plan);
    setBudgetMode(saved?.budget_mode??'monthly');
    setPeriod(saved&&!saved.end_date?'ongoing':'fixed');
    setTargets(saved?.target_locations?.length?saved.target_locations:saved?[{scope:'local',name:saved.target_location}]:[]);
    setTargetName('');setTargetScope('local');
  }
  function withTarget(){
    const name=targetName.trim();
    if(!name)return targets;
    if(name.length>240||targets.length>=30){setError('Add up to 30 locations with names up to 240 characters.');return;}
    if(targets.some(item=>item.scope===targetScope&&item.name.toLowerCase()===name.toLowerCase())){
      setError('This target is already on the list.');return;
    }
    return [...targets,{scope:targetScope,name}];
  }
  function addTarget(){
    if(!targetName.trim())return;
    const next=withTarget();
    if(!next)return;
    setTargets(next);setTargetName('');setDirty(true);setError('');
  }
  async function perform(fn:()=>Promise<void>){
    if(busy||!supabase)return;
    setBusy(true);setError('');setNotice('');
    try{await fn();}catch(problem){setError(problem instanceof Error?problem.message:'The campaign action failed.');}
    finally{setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!writable||(editor&&editor!=='new'&&editor.plan_status==='archived'))return;
    const form=new FormData(event.currentTarget);
    const field=(name:string)=>String(form.get(name)??'').trim();
    const locations=withTarget();
    if(!locations)return;
    if(!locations.length){setError('Add at least one target location.');return;}
    const data={
      name:field('name'),platform:field('platform'),objective:field('objective'),budget_mode:budgetMode,
      monthly_budget_kes:field('monthly_budget_kes')?Number(field('monthly_budget_kes')):null,
      daily_budget_kes:budgetMode==='daily'?Number(field('daily_budget_kes')):null,
      start_date:field('start_date'),start_time:field('start_time'),
      end_date:period==='fixed'?field('end_date'):null,end_time:period==='fixed'?field('end_time'):null,
      target_location:locations[0].name,target_locations:locations,
      min_age:field('min_age')?Number(field('min_age')):null,max_age:field('max_age')?Number(field('max_age')):null,
      audience_gender:field('audience_gender'),creative:field('creative')||null,external_campaign_id:field('external_campaign_id')||null,
    };
    if(data.end_date&&(data.end_date<data.start_date||(data.end_date===data.start_date&&data.end_time!<=data.start_time))){
      setError('Choose an end date and time after the start.');return;
    }
    if(data.daily_budget_kes!=null&&data.monthly_budget_kes!=null&&data.monthly_budget_kes<data.daily_budget_kes){
      setError('The monthly cap must be at least the daily budget.');return;
    }
    if(data.min_age!=null&&data.max_age!=null&&data.min_age>data.max_age){setError('Minimum age must be at or below maximum age.');return;}
    await perform(async()=>{
      const existing=editor&&editor!=='new'?editor:undefined;
      const result=existing?await supabase!.from('ad_campaigns').update(data).eq('id',existing.id).eq('updated_at',existing.updated_at).select().maybeSingle():
        await supabase!.from('ad_campaigns').insert({...data,client_id:client}).select().single();
      if(result.error?.code==='P0001')throw new Error(result.error.message);
      if(result.error||!result.data)throw new Error('Could not save the plan. Check the fields or reopen the record.');
      setEditor(result.data as Plan);setTargets(locations);setTargetName('');setDirty(false);setNotice('Campaign plan saved.');changed();
    });
  }
  function statusChange(next:'approved'|'archived'){
    if(!editor||editor==='new'||!writable||dirty)return;
    if(!window.confirm(next==='approved'?'Approve this internal budget plan?':'Archive this plan and release its budget commitment?'))return;
    void perform(async()=>{
      const result=await supabase!.from('ad_campaigns').update({plan_status:next}).eq('id',editor.id).eq('updated_at',editor.updated_at).select().maybeSingle();
      if(result.error?.code==='P0001')throw new Error(result.error.message);
      if(result.error||!result.data)throw new Error('Could not update the plan. Reopen it and try again.');
      setEditor(result.data as Plan);setNotice(next==='approved'?'Plan approved.':'Plan archived.');changed();
    });
  }

  const activePlan=editor&&editor!=='new'?editor:undefined;
  return <>
    {editor&&<button className="text-link back-link" onClick={()=>open()}><ArrowLeft size={16}/> Campaign plans</button>}
    <header className="page-heading"><div><h1>{editor==='new'?'New campaign plan':activePlan?.name??'Ads Manager'}</h1>
      <p>{editor?current?.business_name:'Plan campaign budgets and review imported ad performance.'}</p></div>
      {!editor&&view==='plans'&&<Button disabled={!writable} onClick={()=>open('new')}><Plus size={17}/> New campaign plan</Button>}</header>
    {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    {!editor&&<nav className="tabs" aria-label="Ads Manager views">
      <button aria-current={view==='plans'?'page':undefined} onClick={()=>{setView('plans');setError('');setNotice('');}}>Campaign plans</button>
      <button aria-current={view==='performance'?'page':undefined} onClick={()=>{setView('performance');setError('');setNotice('');}}>Performance</button></nav>}
    {!editor&&<div className="ads-client-select"><label>Client<select value={client} onChange={event=>{
      setClient(event.target.value);setPlanPage(0);setError('');setNotice('');
    }}>{!clients?.length&&<option value="">No clients</option>}{clients?.map(item=><option key={item.id} value={item.id}>{item.business_name}</option>)}</select></label></div>}
    {editor?<form className="panel form-section" key={activePlan?.id??'new'} onSubmit={save} onChange={()=>setDirty(true)}>
      {activePlan&&<p className="studio-revision"><span className="status-pill">{title(activePlan.plan_status)}</span> Revision {activePlan.revision}</p>}
      <fieldset disabled={!writable||busy||activePlan?.plan_status==='archived'}>
        <div className="form-grid">
          <label className="form-wide">Campaign name<input name="name" maxLength={160} required defaultValue={activePlan?.name}/></label>
          <PlatformOptions value={activePlan?.platform}/>
          <label>Objective<select name="objective" defaultValue={activePlan?.objective}>{objectives.map(item=><option key={item}>{item}</option>)}</select></label>
          <label>Budget type<select value={budgetMode} onChange={event=>setBudgetMode(event.target.value as BudgetMode)}>
            <option value="daily">Daily budget</option><option value="monthly">Monthly budget</option>
          </select></label>
          {budgetMode==='daily'&&<label>Daily budget (KES)<input name="daily_budget_kes" type="number" min="0.01" max="9999999999.99" step="0.01" required defaultValue={activePlan?.daily_budget_kes??''}/></label>}
          <label key={budgetMode}>{budgetMode==='daily'?'Monthly cap (KES, optional)':'Monthly budget (KES)'}<input name="monthly_budget_kes" type="number"
            min="0.01" max="9999999999.99" step="0.01" required={budgetMode==='monthly'} defaultValue={activePlan?.monthly_budget_kes??''}/></label>
          <label>Campaign period<select value={period} onChange={event=>setPeriod(event.target.value as 'fixed'|'ongoing')}>
            <option value="fixed">Fixed start and end</option><option value="ongoing">Ongoing · no end date</option>
          </select></label>
          <label>Start date<input name="start_date" type="date" required defaultValue={activePlan?.start_date??nairobiDay()}/></label>
          <label>Start time (EAT)<input name="start_time" type="time" required defaultValue={activePlan?.start_time?.slice(0,5)??'00:00'}/></label>
          {period==='fixed'&&<>
            <label>End date<input name="end_date" type="date" required defaultValue={activePlan?.end_date??nairobiDay()}/></label>
            <label>End time (EAT)<input name="end_time" type="time" required defaultValue={activePlan?.end_time?.slice(0,5)??'23:59'}/></label>
          </>}
          <section className="form-wide ads-target-picker">
            <h2>Target locations</h2>
            {targets.length>0&&<ul className="ads-target-list">{targets.map(item=><li key={item.scope+':'+item.name}>
              <span>{item.name}{item.scope==='country'&&<small>Whole country</small>}</span>
              <button type="button" aria-label={'Remove '+item.name} onClick={()=>{
                setTargets(previous=>previous.filter(target=>target!==item));setDirty(true);
              }}><X size={15}/></button>
            </li>)}</ul>}
            <div className="ads-target-controls">
              <label>Location type<select value={targetScope} onChange={event=>{setTargetScope(event.target.value as Target['scope']);setTargetName('');}}>
                <option value="local">City or region</option><option value="country">Whole country</option>
              </select></label>
              <label>{targetScope==='country'?'Country name':'City or region name'}<input value={targetName}
                list={targetScope==='country'?'ads-country-list':'ads-local-list'} maxLength={240}
                onChange={event=>setTargetName(event.target.value)}
                onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addTarget();}}}/></label>
              <Button type="button" variant="outline" disabled={!targetName.trim()} onClick={addTarget}><Plus size={16}/> Add location</Button>
            </div>
            <datalist id="ads-country-list">{['Kenya','Uganda','Tanzania','Rwanda','Ethiopia','South Africa','United Kingdom','United States'].map(item=><option key={item} value={item}/>)}</datalist>
            <datalist id="ads-local-list">{['Kiserian','Ngong','Karen','Rongai','Nairobi','Kitengela','Mombasa','Kisumu'].map(item=><option key={item} value={item}/>)}</datalist>
          </section>
          <label>Minimum audience age<input name="min_age" type="number" min="18" max="65" defaultValue={activePlan?.min_age??''}/></label>
          <label>Maximum audience age<input name="max_age" type="number" min="18" max="65" defaultValue={activePlan?.max_age??''}/></label>
          <label>Audience gender<select name="audience_gender" defaultValue={activePlan?.audience_gender??'all'}><option value="all">All</option><option value="women">Women</option><option value="men">Men</option></select></label>
          <label>External campaign ID<input name="external_campaign_id" inputMode="numeric" pattern="[0-9]{1,24}" defaultValue={activePlan?.external_campaign_id??''}/></label>
          <label className="form-wide">Creative notes or asset reference<textarea name="creative" maxLength={3000} rows={4} defaultValue={activePlan?.creative??''}/></label>
        </div>
        <p className="muted">Daily budgets reserve the daily amount for each active Nairobi calendar day, up to the monthly cap if set. Monthly budgets reserve the full amount in each active month. Approval is internal.</p>
        <div className="form-actions studio-actions">
          {activePlan&&<Button type="button" variant="outline" disabled={dirty} onClick={()=>statusChange('archived')}>Archive plan</Button>}
          {activePlan?.plan_status==='draft'&&<Button type="button" variant="outline" disabled={dirty} onClick={()=>statusChange('approved')}><Check size={16}/> Approve saved plan</Button>}
          <Button type="submit">{busy?'Saving…':'Save plan'}</Button>
        </div>
      </fieldset>
    </form>:view==='plans'?<>
      <section className="panel form-section">
        <div className="calendar-controls"><h2>Monthly ad budget</h2><label>Month<input type="month" value={budgetMonth.slice(0,7)} onChange={event=>{if(event.target.value)setBudgetMonth(event.target.value+'-01');}}/></label></div>
        <div className="ads-stats">
          <div><small>Client limit</small><strong>{money(budget?.budget_limit)}</strong></div>
          <div><small>Approved plans</small><strong>{money(budget?.approved_amount)}</strong></div>
          <div><small>Available to plan</small><strong>{budget?.budget_limit!=null?money(Number(budget.budget_limit)-Number(budget.approved_amount)):'—'}</strong></div>
        </div>
        {current&&budget?.budget_limit===null&&<p className="muted">Set the monthly ad budget in <a className="text-link" href={'#/clients/'+client}>Client Manager <ArrowUpRight size={13}/></a> before approving a plan.</p>}
      </section>
      <section className="panel"><div className="table-tools studio-filters"><label>Status<select value={planStatus} onChange={event=>{setPlanStatus(event.target.value);setPlanPage(0);}}>
        <option value="">Current plans</option>{['draft','approved','archived'].map(item=><option key={item} value={item}>{title(item)}</option>)}
      </select></label></div>
        {loading?<p className="empty" role="status">Loading campaign plans…</p>:plans.length?<div className="table-scroll"><table>
          <thead><tr><th>Campaign</th><th>Objective</th><th>Dates</th><th>Budget</th><th>Status</th></tr></thead>
          <tbody>{plans.map(plan=><tr key={plan.id}><td><button type="button" className="text-link" onClick={()=>open(plan)}>{plan.name}</button><small>{platforms[plan.platform]} · {plan.target_locations.map(item=>item.name+(item.scope==='country'?' (country)':'')).join(', ')}</small></td>
            <td>{plan.objective}</td><td>{plan.start_date} {plan.start_time.slice(0,5)}<small>{plan.end_date?'To '+plan.end_date+' '+(plan.end_time?.slice(0,5)??''):'Ongoing'} · EAT</small></td>
            <td>{plan.budget_mode==='daily'?money(plan.daily_budget_kes)+' / day':money(plan.monthly_budget_kes)+' / month'}
              {plan.budget_mode==='daily'&&plan.monthly_budget_kes!=null&&<small>{money(plan.monthly_budget_kes)} monthly cap</small>}</td><td><span className="status-pill">{title(plan.plan_status)}</span></td></tr>)}</tbody>
        </table></div>:<p className="empty">No campaign plans match this view.</p>}
        <Pages total={planCount} size={planLimit} page={planPage} setPage={setPlanPage} loading={loading}/>
      </section>
    </>:client?<AdsPerformance key={client} client={client} writable={writable}/>:<p className="empty">Choose a client to view performance.</p>}
  </>;
}

function Pages({total,size,page,setPage,loading}:{total:number;size:number;page:number;setPage:(page:number)=>void;loading:boolean}) {
  if(total<=size)return null;
  return <div className="pagination"><span>{page*size+1}–{Math.min((page+1)*size,total)} of {total}</span>
    <Button variant="outline" aria-label="Previous page" disabled={loading||page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></Button>
    <Button variant="outline" aria-label="Next page" disabled={loading||(page+1)*size>=total} onClick={()=>setPage(page+1)}><ChevronRight size={16}/></Button></div>;
}

function AdsPerformance({client,writable}:{client:string;writable:boolean}) {
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [accountId,setAccountId]=useState('');
  const [from,setFrom]=useState(monthStart(nairobiDay()));
  const [to,setTo]=useState(nairobiDay());
  const [rows,setRows]=useState<Snapshot[]>([]);
  const [summary,setSummary]=useState<Summary>();
  const [imports,setImports]=useState<ImportRun[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const account=accounts.find(item=>item.id===accountId);
  const validRange=Boolean(from&&to&&from<=to&&((Date.parse(to)-Date.parse(from))/86400000)<=30);

  useEffect(()=>{
    let active=true;
    void supabase?.from('ad_accounts').select('*').eq('client_id',client).order('label').then(result=>{
      if(!active)return;
      if(result.error){setError('Could not load advertising accounts.');return;}
      setAccounts(result.data as Account[]);
      setAccountId(previous=>result.data.some(item=>item.id===previous)?previous:result.data[0]?.id??'');
    });
    return ()=>{active=false;};
  },[client,refresh]);

  useEffect(()=>{
    if(!supabase||!accountId||!validRange){setRows([]);setSummary(undefined);setImports([]);setTotal(0);setLoading(false);return;}
    let active=true;
    setLoading(true);
    const db=supabase;
    void Promise.all([
      db.from('ad_performance_snapshots').select('*').eq('account_id',accountId).gte('report_date',from).lte('report_date',to)
        .order('report_date',{ascending:false}).order('external_campaign_id').range(page*snapshotLimit,(page+1)*snapshotLimit-1),
      db.rpc('ad_performance_summary',{target_account:accountId,from_date:from,to_date:to}),
      db.from('ad_import_runs').select('id,date_from,date_to,row_count,created_at').eq('account_id',accountId).order('created_at',{ascending:false}).limit(5),
    ]).then(([details,totals,runs])=>{
      if(!active)return;
      setLoading(false);
      if(details.error||totals.error||runs.error){setError('Could not load imported performance.');setRows([]);setSummary(undefined);setImports([]);setTotal(0);return;}
      setRows(details.data as Snapshot[]);setSummary(totals.data?.[0] as Summary|undefined);
      setTotal(Number(totals.data?.[0]?.row_count??0));setImports(runs.data as ImportRun[]);
    });
    return ()=>{active=false;};
  },[accountId,from,to,page,refresh,validRange]);

  async function perform(fn:()=>Promise<void>){
    if(busy||!supabase||!writable)return;
    setBusy(true);setError('');setNotice('');
    try{await fn();}catch(problem){setError(problem instanceof Error?problem.message:'The account action failed.');}
    finally{setBusy(false);}
  }
  function register(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const platform=String(form.get('platform')??'') as Platform;
    const id=String(form.get('external_account_id')??'').trim().replace(/^act_/i,'').replaceAll('-','');
    const label=String(form.get('label')??'').trim();
    if(!(platform==='google'?/^\d{10}$/:/^\d{5,24}$/).test(id)||!label){setError('Enter a valid platform account ID and a label.');return;}
    const target=event.currentTarget;
    void perform(async()=>{
      const result=await supabase!.from('ad_accounts').insert({client_id:client,platform,external_account_id:id,label}).select('id').single();
      if(result.error)throw new Error(result.error.code==='23505'?'This ad account is already registered.':'Could not register the ad account.');
      target.reset();setAccountId(result.data.id);setPage(0);setRefresh(value=>value+1);
      setNotice('Account registered. Run an import to verify the connection.');
    });
  }
  function sync(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!account||!validRange||!writable)return;
    const form=new FormData(event.currentTarget);
    const rate=String(form.get('fx_rate')??'').trim();
    const source=String(form.get('fx_source')??'').trim();
    const effective=String(form.get('fx_as_of')??'');
    if(rate&&(!Number.isFinite(Number(rate))||Number(rate)<=0||!source||!effective)){
      setError('Provide a positive conversion rate, the source, and an effective date.');return;
    }
    void perform(async()=>{
      const result=await supabase!.functions.invoke<{row_count:number;currency:string}>('import-ad-performance',{body:{
        account_id:account.id,date_from:from,date_to:to,fx_rate:rate?Number(rate):null,fx_source:source||null,fx_as_of:effective||null,
      }});
      if(result.error)throw new Error(await edgeMessage(result.error,'The performance import failed.'));
      setPage(0);setRefresh(value=>value+1);
      setNotice((result.data?.row_count??0)+' campaign-day rows imported.');
    });
  }
  const rateComplete=summary&&Number(summary.row_count)>0&&Number(summary.missing_fx)===0;
  const ctr=summary&&Number(summary.impressions)>0?(Number(summary.clicks)/Number(summary.impressions))*100:null;
  const cpc=rateComplete&&Number(summary?.clicks)>0?Number(summary?.reported_spend_kes)/Number(summary?.clicks):null;
  const cpl=rateComplete&&Number(summary?.lead_rows)===Number(summary?.row_count)&&Number(summary?.leads)>0
    ?Number(summary?.reported_spend_kes)/Number(summary?.leads):null;

  return <>
    {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
    <details className="panel form-section buffer-setup">
      <summary>Register an ad account</summary>
      <form onSubmit={register}><fieldset disabled={!writable||busy}>
        <div className="form-grid ads-register"><PlatformOptions/>
          <label>Provider account ID<input name="external_account_id" required maxLength={30}/></label>
          <label className="form-wide">Account label<input required name="label" maxLength={100}/></label></div>
        <div className="form-actions"><Button type="submit">Register account</Button></div>
      </fieldset></form>
    </details>
    <section className="panel form-section">
      <form onSubmit={sync}><fieldset disabled={busy}>
        <div className="calendar-filters">
          <label>Ad account<select value={accountId} onChange={event=>{setAccountId(event.target.value);setPage(0);setError('');setNotice('');}}>
            {!accounts.length&&<option value="">No accounts</option>}{accounts.map(item=><option key={item.id} value={item.id}>{item.label} · {platforms[item.platform]}</option>)}
          </select></label>
          <label>From<input type="date" required value={from} max={to} onChange={event=>{setFrom(event.target.value);setPage(0);}}/></label>
          <label>Through<input type="date" required value={to} min={from} onChange={event=>{setTo(event.target.value);setPage(0);}}/></label>
        </div>
        {account&&<p className="muted">{account.external_account_id} · {account.currency??'Currency pending verification'}{account.reporting_timezone?' · '+account.reporting_timezone:''} · {account.last_verified_at?'Verified '+displayDate(account.last_verified_at):'Awaiting first import'}</p>}
        {account&&account.currency!=='KES'&&<details className="poster-ai"><summary>KES conversion assumption</summary>
          <div className="form-grid">
            <label>KES per unit of account currency<input name="fx_rate" type="number" min="0.00000001" step="0.00000001"/></label>
            <label>Source<input name="fx_source" maxLength={160}/></label>
            <label>Effective date<input name="fx_as_of" type="date"/></label>
          </div><p className="muted">One rate applies to the imported date range. Leave blank to keep original currency and any previously saved rate.</p>
        </details>}
        {!validRange&&<p className="error">Select a range of up to 31 days.</p>}
        <div className="form-actions"><Button type="submit" disabled={!accountId||!validRange||!writable||busy}><CloudDownload size={16}/>{busy?'Importing…':'Import performance'}</Button></div>
      </fieldset></form>
    </section>
    <section className="panel form-section">
      <h2>Imported totals</h2>
      <div className="ads-stats">
        <div><small>Original spend</small><strong>{money(summary?.native_spend,account?.currency??'KES')}</strong></div>
        <div><small>Spend (KES, calculated)</small><strong>{rateComplete?money(summary?.reported_spend_kes):'—'}</strong></div>
        <div><small>Impressions</small><strong>{count(summary?.impressions)}</strong></div>
        <div><small>Clicks</small><strong>{count(summary?.clicks)}</strong></div>
        <div><small>Reported leads</small><strong>{count(summary?.leads)}</strong></div>
        <div><small>Reported conversions</small><strong>{count(summary?.conversions)}</strong></div>
      </div>
      <p className="muted">Calculated CTR {ctr===null?'—':count(ctr)+'%'} · CPC {money(cpc)} · CPL {money(cpl)}</p>
      {Number(summary?.missing_fx??0)>0&&<p className="muted">Some rows lack a KES conversion rate. Reimport the range with a documented rate to calculate complete KES figures.</p>}
    </section>
    <section className="panel form-section">
      <h2>Daily campaign performance</h2>
      {loading?<p className="empty" role="status">Loading performance…</p>:rows.length?<div className="table-scroll"><table>
        <thead><tr><th>Campaign</th><th>Date</th><th>Original spend</th><th>Spend (KES)</th><th>Impressions</th><th>Reach</th><th>Clicks</th><th>Leads</th><th>Conversions</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.external_campaign_id+':'+row.report_date}>
          <td>{row.campaign_name}<small>{row.external_campaign_id}</small></td><td>{row.report_date}</td><td>{money(row.spend,row.currency)}</td>
          <td>{money(row.spend_kes)}{row.fx_rate_kes!=null&&row.currency!=='KES'&&<small>{row.fx_rate_kes} · {row.fx_source} · {row.fx_as_of}</small>}</td>
          <td>{count(row.impressions)}</td><td>{count(row.reach)}</td><td>{count(row.clicks)}</td><td>{count(row.leads)}</td>
          <td>{count(row.conversions)}{row.conversion_label&&<small>{row.conversion_label}</small>}</td></tr>)}</tbody>
      </table></div>:<p className="empty">No imported campaign data for this range.</p>}
      <Pages total={total} size={snapshotLimit} page={page} setPage={setPage} loading={loading}/>
      {rows.length>0&&<p className="muted">Dates use the provider account’s reporting timezone. Daily reach is shown per campaign and is not summed across rows.</p>}
    </section>
    {imports.length>0&&<section className="panel form-section"><h2>Recent imports</h2>{imports.map(run=><div className="activity-row" key={run.id}>
      <span><strong>{run.date_from} – {run.date_to}</strong><small>{run.row_count} rows</small></span><time>{displayDate(run.created_at)}</time></div>)}</section>}
  </>;
}
