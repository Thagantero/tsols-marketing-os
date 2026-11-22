import {analyticsOAuthResponse} from './analytics-oauth-response';
import {AnalyticsOAuthCallback} from './analytics-oauth-callback';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Activity as Pulse, ArrowRight, Bell, Bot, Building2, CalendarDays, ChartNoAxesCombined, ChevronLeft, ChevronRight, CircleDollarSign, ClipboardList, Clock3, FilePenLine, Flame, ImageIcon, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen, MessageSquare, Plus, Radio, Search, Settings, Sparkles, Users, Workflow, X, type LucideIcon } from 'lucide-react';
import { AuthScreen, BrandMark } from './auth';
import { Button } from './components/ui/button';
import { ClientEditor } from './client-editor';
import { ContentStudio } from './content-studio';
import { displayDate, statuses, supabase, type Activity, type Agency, type Assigned, type ClientRecord, type Status } from './data';

const Billing = lazy(() => import('./billing').then(module => ({default:module.Billing})));
const AgentOperations = lazy(() => import('./agent-operations').then(module => ({default:module.AgentOperations})));
const ClientPortal = lazy(() => import('./client-portal').then(module => ({default:module.ClientPortal})));
const Reports = lazy(() => import('./reports').then(module => ({default:module.Reports})));
const AdsManager = lazy(() => import('./ads-manager').then(module => ({default:module.AdsManager})));
const LeadsHub = lazy(() => import('./leads').then(module => ({default:module.LeadsHub})));
const PublishingHistory = lazy(() => import('./publishing-history').then(module => ({default:module.PublishingHistory})));
const MediaLibrary = lazy(() => import('./media-library').then(module => ({default:module.MediaLibrary})));
const ContentCalendar = lazy(() => import('./content-calendar').then(module => ({default:module.ContentCalendar})));

const sections: { title: string; links: { path: string; label: string; icon: LucideIcon; phase?: number }[] }[] = [
  {title:'Workspace',links:[
    {path:'dashboard',label:'Dashboard',icon:LayoutDashboard},{path:'clients',label:'Clients',icon:Users},
    {path:'studio',label:'Content Studio',icon:Sparkles},{path:'media',label:'Media Library',icon:ImageIcon},{path:'calendar',label:'Content Calendar',icon:CalendarDays},
    {path:'publishing',label:'Publishing',icon:Radio},{path:'leads',label:'Leads & WhatsApp',icon:MessageSquare},
    {path:'ads',label:'Ads Manager',icon:ChartNoAxesCombined},{path:'reports',label:'Reports & Analytics',icon:ClipboardList},
  ]},
  {title:'Operations',links:[
    {path:'agents',label:'AI Agents',icon:Bot},{path:'automations',label:'Automations',icon:Workflow},
    {path:'billing',label:'Packages & Billing',icon:CircleDollarSign},{path:'settings',label:'Settings',icon:Settings},
  ]},
];
const naviDate = new Intl.DateTimeFormat('en-KE', { weekday:'long', day:'numeric', month:'long', timeZone:'Africa/Nairobi' });

