import { JWT } from 'npm:google-auth-library@10.5.0';
export type GoogleKey={type:string;client_email:string;private_key:string};
export function googleKey(raw:unknown):GoogleKey {
  if(!raw||typeof raw!=='object')throw new Error('Choose a Google service-account JSON key file.');
  const key=raw as Record<string,unknown>;
  if(key.type!=='service_account'||typeof key.client_email!=='string'||!key.client_email.endsWith('.iam.gserviceaccount.com')||typeof key.private_key!=='string'||!key.private_key.startsWith('-----BEGIN PRIVATE KEY-----'))throw new Error('This is not a Google service-account JSON key.');
  return {type:'service_account',client_email:key.client_email,private_key:key.private_key};
}
export async function googleToken(key:GoogleKey,provider?:'ga4'|'search'){
  const auth=new JWT({email:key.client_email,key:key.private_key,scopes:provider==='ga4'?['https://www.googleapis.com/auth/analytics.readonly']:provider==='search'?['https://www.googleapis.com/auth/webmasters.readonly']:['https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/webmasters.readonly']});
  const token=await auth.authorize().catch(()=>{throw new Error('Google rejected this service-account key. Check that it is current and enabled.');});
  if(!token.access_token)throw new Error('Google could not authorize the service account.');
  return token.access_token;
}
async function googleRequest(url:string,token:string,body:unknown){
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(18000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.error)throw new Error(response.status===403?'Google denied access. Enable the API and grant the service account read access to this property.':response.status===429?'Google API quota reached. Try again later.':'Google could not return this report. Check the property and date range.');
  return data;
}
export function gaReport(from:string,to:string,dimensions:string[],metrics:string[],extra:Record<string,unknown>={}){
  return {dateRanges:[{startDate:from,endDate:to}],dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),limit:100, ...extra};
}
export async function ga4(token:string,property:string,from:string,to:string){
  const common=['sessions','totalUsers','keyEvents'];
  const reports=[gaReport(from,to,[],['totalUsers','sessions','screenPageViews','engagedSessions','keyEvents']),gaReport(from,to,['sessionSource','sessionMedium'],common),gaReport(from,to,['country','city'],['totalUsers','sessions']),gaReport(from,to,['deviceCategory'],['totalUsers','sessions']),gaReport(from,to,['sessionManualAdContent','sessionManualSource','sessionManualMedium','sessionManualCampaignName'],common,{dimensionFilter:{filter:{fieldName:'sessionManualMedium',stringFilter:{matchType:'EXACT',value:'organic_social'}}}})];
  // GA4 permits five reports per batch. All reports retain their own row counts and metadata.
  const batch=await googleRequest('https://analyticsdata.googleapis.com/v1beta/properties/'+property+':batchRunReports',token,{requests:reports});
  if(!Array.isArray(batch?.reports)||batch.reports.length!==5)throw new Error('Google returned an incomplete analytics report.');
  return {summary:batch.reports[0],sources:batch.reports[1],locations:batch.reports[2],devices:batch.reports[3],attribution:batch.reports[4]};
}
export async function searchConsole(token:string,site:string,from:string,to:string){
  const url='https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent(site)+'/searchAnalytics/query';
  const report=(dimensions:string[])=>googleRequest(url,token,{startDate:from,endDate:to,dimensions,type:'web',rowLimit:100,dataState:'final'});
  const [summary,queries,audience]=await Promise.all([report([]),report(['query','page']),report(['country','device'])]);
  return {summary,queries,audience};
}
export async function bingRequest(key:string|{access_token:string},method:'GetUserSites'|'GetQueryStats'|'GetRankAndTrafficStats',site?:string){
  const url=new URL((typeof key==='string'?'https://ssl.bing.com':'https://www.bing.com')+'/webmaster/api.svc/json/'+method);
  if(typeof key==='string')url.searchParams.set('apikey',key);if(site)url.searchParams.set('siteUrl',site);
  let response:Response;try{response=await fetch(url,{...(typeof key==='string'?{}:{headers:{Authorization:'Bearer '+key.access_token}}),signal:AbortSignal.timeout(18000)});}catch{throw new Error('Could not contact Bing Webmaster Tools. Please try again.');}const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ErrorCode||!Array.isArray(data?.d))throw new Error('Bing could not return this report. Check the API key and verified site URL.');
  return data.d;
}
export function bingDate(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const match=/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if(match){const offset=match[2]?Number(match[2].slice(0,3))*60+Math.sign(Number(match[2]))*Number(match[2].slice(3)):0;return new Date(Number(match[1])+offset*60000).toISOString().slice(0,10);}
  return /^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(0,10):null;
}
export async function bing(key:string|{access_token:string},site:string,from:string,to:string){
  const [queries,traffic]=await Promise.all([bingRequest(key,'GetQueryStats',site),bingRequest(key,'GetRankAndTrafficStats',site)]);
  const filter=(rows:Record<string,unknown>[])=>rows.filter(row=>{const date=bingDate(row.Date);return date&&date>=from&&date<=to;});
  return {queries:filter(queries),traffic:filter(traffic),excludedUndated:queries.filter((r:Record<string,unknown>)=>!bingDate(r.Date)).length+traffic.filter((r:Record<string,unknown>)=>!bingDate(r.Date)).length};
}
