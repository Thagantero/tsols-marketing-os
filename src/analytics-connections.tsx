import {AnalyticsPropertyPicker,connectAnalyticsAccount,type AccountConnectionResult} from './analytics-account-connect';
import {useEffect,useState,type FormEvent} from 'react';
import {CheckCircle2,ExternalLink,KeyRound,RefreshCw,Link2} from 'lucide-react';
import {Button} from './components/ui/button';
import {displayDate} from './data';
export type AnalyticsConnection={ga4_property_id:string|null;search_console_property:string|null;bing_site_url:string|null;google_email:string|null;google_verified_at:string|null;ga4_email?:string|null;search_email?:string|null;ga4_verified_at?:string|null;search_verified_at?:string|null;bing_verified_at:string|null;ga4_auth_method?:'key'|'oauth';search_auth_method?:'key'|'oauth';bing_auth_method?:'key'|'oauth'};
export type AnalyticsRequest=<T={message:string}>(body:Record<string,unknown>)=>Promise<T>;
type OAuthStatus={google:{configured:boolean;client_id:string;redirect_uri:string};bing:{configured:boolean;client_id:string;redirect_uri:string}};
export type AnalyticsProvider='ga4'|'search'|'bing';
const services={
 ga4:{name:'Google Analytics',mark:'G4',tag:'AUDIENCE & TRAFFIC',description:'Visitors, referrers, locations, devices and website actions.',url:'https://analytics.google.com/',label:'GA4 property ID',placeholder:'123456789',api:'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com',steps:['Open Google Analytics → Admin → Property details. Copy the numeric property ID (not the G- measurement ID).','Enable the Google Analytics Data API in your Google Cloud project.','Create a service account and download its JSON key. In Analytics → Admin → Property access management, add its email with Viewer access.','Choose the key below, enter the property ID, then verify. The website must already have its GA4 tag installed.']},
 search:{name:'Search Console',mark:'SC',tag:'GOOGLE SEARCH',description:'Search keywords, clicks, impressions and landing pages.',url:'https://search.google.com/search-console',label:'Verified Search Console property',placeholder:'sc-domain:tsols.co.ke',api:'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com',steps:['Add and verify the website in Google Search Console.','Enable the Search Console API in your Google Cloud project.','Create a service account and download its JSON key. In Search Console → Settings → Users and permissions, add its email with access.','Copy the exact property: sc-domain:example.com for a domain property, or the full URL prefix. Upload the key and verify.']},
 bing:{name:'Bing Webmaster',mark:'B',tag:'BING SEARCH',description:'Bing keywords, search clicks and search visibility.',url:'https://www.bing.com/webmasters/',label:'Verified site URL',placeholder:'https://tsols.co.ke/',api:'',steps:['Open Bing Webmaster Tools and add or import your website. Complete ownership verification.','Open Settings → API Access → API Key. Generate or copy your API key.','Enter the exact verified site URL and API key below. Verification checks that the key can access this site.']}
};
export function AnalyticsConnections({connection,website,request,onSaved,reportErrors}:{connection:AnalyticsConnection|null;website:string;request:AnalyticsRequest;onSaved:()=>Promise<unknown>;reportErrors:Record<string,string>}){
 const allConnected=Boolean(connection?.ga4_property_id&&connection?.search_console_property&&connection?.bing_site_url);
 const [manageOpen,setManageOpen]=useState(false);
 const [selection,setSelection]=useState<AccountConnectionResult>();const [connecting,setConnecting]=useState('');const [accountMessage,setAccountMessage]=useState('');
 const [apps,setApps]=useState<OAuthStatus>();const [setupOpen,setSetupOpen]=useState(false);const [appError,setAppError]=useState('');
 async function loadApps(){try{const data=await request<OAuthStatus>({action:'oauth_status'});setApps(data);setAppError('');return data;}catch(e){setAppError(e instanceof Error?e.message:'OAuth settings could not load.');}}
 useEffect(()=>{let active=true;void loadApps().then(async settings=>{
  if(!settings)return;let changed=false,selectionShown=false;
  for(const provider of ['google','bing'] as const){
   const missing=provider==='google'?!connection?.ga4_property_id||!connection?.search_console_property:!connection?.bing_site_url;
   if(!settings[provider].configured||!missing)continue;
   try{const result=await request<AccountConnectionResult>({action:'oauth_reuse',provider,only_missing:true});if(!active)return;
    if(result.connected)changed=true;else if(result.needs_selection&&!selectionShown){setSelection(result);selectionShown=true;}
   }catch(e){if(active)setAppError(e instanceof Error?e.message:'Automatic website matching needs attention.');}
  }
  if(changed&&active){await onSaved();if(active)setAccountMessage('Saved agency access automatically connected the matching client websites.');}
 }).catch(e=>{if(active)setAppError(e instanceof Error?e.message:'Automatic connection could not finish.');});return()=>{active=false;};},[]);
 useEffect(()=>{if(allConnected){setManageOpen(false);setSetupOpen(false);setSelection(undefined);}},[allConnected]);
 function openSetup(){setSetupOpen(true);window.setTimeout(()=>document.getElementById('analytics-oauth-apps')?.scrollIntoView({behavior:'smooth',block:'start'}),0);}
 async function connectAccount(provider:string,forceConsent=false){
  if(connecting)return;const app=provider==='bing'?'bing':'google';if(!apps?.[app].configured){openSetup();return;}
  setConnecting(provider);setAppError('');setAccountMessage('');setSelection(undefined);
  try{await connectAnalyticsAccount(request,provider,setSelection,async()=>{await onSaved();setAccountMessage('Website connections matched and verified automatically.');},forceConsent);}
  catch(e){setAppError(e instanceof Error?e.message:'Could not connect this account.');}finally{setConnecting('');}
 }
 return <section className="analytics-connections" id="analytics-connections"><div className="analytics-section-heading"><div><span className="studio-eyebrow">YOUR DATA SOURCES</span><h2>Connections, independently verified</h2></div><div className="studio-actions">{allConnected&&<span className="status-pill active">All services connected</span>}<Button variant="outline" onClick={()=>{setManageOpen(!manageOpen);if(manageOpen)setSetupOpen(false);}}>{manageOpen?'Done':'Manage connections'}</Button></div></div>{(!allConnected||manageOpen)&&<div className="panel form-section automatic-analytics-connect"><div><h3>{allConnected?'Manage provider accounts':'Connect your analytics accounts'}</h3>{!allConnected&&<p className="muted">We discover accessible websites and match the client’s saved website automatically.</p>}</div><div className="studio-actions"><Button disabled={Boolean(connecting)} onClick={()=>void connectAccount('google')}>{connecting==='google'?'Finding Google websites…':'Connect Google'}</Button><Button variant="outline" disabled={Boolean(connecting)} onClick={()=>void connectAccount('bing')}>{connecting==='bing'?'Finding Bing websites…':'Connect Bing'}</Button></div><div className="studio-actions"><button className="text-link" disabled={Boolean(connecting)} onClick={()=>void connectAccount('google',true)}>Use another Google account</button><button className="text-link" disabled={Boolean(connecting)} onClick={()=>void connectAccount('bing',true)}>Use another Bing account</button></div>{accountMessage&&<p className="notice" role="status">{accountMessage}</p>}{appError&&<p className="notice error" role="alert">{appError}</p>}</div>}{selection&&<AnalyticsPropertyPicker key={selection.selection_id} result={selection} request={request} onComplete={async()=>{setSelection(undefined);await onSaved();setAccountMessage('Selected websites connected and verified.');}}/>}<div className="analytics-connection-grid">{(['ga4','search','bing'] as const).map(provider=><ConnectionCard key={provider} provider={provider} connection={connection} website={website} request={request} onSaved={onSaved} reportError={reportErrors[provider]} oauthReady={Boolean(apps?.[provider==='bing'?'bing':'google'].configured)} openOAuthSetup={openSetup} connectAccount={connectAccount} connecting={Boolean(connecting)} managing={manageOpen}/>)}</div>{(!allConnected||manageOpen||setupOpen)&&<section className="panel form-section oauth-app-settings" id="analytics-oauth-apps"><div className="analytics-section-heading"><div><span className="studio-eyebrow">ONE-TIME AGENCY SETUP</span><h2>OAuth applications</h2></div><Button variant="outline" onClick={()=>setSetupOpen(!setupOpen)}>{setupOpen?'Hide app settings':'Configure Google & Bing apps'}</Button></div><p className="muted">Register each provider app once for your agency. Client connections use separate consent and verified property access.</p>{appError&&<p className="notice error" role="alert">{appError}</p>}{setupOpen&&<div className="analytics-two-column">{(['google','bing'] as const).map(provider=><OAuthAppForm key={provider} provider={provider} settings={apps?.[provider]} request={request} onSaved={loadApps}/>)}</div>}</section>}</section>;
}
function ConnectionCard({provider,connection,website,request,onSaved,reportError,oauthReady,openOAuthSetup,connectAccount,connecting,managing}:{managing:boolean;connectAccount:(provider:string)=>Promise<void>;connecting:boolean;oauthReady:boolean;openOAuthSetup:()=>void;provider:AnalyticsProvider;connection:AnalyticsConnection|null;website:string;request:AnalyticsRequest;onSaved:()=>Promise<unknown>;reportError?:string}){
 const service=services[provider];
 const saved=provider==='ga4'?connection?.ga4_property_id:provider==='search'?connection?.search_console_property:connection?.bing_site_url;
 const verified=provider==='ga4'?connection?.ga4_verified_at??connection?.google_verified_at:provider==='search'?connection?.search_verified_at??connection?.google_verified_at:connection?.bing_verified_at;
 const oauthConnected=(provider==='ga4'?connection?.ga4_auth_method:provider==='search'?connection?.search_auth_method:connection?.bing_auth_method)==='oauth';
 const email=oauthConnected?null:provider==='ga4'?connection?.ga4_email??connection?.google_email:connection?.search_email??connection?.google_email;
 const [property,setProperty]=useState(saved??(provider==='bing'?website:''));
 const [file,setFile]=useState<File>(),[apiKey,setApiKey]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[version,setVersion]=useState(0);
 const [expanded,setExpanded]=useState(false);
 useEffect(()=>{setProperty(saved??(provider==='bing'?website:''));},[saved,website,provider]);
 async function perform(verifyOnly=false,event?:FormEvent){
  event?.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');
  try{
   let body:Record<string,unknown>={action:'verify',provider};
   if(!verifyOnly){
    body={action:provider==='ga4'?'save_ga4':provider==='search'?'save_search':'save_bing'};
    if(provider==='bing'){body.bing_site_url=property;body.api_key=apiKey;}
    else{
     body[provider==='ga4'?'ga4_property_id':'search_console_property']=property;
     if(file){if(file.size>20000)throw new Error('Choose a service-account JSON file under 20 KB.');try{body.credential=JSON.parse(await file.text());}catch{throw new Error('This file is not valid JSON.');}}
     else if(!saved)throw new Error('Choose the service-account JSON key file.');
    }
   }
   const result=await request(body);await onSaved();setMessage(result.message);setFile(undefined);setApiKey('');setVersion(v=>v+1);if(!verifyOnly)setExpanded(false);
  }catch(e){setError(e instanceof Error?e.message:'Connection could not be verified.');}finally{setBusy(false);}
 }
 return <article className={'panel analytics-connection '+provider}>
  <div className="connection-title"><span className="connection-mark">{service.mark}</span><span className={'status-pill '+(error||reportError?'paused':saved?'active':'')}>{error||reportError?'Needs attention':saved?'Connected':'Not connected'}</span></div>
  <span className="studio-eyebrow">{service.tag}</span><h3>{service.name}</h3><p>{service.description}</p>
  {saved?<div className="connection-identity"><strong>{saved}</strong><small>{oauthConnected?'OAuth · ':''}{verified?'Verified '+displayDate(verified):'Verify access below'}</small></div>:<div className="connection-identity"><strong>Waiting for connection</strong><small>No data requested from this service yet</small></div>}
  {error&&<p className="notice error" role="alert">{error}</p>}{!error&&reportError&&<p className="notice error" role="alert">{reportError}</p>}{message&&<p className="notice" role="status"><CheckCircle2 size={15}/> {message}</p>}
  {(!saved||managing||Boolean(error||reportError))&&<div className="connection-actions"><Button disabled={busy||connecting} onClick={()=>void connectAccount(provider)}><Link2 size={16}/> {oauthReady?'Connect with '+(provider==='bing'?'Bing':'Google'):'Set up OAuth'}</Button></div>}
  <div className="connection-actions"><Button variant={saved?'outline':'primary'} disabled={busy} onClick={()=>saved?void perform(true):setExpanded(true)}>{busy?<RefreshCw size={16}/>:saved?<CheckCircle2 size={16}/>:<Link2 size={16}/>} {busy?'Verifying…':saved?'Verify connection':'Use key connection'}</Button><a className="button button-outline" href={service.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/> Open service</a></div>
  {(!saved||managing)&&<details open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>{saved?'Change connection credentials':'Connection setup'}</summary>{!saved&&<ol>{service.steps.map(step=><li key={step}>{step}</li>)}</ol>}
   {!saved&&provider!=='bing'&&<div className="connection-setup-links"><a href={service.api} target="_blank" rel="noopener noreferrer">Enable this API <ExternalLink size={13}/></a><a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer">Create service account <ExternalLink size={13}/></a></div>}
   <form onSubmit={e=>void perform(false,e)}><fieldset disabled={busy}><label>{service.label}<input value={property} type={provider==='bing'?'url':'text'} inputMode={provider==='ga4'?'numeric':undefined} onChange={e=>setProperty(e.target.value)} placeholder={service.placeholder} required/></label>
   {provider==='bing'?<label>API key<input type="password" value={apiKey} autoComplete="off" onChange={e=>setApiKey(e.target.value)} required/></label>:<label>Service-account JSON key{saved&&<small>Leave empty to reuse this service’s saved key.</small>}<input key={version} type="file" accept=".json,application/json" onChange={e=>setFile(e.target.files?.[0])}/></label>}
   {provider!=='bing'&&email&&<small className="connection-email">{email}</small>}
   <Button type="submit" disabled={busy||!property||(provider==='bing'?!apiKey:!file&&!saved)}><KeyRound size={16}/> Verify & connect</Button></fieldset></form>
  </details>}
 </article>;
}

function OAuthAppForm({provider,settings,request,onSaved}:{provider:'google'|'bing';settings?:OAuthStatus['google'];request:AnalyticsRequest;onSaved:()=>Promise<unknown>}){
 const [clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>setClientId(settings?.client_id??''),[settings?.client_id]);
 const redirect=settings?.redirect_uri??window.location.origin+'/app/?analytics_oauth=1';
 async function save(e:FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');try{const r=await request({action:'oauth_app_save',oauth_provider:provider,oauth_client_id:clientId,oauth_client_secret:secret});setSecret('');await onSaved();setMessage(r.message);}catch(e){setError(e instanceof Error?e.message:'App settings could not be saved.');}finally{setBusy(false);}}
 return <form className="oauth-app-form" onSubmit={e=>void save(e)}><h3>{provider==='google'?'Google OAuth app':'Bing Webmaster OAuth app'}</h3><span className={'status-pill '+(settings?.configured?'active':'')}>{settings?.configured?'App configured':'App not configured'}</span>
 {!settings?.configured&&<><ol>{provider==='google'?<><li>Open Google Auth Platform. Configure Branding, Audience and Data Access. Enable the Analytics Data API, Analytics Admin API and Search Console API once for the agency.</li><li>Create a Web application client. Add the callback URL below as an Authorized redirect URI. While the app is in testing, add your Google account as a test user.</li></>:<><li>Open Bing Webmaster Tools → Settings → API Access → OAuth Client.</li><li>Register TSOLS Marketing OS and use the callback URL below. Copy the client ID and client secret.</li></>}</ol>
 <a className="text-link" href={provider==='google'?'https://console.cloud.google.com/auth/clients':'https://www.bing.com/webmasters/'} target="_blank" rel="noopener noreferrer">{provider==='google'?'Open Google app registration':'Open Bing app registration'} <ExternalLink size={14}/></a></>}
 <label>Callback URL<div className="oauth-callback-url"><code>{redirect}</code><Button type="button" variant="outline" onClick={()=>void navigator.clipboard.writeText(redirect).then(()=>setMessage('Callback URL copied.')).catch(()=>setError('Select and copy the callback URL above.'))}>Copy</Button></div></label>
 <fieldset disabled={busy}><label>Client ID<input autoComplete="off" value={clientId} onChange={e=>setClientId(e.target.value)} required maxLength={500}/></label><label>Client secret<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)} required maxLength={4000}/></label><Button type="submit" disabled={busy||!clientId.trim()||!secret.trim()}>{busy?'Saving app…':'Save OAuth app'}</Button></fieldset>
 <p className="muted">App secrets stay encrypted on the server. Changing app credentials may require clients to connect again.</p>{message&&<p className="notice" role="status">{message}</p>}{error&&<p className="notice error" role="alert">{error}</p>}</form>;
}
