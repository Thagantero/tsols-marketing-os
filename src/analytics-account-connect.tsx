import {useState} from 'react';
import {Button} from './components/ui/button';
import type {AnalyticsRequest} from './analytics-connections';
export type AccountConnectionResult={connected?:boolean;requires_consent?:boolean;needs_selection?:boolean;selection_id?:string;website?:string;message?:string;groups?:Array<{provider:string;label:string;suggested:string|null;error?:string;options:Array<{id:string;name:string;urls:string[]}>}>};
export function AnalyticsPropertyPicker({result,request,onComplete}:{result:AccountConnectionResult;request:AnalyticsRequest;onComplete:()=>Promise<void>|void}){
 const [choices,setChoices]=useState<Record<string,string>>(()=>Object.fromEntries((result.groups??[]).map(g=>[g.provider,g.suggested??'']))),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(){setBusy(true);setError('');try{await request({action:'oauth_choose',selection_id:result.selection_id,choices});await onComplete();}catch(e){setError(e instanceof Error?e.message:'Could not connect selected websites.');}finally{setBusy(false);}}
 return <section className="panel form-section analytics-property-picker"><span className="studio-eyebrow">ACCOUNT AUTHORIZED</span><h2>Choose this client’s website</h2><p className="muted">{result.website?'Client website: '+result.website:'Select the property or website that belongs to this client.'}</p><p className="muted">No IDs, API keys or new app setup required.</p>{(result.groups??[]).map(group=><div className="analytics-property-choice" key={group.provider}><label>{group.label}<select value={choices[group.provider]??''} onChange={e=>setChoices(old=>({...old,[group.provider]:e.target.value}))} disabled={busy||!group.options.length}><option value="">{group.options.length?'Choose website or skip this service':'No accessible properties found'}</option>{group.options.map(option=><option key={option.id} value={option.id}>{option.name}{option.urls[0]&&!option.name.includes(option.urls[0])?' · '+option.urls[0]:''}</option>)}</select></label>{group.error&&<p className="notice error">{group.error}</p>}{group.provider==='ga4'&&group.error&&<a className="text-link" href="https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com" target="_blank" rel="noopener noreferrer">Enable Analytics Admin API once</a>}</div>)}{error&&<p className="notice error" role="alert">{error}</p>}<div className="form-actions"><Button disabled={busy||!Object.values(choices).some(Boolean)} onClick={()=>void save()}>{busy?'Verifying websites…':'Connect selected websites'}</Button></div></section>;
}
export async function connectAnalyticsAccount(request:AnalyticsRequest,provider:string,onSelection:(result:AccountConnectionResult)=>void,onComplete:()=>Promise<unknown>,forceConsent=false){
 const result=forceConsent?{requires_consent:true}:await request<AccountConnectionResult>({action:'oauth_reuse',provider});
 if(result.needs_selection){onSelection(result);return;}
 if(result.connected){await onComplete();return;}
 if(!result.requires_consent)throw new Error('Could not start this account connection.');
 const r=await request<{url:string;state:string;client_id:string}>({action:'oauth_start',provider});const target=new URL(r.url);
 if(target.protocol!=='https:'||!['accounts.google.com','www.bing.com'].includes(target.hostname))throw new Error('Invalid provider authorization URL.');
 sessionStorage.setItem('tsols-analytics-oauth:'+r.state,JSON.stringify({clientId:r.client_id,createdAt:Date.now()}));window.location.assign(r.url);
}