function go(route: string) { window.location.hash = `/${route}`; }
function path() { return window.location.hash.replace(/^#\/?/, '') || 'dashboard'; }

export function App() {
  const [portalToken, setPortalToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('portal_token'));
  const [inviteStatus, setInviteStatus] = useState<'idle'|'verifying'|'expired'>('idle');
  const clientMode = new URLSearchParams(location.search).has('client') || path().split('/')[0]==='portal';
  const [session, setSession] = useState<Session | null>();
  const [recovery, setRecovery] = useState(new URLSearchParams(location.search).has('reset'));
  const [recoveryVerified, setRecoveryVerified] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, current) => {
      if (event === 'PASSWORD_RECOVERY') { setRecovery(true); setRecoveryVerified(true); }
      if (event === 'SIGNED_OUT') setRecoveryVerified(false);
      setSession(current);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  async function acceptInvitation() {
    if (!supabase || !portalToken || inviteStatus === 'verifying') return;
    setInviteStatus('verifying');
    const { error } = await supabase.auth.verifyOtp({token_hash:portalToken,type:'email'});
    history.replaceState(null, '', '/app/?client=1#/portal/overview');
    if (error) {setInviteStatus('expired');return;}
    setPortalToken(null);
  }
  if (portalToken) return <main className="assigned"><BrandMark/><section className="panel form-section">
    <h1>TSOLS Client Portal invitation</h1>
    {inviteStatus==='expired'
      ? <><p className="error" role="alert">This link could not be verified. Ask your administrator for a new invitation or sign in with your existing account.</p>
        <Button variant="outline" onClick={()=>setPortalToken(null)}>Continue to sign-in</Button></>
      : <><p>Accept this invitation to sign in to your assigned business.</p>
        <Button disabled={inviteStatus==='verifying'} onClick={()=>void acceptInvitation()}>{inviteStatus==='verifying'?'Verifying…':'Accept invitation'}</Button></>}
  </section></main>;
  if (supabase && session === undefined) return <main className="loading-page" role="status">Opening TSOLS workspace…</main>;
  if (!session || recovery) return <AuthScreen clientMode={clientMode} recovery={recovery} canUpdatePassword={Boolean(session) && recoveryVerified} finish={() => {
    history.replaceState(null, '', location.pathname);
    setRecovery(false);
    setRecoveryVerified(false);
  }}/>;
  if(analyticsOAuthResponse)return <AnalyticsOAuthCallback/>;
  return <Workspace key={session.user.id} user={session.user.id} email={session.user.email ?? ''}/>;
}

function Workspace({ user, email }: { user: string; email: string }) {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [assigned, setAssigned] = useState<Assigned[]>([]);
  const [agencyId, setAgencyId] = useState('');
  const [name, setName] = useState('');
  const [route, setRoute] = useState(path);
  const [menu, setMenu] = useState(false);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>{try{return localStorage.getItem('tsols-sidebar-collapsed')==='true';}catch{return false;}});
  function toggleSidebar(){setSidebarCollapsed(value=>{const next=!value;try{localStorage.setItem('tsols-sidebar-collapsed',String(next));}catch{}return next;});}
  useEffect(()=>{if(!menu)return;function dismiss(event:KeyboardEvent){if(event.key==='Escape')setMenu(false);}window.addEventListener('keydown',dismiss);return()=>window.removeEventListener('keydown',dismiss);},[menu]);
  const [account, setAccount] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState('');
  const agency = agencies.find(item => item.id === agencyId);
  const [page, clientId, studioItem, studioDay] = route.split('/');
  const current = sections.flatMap(item => item.links).find(item => item.path === page);

  useEffect(() => {
    function changed() { setRoute(path()); setMenu(false); setAccount(false); window.scrollTo(0, 0); }
    window.addEventListener('hashchange',changed);
    return () => window.removeEventListener('hashchange',changed);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const db = supabase;
    void Promise.all([
      db.from('agencies').select('id,name').order('name'),
      db.from('profiles').select('display_name').eq('id',user).maybeSingle(),
      db.rpc('claim_client_portal_access').then(async claim => {
        const businesses = await db.rpc('assigned_businesses');
        return {...businesses,claimError:claim.error};
      }),
    ]).then(([tenants, profile, businesses]) => {
      if (cancelled) return;
      setLoading(false);
      if (tenants.error || profile.error || businesses.error) { setError('Could not load workspace access. Refresh and try again.'); return; }
      setAgencies(tenants.data);
      setAgencyId(tenants.data[0]?.id ?? '');
      setName(profile.data?.display_name ?? '');
      setAssigned(businesses.data);
      if (businesses.claimError && (path().split('/')[0] === 'portal' || !tenants.data.length)) setError('Could not activate pending invitations. Refresh and try again.');
    });
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (!loading && assigned.length && !agency && page !== 'portal') {
      history.replaceState(null, '', location.pathname + location.search + '#/portal/overview');
      setRoute('portal/overview');
    }
  }, [agency, assigned.length, loading, page]);

  async function signOut() {
    const result = await supabase?.auth.signOut();
    if (result?.error) setError('Could not sign out. Please try again.');
  }

  if (loading) return <main className="loading-page" role="status">Checking workspace access…</main>;
  const showPortal = !agency || page==='portal';
  if (showPortal && assigned.length) return <Suspense fallback={<main className="loading-page" role="status">Opening client portal…</main>}>
    <ClientPortal assigned={assigned} route={route} signOut={signOut} agencyAccess={Boolean(agency)}/>
    {error&&<p className="error portal-main" role="alert">{error}</p>}
  </Suspense>;
  if (showPortal || !agency) return <main className="assigned"><BrandMark/><section className="panel form-section">
    <h1>Client portal access</h1>
    {error && <p className="error" role="alert">{error}</p>}
    {!error && <p>Ask your TSOLS administrator to invite {email || 'your account email'} to your business.</p>}
    {agency && <Button variant="ghost" asChild><a href="/app/">Agency workspace</a></Button>}
    <Button variant="outline" onClick={signOut}><LogOut size={17}/> Sign out</Button>
  </section></main>;

  return <div className={`workspace ${sidebarCollapsed?'workspace-collapsed':''}`}>
    {menu && <button type="button" className="backdrop" aria-label="Close menu" onClick={() => setMenu(false)}/>}
    <aside id="workspace-sidebar" className={`sidebar ${menu ? 'sidebar-open' : ''}`}>
      <div className="sidebar-heading"><a className="sidebar-brand" href="#/dashboard" aria-label="TSOLS dashboard" title="TSOLS dashboard"><BrandMark/></a><button type="button" className="sidebar-mobile-close" aria-label="Close menu" onClick={()=>setMenu(false)}><X size={20}/></button></div>
      <div className="agency-profile" title={agency.name}><span className="agency-symbol"><Building2 size={17}/></span>
        {agencies.length > 1 ? <select aria-label="Agency" value={agencyId} onChange={event => {setAgencyId(event.target.value);go('dashboard');}}>
          {agencies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          : <div><strong>{agency.name}</strong><small>Agency workspace</small></div>}
      </div>
      <nav aria-label="Workspace">
        {sections.map(group => <div className="nav-group" key={group.title}><p>{group.title}</p>{group.links.map(({path: href,label,icon: Icon}) =>
          <a key={href} href={`#/${href}`} aria-label={label} title={label} aria-current={page === href ? 'page' : undefined} onClick={() => setMenu(false)}><Icon size={18}/><span className="nav-label">{label}</span></a>)}</div>)}
      </nav>
      <div className="sidebar-footer" title="Africa/Nairobi · EAT"><span/><span className="sidebar-timezone">Africa/Nairobi · EAT</span></div>
    </aside>
    <div className="main-workspace">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="workspace-sidebar" onClick={() => setMenu(!menu)}>{menu ? <X size={22}/> : <Menu size={22}/>}</button>
        <button type="button" className="icon-button sidebar-toggle" aria-label={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} title={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" onClick={toggleSidebar}>{sidebarCollapsed?<PanelLeftOpen size={20}/>:<PanelLeftClose size={20}/>}</button>
        <p>{current?.label ?? 'Workspace'}</p>
        <div className="top-actions">
          <Button variant="ghost" aria-label="Find a client" onClick={() => go('clients')}><Search size={19}/></Button>
          <Button variant="ghost" aria-label="View recent activity" onClick={() => {
            go('dashboard');
            setTimeout(() => document.getElementById('recent-activity')?.scrollIntoView({block:'start'}), 100);
          }}><Bell size={19}/></Button>
          <div className="account-menu">
            <button className="avatar" aria-label="Account menu" aria-expanded={account} onClick={() => setAccount(!account)}>{(name || email || 'A').slice(0, 2).toUpperCase()}</button>
            {account && <div className="account-flyout panel"><strong>{name || 'Agency administrator'}</strong><small>{email}</small><Button variant="outline" onClick={signOut}><LogOut size={16}/> Sign out</Button></div>}
          </div>
        </div>
      </header>
      <main className="workspace-body" key={agencyId}>
        {error && <p className="error" role="alert">{error}</p>}
        {page === 'dashboard' ? <Dashboard agency={agency}/>
          : page === 'agents' || page === 'automations' ? <Suspense fallback={<p role="status">Opening agent operations…</p>}><AgentOperations key={page} agencyId={agencyId} automation={page==='automations'}/></Suspense>
          : page === 'billing' ? <Suspense fallback={<p role="status">Opening billing…</p>}><Billing agencyId={agencyId}/></Suspense>
          : page === 'studio' ? <ContentStudio key={route} agencyId={agencyId} initialClientId={clientId} initialItem={studioItem} initialDay={studioDay}/>
          : page === 'reports' ? <Suspense fallback={<p role="status">Opening reports…</p>}><Reports key={route} agencyId={agencyId} initialClientId={clientId} initialView={studioItem}/></Suspense>
          : page === 'ads' ? <Suspense fallback={<p role="status">Opening Ads Manager…</p>}><AdsManager key={route} agencyId={agencyId} initialClientId={clientId}/></Suspense>
          : page === 'leads' ? <Suspense fallback={<p role="status">Opening lead inbox…</p>}><LeadsHub key={route} agencyId={agencyId} user={user} initialClientId={clientId} initialHot={studioItem==='hot'}/></Suspense>
          : page === 'publishing' ? <Suspense fallback={<p role="status">Opening publishing history…</p>}><PublishingHistory agencyId={agencyId}/></Suspense>
          : page === 'media' ? <Suspense fallback={<p role="status">Opening media library…</p>}><MediaLibrary agencyId={agencyId}/></Suspense>
          : page === 'calendar' ? <Suspense fallback={<p role="status">Opening calendar…</p>}><ContentCalendar key={route} agencyId={agencyId} initialClientId={clientId}/></Suspense>
          : page === 'clients' && clientId ? <ClientEditor key={clientId} agencyId={agencyId} clientId={clientId === 'new' ? undefined : clientId}
            goBack={() => go('clients')} saved={() => {setUpdated('Client saved.');go('clients');}}/>
          : page === 'clients' ? <ClientList agencyId={agencyId} updated={updated} clear={() => setUpdated('')}/>
          : <><header className="page-heading"><div><h1>{current?.label ?? 'Page unavailable'}</h1></div></header>
            <section className="panel form-section">{current?.phase ? <p>Coming in Phase {current.phase}.</p> : page === 'settings'
              ? <><h2>Workspace settings</h2><p className="muted">{agency.name} · KES · Africa/Nairobi</p><p>Manage portal invitations under <a href="#/clients">Clients</a> → Settings.</p></>
              : <Button onClick={() => go('dashboard')}>Open dashboard</Button>}</section></>}
      </main>
    </div>
  </div>;
}

function Dashboard({ agency }: { agency: Agency }) {
  const [data, setData] = useState<{ counts: number[]; activity: Activity[]; clients: Record<string,string> }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const db = supabase;
    const counts = [
      db.from('clients').select('id',{count:'exact',head:true}).eq('agency_id',agency.id).neq('status','archived'),
      ...(['active','onboarding','paused'] as const).map(status => db.from('clients').select('id',{count:'exact',head:true}).eq('agency_id',agency.id).eq('status',status)),
      db.from('content_calendar').select('id,clients!inner(agency_id,status)',{count:'exact',head:true}).neq('status','approved').neq('content_origin','manual').eq('clients.agency_id',agency.id).neq('clients.status','archived'),
      db.from('leads').select('id,clients!inner(agency_id,status)',{count:'exact',head:true}).eq('priority','hot').not('status','in','(booked,won,lost)').eq('clients.agency_id',agency.id).neq('clients.status','archived'),
    ];
    void Promise.all([
      Promise.all(counts),
      db.from('audit_logs').select('id, client_id, action, created_at, clients(business_name)').eq('agency_id',agency.id).order('created_at',{ascending:false}).limit(8),
    ]).then(([results, recent]) => {
      if (!active) return;
      if (results.some(result => result.error) || recent.error) { setError('Could not load dashboard data. Refresh and try again.'); return; }
      const clients: Record<string,string> = {};
      for (const row of recent.data) {
        const related = row.clients as unknown as { business_name: string } | null;
        if (related) clients[row.client_id] = related.business_name;
      }
      setData({ counts: results.map(result => result.count ?? 0), activity:recent.data, clients });
    });
    return () => { active = false; };
  }, [agency.id]);
  const stats = [{label:'Total clients',Icon:Building2},{label:'Active clients',Icon:Users},{label:'Onboarding',Icon:ClipboardList},{label:'Paused',Icon:Clock3},{label:'Needs review',Icon:FilePenLine},{label:'Hot leads',Icon:Flame}];
  return <>
    <header className="page-heading"><div><p className="heading-date">{naviDate.format(new Date())}</p><h1>Agency dashboard</h1><p>Client activity and operations at a glance.</p></div>
      <Button onClick={() => go('clients/new')}><Plus size={18}/> Add client</Button></header>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="stat-grid studio-stat-grid">{stats.map(({label,Icon}, index) => <section className="panel stat" key={label}>
      <div className="stat-icon"><Icon size={20}/></div><p>{label==='Needs review'?<a className="text-link" href="#/studio//review">{label}</a>:label==='Hot leads'?<a className="text-link" href="#/leads//hot">{label}</a>:label}</p><strong>{data?.counts[index] ?? '—'}</strong>
    </section>)}</div>
    <div className="dashboard-grid">
      <section id="recent-activity" className="panel activity"><div className="panel-header"><div><h2>Recent client activity</h2><p>Changes recorded in this workspace</p></div><Pulse size={20}/></div>
        {!data && !error && <p className="empty" role="status">Loading activity…</p>}
        {data?.activity.length === 0 && <p className="empty">Client updates will appear here.</p>}
        {data?.activity.map(event => <a className="activity-row" href={`#/clients/${event.client_id}`} key={event.id}>
          <span className="event-icon"><Building2 size={17}/></span><span><strong>{event.action}</strong><small>{data.clients[event.client_id] ?? 'Client record'}</small></span>
          <time dateTime={event.created_at}>{displayDate(event.created_at)}</time></a>)}
      </section>
      <section className="panel activity"><div className="panel-header"><div><h2>Quick actions</h2><p>Start work from your dashboard</p></div></div>
        <button className="activity-row" onClick={() => go('clients/new')}><span className="event-icon"><Plus size={18}/></span><strong>Add client</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('clients')}><span className="event-icon"><Users size={18}/></span><strong>Manage clients</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('studio')}><span className="event-icon"><Sparkles size={18}/></span><strong>Open Content Studio</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('calendar')}><span className="event-icon"><CalendarDays size={18}/></span><strong>Plan posts</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('leads')}><span className="event-icon"><MessageSquare size={18}/></span><strong>Open lead inbox</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('ads')}><span className="event-icon"><ChartNoAxesCombined size={18}/></span><strong>Plan ad campaigns</strong><ArrowRight size={16}/></button>
        <button className="activity-row" onClick={() => go('reports')}><span className="event-icon"><ClipboardList size={18}/></span><strong>Open reports</strong><ArrowRight size={16}/></button>
      </section>
    </div>
  </>;
}

