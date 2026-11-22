import {createClient} from 'npm:@supabase/supabase-js@2.119.0';
import {handleOAuth,analyticsAccess} from './oauth-handler.ts';
import {googleKey,googleToken,ga4,searchConsole,bing,bingRequest} from './providers.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const validDay=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
Deno.serve(async request=>{
 const origin=request.headers.get('Origin');
 const origins=new Set(['https://os.tsols.co.ke','https://tsols-marketing-os.partedmars4.chatgpt.site',Deno.env.get('TSOLS_SITE_ORIGIN')].filter(Boolean));
 const headers={'Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin}:{})};
 const reply=(status:number,body:unknown)=>Response.json(body,{status,headers});
 if(origin&&!origins.has(origin))return reply(403,{message:'Origin unavailable.'});
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(request.method!=='POST')return reply(405,{message:'Use POST.'});
 const authorization=request.headers.get('Authorization');
 if(!authorization?.startsWith('Bearer '))return reply(401,{message:'Sign in again.'});
 try{
  const project=Deno.env.get('SUPABASE_URL'),anon=Deno.env.get('SUPABASE_ANON_KEY'),service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!project||!anon||!service)return reply(503,{message:'Website analytics is not configured.'});
  const db=createClient(project,anon,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const user=await db.auth.getUser(authorization.slice(7));if(user.error||!user.data.user)return reply(401,{message:'Sign in again.'});
  const raw=await request.text();if(raw.length>32000)return reply(413,{message:'The connection request is too large.'});
  let input;try{input=JSON.parse(raw);}catch{return reply(400,{message:'Invalid request.'});}
  if(!uuid(input?.client_id)||!['status','save_google','save_ga4','save_search','save_bing','verify','report','oauth_status','oauth_app_save','oauth_start','oauth_finish','oauth_reuse','oauth_choose'].includes(input.action))return reply(400,{message:'Choose a client and action.'});
  const client=await db.from('clients').select('id,agency_id,website,status').eq('id',input.client_id).maybeSingle();
  if(client.error||!client.data)return reply(403,{message:'This client is unavailable.'});
  const member=await db.from('agency_memberships').select('agency_id').eq('agency_id',client.data.agency_id).eq('user_id',user.data.user.id).eq('role','administrator').maybeSingle();
  if(member.error||!member.data)return reply(403,{message:'Agency administrator access is required.'});
  const admin=createClient(project,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const configResult=await db.from('website_analytics_connections').select('*').eq('client_id',input.client_id).maybeSingle();
  if(configResult.error)return reply(503,{message:'Could not load analytics connections.'});
  const config=configResult.data;
  if(input.action.startsWith('oauth_')){const r=await handleOAuth(input,{admin,client:{...client.data,analytics_connection:config},userId:user.data.user.id,origin:origin??'https://os.tsols.co.ke'});return reply(r.status,r.body);}
  if(input.action==='status')return reply(200,{connection:config,website:client.data.website,client_id:client.data.id});
  if(input.action.startsWith('save_')&&client.data.status==='archived')return reply(409,{message:'Restore this client before changing connections.'});
  const readSecret=async(provider:string)=>{
   const r=await admin.rpc('read_website_analytics_credential',{target_client:input.client_id,provider});
   if(r.error||!r.data)throw new Error('No saved credentials. Connect this service first.');return r.data;
  };
  const access=async(provider:'ga4'|'search'|'bing',key:any)=>(key.type==='oauth'||key.type==='oauth_grant')?await analyticsAccess(admin,client.data.agency_id,client.data.id,provider,key):null;
  const verifyProvider=async(provider:string,key:any,property:string)=>{
   if(provider==='bing'){
    const sites=await bingRequest((key.type==='oauth'||key.type==='oauth_grant')?{access_token:(await access('bing',key))!}:key.api_key,'GetUserSites');
    const normalize=(url:string)=>url.replace(/\/$/,'').toLowerCase();
    if(!sites.some((s:{Url?:string;IsVerified?:boolean})=>s.IsVerified===true&&typeof s.Url==='string'&&normalize(s.Url)===normalize(property)))throw new Error('This Bing key cannot access that verified site. Use the exact site URL shown in Bing.');
   }else{
    const token=(await access(provider==='ga4'?'ga4':'search',key))??await googleToken(googleKey(key),provider==='ga4'?'ga4':'search');
    if(provider==='ga4')await ga4(token,property,'7daysAgo','yesterday');
    else await searchConsole(token,property,new Date(Date.now()-7*86400000).toISOString().slice(0,10),new Date(Date.now()-86400000).toISOString().slice(0,10));
   }
  };
  if(input.action==='verify'){
   const provider=input.provider;
   if(!['ga4','search','bing'].includes(provider))return reply(400,{message:'Choose a service to verify.'});
   const property=provider==='ga4'?config?.ga4_property_id:provider==='search'?config?.search_console_property:config?.bing_site_url;
   if(!property)return reply(409,{message:'Connect this service before verifying it.'});
   try{await verifyProvider(provider,await readSecret(provider),property);}catch(e){return reply(400,{message:e instanceof Error?e.message:'Verification failed. Reconnect this service.'});}
   const field=provider==='ga4'?'ga4_verified_at':provider==='search'?'search_verified_at':'bing_verified_at';
   const checkedAt=new Date().toISOString();
   const saved=await admin.from('website_analytics_connections').update({[field]:checkedAt}).eq('client_id',input.client_id);
   if(saved.error)return reply(503,{message:'Access verified, but the verification time could not be saved. Try again.'});
   return reply(200,{message:'Read access verified successfully.',verifiedAt:checkedAt});
  }
  if(input.action==='save_ga4'||input.action==='save_search'){
   const provider=input.action==='save_ga4'?'ga4':'search';
   const property=String(provider==='ga4'?input.ga4_property_id??'':input.search_console_property??'').trim();
   if(provider==='ga4'?!/^\d{1,20}$/.test(property):!property||property.length>500||!(property.startsWith('sc-domain:')||/^https?:\/\//.test(property)))return reply(400,{message:provider==='ga4'?'Enter the numeric GA4 property ID, not the G- measurement ID.':'Enter the exact Search Console property (sc-domain:example.com or its URL prefix).'});
   let key;
   try{key=input.credential?googleKey(input.credential):await readSecret(provider);await verifyProvider(provider,key,property);if((key.type==='oauth'||key.type==='oauth_grant'))key=await readSecret(provider);}catch(e){return reply(400,{message:e instanceof Error?e.message:'Could not verify this Google service.'});}
   const saved=await admin.rpc('store_website_analytics_connection',{target_client:input.client_id,provider,credential:key,configuration:provider==='ga4'?{ga4_property_id:property}:{search_console_property:property}});
   if(saved.error)return reply(503,{message:'Access verified, but this connection could not be saved.'});
   return reply(200,{message:provider==='ga4'?'Google Analytics connected and verified.':'Search Console connected and verified.'});
  }
  if(input.action==='save_google'){
   const property=typeof input.ga4_property_id==='string'?input.ga4_property_id.trim():'';
   const site=typeof input.search_console_property==='string'?input.search_console_property.trim():'';
   if((property&&!/^\d{1,20}$/.test(property))||(!property&&!site)||site.length>500||site&&!(site.startsWith('sc-domain:')||/^https?:\/\//.test(site)))return reply(400,{message:'Enter a numeric GA4 property ID, a Search Console property, or both.'});
   let key;try{key=googleKey(input.credential);}catch{return reply(400,{message:'Upload a valid Google service-account JSON key.'});}
   let token;try{token=await googleToken(key);}catch{return reply(400,{message:'Google rejected this service-account key. Check that it is current and enabled.'});}
   try{if(property)await ga4(token,property,'7daysAgo','yesterday');if(site)await searchConsole(token,site,new Date(Date.now()-7*86400000).toISOString().slice(0,10),new Date(Date.now()-86400000).toISOString().slice(0,10));}catch(problem){return reply(400,{message:problem instanceof Error?problem.message:'Google could not verify access.'});}
   for(const provider of ['ga4','search']){
    if(provider==='ga4'?!property:!site)continue;
    const saved=await admin.rpc('store_website_analytics_connection',{target_client:input.client_id,provider,credential:key,configuration:provider==='ga4'?{ga4_property_id:property}:{search_console_property:site}});
    if(saved.error)return reply(503,{message:'Could not save the encrypted Google connection.'});
   }
   return reply(200,{message:'Google read access verified and connection saved.'});
  }
  if(input.action==='save_bing'){
   if(typeof input.bing_site_url!=='string'||input.bing_site_url.length>500||!/^https?:\/\//.test(input.bing_site_url)||typeof input.api_key!=='string'||input.api_key.length<10||input.api_key.length>1000)return reply(400,{message:'Enter the verified Bing site URL and API key.'});
   const site=input.bing_site_url.trim(),key=input.api_key.trim();
   let sites;try{sites=await bingRequest(key,'GetUserSites');}catch{return reply(400,{message:'Bing rejected this API key or could not list verified sites.'});}
   const normalize=(url:string)=>url.replace(/\/$/,'').toLowerCase();
   if(!sites.some((s:{Url?:string;IsVerified?:boolean})=>s.IsVerified===true&&typeof s.Url==='string'&&normalize(s.Url)===normalize(site)))return reply(400,{message:'This key does not have access to that verified Bing site. Use the exact site URL shown in Bing Webmaster Tools.'});
   const saved=await admin.rpc('store_website_analytics_connection',{target_client:input.client_id,provider:'bing',credential:{api_key:key},configuration:{bing_site_url:site}});
   if(saved.error)return reply(503,{message:'Could not save the encrypted Bing connection.'});
   return reply(200,{message:'Bing site access verified and connection saved.'});
  }
  if(!validDay(input.from)||!validDay(input.to)||input.from>input.to||(Date.parse(input.to)-Date.parse(input.from))/86400000>366||input.to>new Date().toISOString().slice(0,10))return reply(400,{message:'Choose a valid reporting range of up to 366 days ending today or earlier.'});
  const errors:Record<string,string>={};const output:Record<string,unknown>={};
  await Promise.all([
   (async()=>{if(config?.ga4_property_id)try{const key=await readSecret('ga4');const token=(await access('ga4',key))??await googleToken(googleKey(key),'ga4');output.ga4=await ga4(token,config.ga4_property_id,input.from,input.to);}catch(e){errors.ga4=e instanceof Error?e.message:'Could not fetch GA4.';}})(),
   (async()=>{if(config?.search_console_property)try{const key=await readSecret('search');const token=(await access('search',key))??await googleToken(googleKey(key),'search');output.search=await searchConsole(token,config.search_console_property,input.from,input.to);}catch(e){errors.search=e instanceof Error?e.message:'Could not fetch Search Console.';}})(),
   (async()=>{if(config?.bing_site_url)try{const key=await readSecret('bing');output.bing=await bing((key.type==='oauth'||key.type==='oauth_grant')?{access_token:(await access('bing',key))!}:key.api_key,config.bing_site_url,input.from,input.to);}catch(e){errors.bing=e instanceof Error?e.message:'Could not fetch Bing.';}})(),
  ]);
  return reply(200,{...output,errors,connection:config,website:client.data.website,from:input.from,to:input.to,fetchedAt:new Date().toISOString()});
 }catch{return reply(503,{message:'Website analytics could not finish. Please try again.'});}
});