const pageSize = 12;
function ClientList({ agencyId, updated, clear }: { agencyId: string; updated: string; clear: () => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [page, setPage] = useState(0);
  const [records, setRecords] = useState<ClientRecord[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!updated) return;
    const timeout = setTimeout(clear, 3000);
    return () => clearTimeout(timeout);
  }, [updated, clear]);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const db = supabase;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      let query = db.from('clients').select('id,business_name,industry,location,status,package_name,updated_at',{count:'exact'}).eq('agency_id',agencyId);
      query = status ? query.eq('status',status) : query.neq('status','archived');
      const term = search.trim().replace(/[\\%_*]/g, character => '\\' + character);
      if (term) query = query.ilike('business_name',`%${term}%`);
      const result = await query.order('business_name').order('id').range(page * pageSize,(page + 1) * pageSize - 1);
      if (!active) return;
      setLoading(false);
      if (result.error) { setError('Could not load clients. Refresh and try again.'); return; }
      setRecords(result.data as ClientRecord[]);
      setCount(result.count ?? 0);
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [agencyId, search, status, page]);
  return <>
    <header className="page-heading"><div><h1>Clients</h1><p>Manage client businesses, brand profiles and contacts.</p></div><Button onClick={() => go('clients/new')}><Plus size={18}/> Add client</Button></header>
    {updated && <p className="notice" role="status">{updated}</p>}
    <section className="panel">
      <div className="table-tools"><label className="search-field"><Search size={18}/><input aria-label="Search by business name" placeholder="Search business name" value={search}
        onChange={event => {setSearch(event.target.value);setPage(0);}}/></label>
        <select aria-label="Filter by status" value={status} onChange={event => {setStatus(event.target.value as Status | '');setPage(0);}}>
          <option value="">All current clients</option>{statuses.map(item => <option key={item} value={item}>{item[0].toUpperCase()+item.slice(1)}</option>)}
        </select></div>
      {loading ? <p className="empty" role="status">Loading clients…</p> : error ? <p className="empty error" role="alert">{error}</p>
        : records.length === 0 ? <p className="empty">{search || status ? 'No clients match these filters.' : 'Add your first client to get started.'}</p>
        : <div className="table-scroll"><table><thead><tr><th scope="col">Business</th><th scope="col">Location</th><th scope="col">Package</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Open client</span></th></tr></thead>
          <tbody>{records.map(client => <tr key={client.id}><td><a href={`#/clients/${client.id}`}>{client.business_name}</a><small>{client.industry}</small></td>
            <td>{client.location}</td><td>{client.package_name ?? '—'}</td><td><span className={`status-pill ${client.status}`}>{client.status}</span></td>
            <td><a href={`#/clients/${client.id}`} aria-label={`Open ${client.business_name}`}><ChevronRight size={18}/></a></td></tr>)}</tbody></table></div>}
      {count > pageSize && !error && <div className="pagination"><span>{page * pageSize + 1}–{Math.min((page+1)*pageSize,count)} of {count} clients</span>
        <Button variant="outline" disabled={loading || page===0} aria-label="Previous page" onClick={() => setPage(page-1)}><ChevronLeft size={17}/></Button>
        <Button variant="outline" disabled={loading || (page+1)*pageSize>=count} aria-label="Next page" onClick={() => setPage(page+1)}><ChevronRight size={17}/></Button></div>}
    </section>
  </>;
}
