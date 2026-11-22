import {grantAccess,prepareAccountConnection,chooseAccountProperties} from './account-connect.ts';
import {authorizationUrl,randomSecret,stateHash,tokenRequest,validProperty,appProvider,type Service,type OAuthApp,type OAuthToken} from './oauth.ts';
import {ga4,searchConsole,bingRequest} from './providers.ts';
export async function handleOAuth(input:any,context:{admin:any;client:any;userId:string;origin:string}){
 const {admin,client,userId,origin}=context;
 const reply=(status:number,body:unknown)=>({status,body});
 const readApp=async(provider:string):Promise<OAuthApp|null>=>{const r=await admin.rpc('read_analytics_oauth_app',{target_agency:client.agency_id,provider});if(r.error)throw new Error('OAuth app settings could not be loaded.');return r.data;};
 if(input.action==='oauth_status'){
  const [google,bing]=await Promise.all([readApp('google'),readApp('bing')]);
  const metadata=(app:OAuthApp|null)=>({configured:Boolean(app),client_id:app?.client_id??'',redirect_uri:app?.redirect_uri??origin+'/app/?analytics_oauth=1'});
  return reply(200,{google:metadata(google),bing:metadata(bing)});
 }
 if(client.status==='archived')return reply(409,{message:'Restore this client before connecting analytics.'});
 if(input.action==='oauth_app_save'){
  if(!['google','bing'].includes(input.oauth_provider)||typeof input.oauth_client_id!=='string'||!input.oauth_client_id.trim()||input.oauth_client_id.length>500||typeof input.oauth_client_secret!=='string'||!input.oauth_client_secret.trim()||input.oauth_client_secret.length>4000)return reply(400,{message:'Enter the provider-issued client ID and client secret.'});
  const r=await admin.rpc('store_analytics_oauth_app',{target_agency:client.agency_id,provider:input.oauth_provider,credential:{client_id:input.oauth_client_id.trim(),client_secret:input.oauth_client_secret.trim(),redirect_uri:origin+'/app/?analytics_oauth=1'}});
  if(r.error)return reply(503,{message:'Could not save the encrypted OAuth app credentials.'});
  return reply(200,{message:'OAuth app saved. Connect a service to verify provider authorization.'});
 }
 if(input.action==='oauth_reuse'){
  const provider=input.provider;if(!['google','ga4','search','bing'].includes(provider))return reply(400,{message:'Choose a provider.'});
  let selectedProvider=provider,grant;
  try{grant=await grantAccess(admin,client.agency_id,userId,provider);if(!grant&&['ga4','search'].includes(provider)){selectedProvider='google';grant=await grantAccess(admin,client.agency_id,userId,'google');}}catch{return reply(200,{requires_consent:true});}
  if(!grant)return reply(200,{requires_consent:true});
  try{return reply(200,await prepareAccountConnection(admin,client,userId,selectedProvider,grant,input.only_missing===true));}catch(e){return reply(400,{message:e instanceof Error?e.message:'Could not find this account’s websites.'});}
 }
 if(input.action==='oauth_choose'){
  try{return reply(200,await chooseAccountProperties(input,admin,client,userId));}catch(e){return reply(400,{message:e instanceof Error?e.message:'Could not connect selected properties.'});}
 }
 if(input.action==='oauth_start'){
  const service=input.provider as Service|'google';
  if(!['google','ga4','search','bing'].includes(service)||(input.property&&(!['ga4','search','bing'].includes(service)||!validProperty(service as Service,input.property))))return reply(400,{message:'Enter the property ID or verified site before connecting.'});
  const app=await readApp(appProvider(service));if(!app)return reply(409,{message:'Configure the OAuth app below before connecting.'});
  if(new URL(app.redirect_uri).origin!==origin)return reply(409,{message:'Open TSOLS at '+new URL(app.redirect_uri).origin+' to use this OAuth app.'});
  const state=randomSecret(),verifier=randomSecret();
  const saved=await admin.rpc('issue_analytics_oauth_state',{state_hash:await stateHash(state),target_user:userId,target_client:client.id,payload:{service,property:input.property,verifier,redirect_uri:app.redirect_uri,app_client_id:app.client_id}});
  if(saved.error)return reply(429,{message:'Could not start another connection. Wait a moment and retry.'});
  return reply(200,{url:await authorizationUrl(service,app,state,verifier),state,client_id:client.id});
 }
 if(input.action==='oauth_finish'){
  if(typeof input.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.state)||typeof input.code!=='string'||!input.code||input.code.length>4096)return reply(400,{message:'The authorization response is incomplete. Start the connection again.'});
  const consumed=await admin.rpc('consume_analytics_oauth_state',{state_hash:await stateHash(input.state),target_user:userId,target_client:client.id});
  const state=consumed.data;
  if(consumed.error||!state)return reply(409,{message:'This connection request expired, was already used, or belongs to another account. Start again.'});
  const service=state.service as Service|'google';
  if(!['google','ga4','search','bing'].includes(service))return reply(400,{message:'Invalid service.'});
  const app=await readApp(appProvider(service));
  if(!app||app.client_id!==state.app_client_id||app.redirect_uri!==state.redirect_uri||new URL(app.redirect_uri).origin!==origin)return reply(409,{message:'OAuth app settings changed. Start the connection again.'});
  try{
   const token=await tokenRequest(service,app,{grant_type:'authorization_code',code:input.code,redirect_uri:app.redirect_uri,...(service!=='bing'?{code_verifier:state.verifier}:{})});
   if(!state.property){
    const grant={...token,grant_id:randomSecret()};
    const saved=await admin.rpc('store_analytics_oauth_grant',{target_agency:client.agency_id,target_user:userId,provider:service,credential:grant});
    if(saved.error)return reply(503,{message:'Could not save this account authorization. Try connecting again.'});
    return reply(200,{...await prepareAccountConnection(admin,client,userId,service,grant),client_id:client.id});
   }
   // Verify actual property access before replacing any existing connection.
   if(service==='ga4')await ga4(token.access_token,state.property,'7daysAgo','yesterday');
   else if(service==='search')await searchConsole(token.access_token,state.property,new Date(Date.now()-7*86400000).toISOString().slice(0,10),new Date(Date.now()-86400000).toISOString().slice(0,10));
   else{const sites=await bingRequest({access_token:token.access_token},'GetUserSites');const normalize=(s:string)=>s.replace(/\/$/,'').toLowerCase();if(!sites.some((s:any)=>s.IsVerified===true&&typeof s.Url==='string'&&normalize(s.Url)===normalize(state.property)))throw new Error('This Bing account cannot access the selected verified site.');}
   const config=service==='ga4'?{ga4_property_id:state.property}:service==='search'?{search_console_property:state.property}:{bing_site_url:state.property};
   const saved=await admin.rpc('store_website_analytics_connection',{target_client:client.id,provider:service,credential:token,configuration:config});
   if(saved.error)return reply(503,{message:'Provider access was verified, but the connection could not be saved. Connect again.'});
   return reply(200,{message:'OAuth connected and property access verified.',client_id:client.id,provider:service});
  }catch(e){return reply(400,{message:e instanceof Error?e.message:'Could not complete the connection. Try again.'});}
 }
 return reply(400,{message:'Unknown OAuth action.'});
}
export async function analyticsAccess(admin:any,agencyId:string,clientId:string,service:Service,credential:any){
 if(credential.type==='oauth_grant'){if(credential.agency_id!==agencyId)throw new Error('This account connection belongs to another agency.');const grant=await grantAccess(admin,agencyId,credential.authorized_user,credential.grant_provider,credential.grant_id);if(!grant)throw new Error('The connected account needs authorization.');return grant.access_token;}
 if(credential.type!=='oauth')return null;
 if(credential.access_token&&Number(credential.expires_at)>Date.now()+60000)return String(credential.access_token);
 const result=await admin.rpc('read_analytics_oauth_app',{target_agency:agencyId,provider:appProvider(service)});
 if(result.error||!result.data)throw new Error('The OAuth app is missing. Configure it and reconnect this service.');
 const token=await tokenRequest(service,result.data,{grant_type:'refresh_token',refresh_token:credential.refresh_token},credential as OAuthToken);
 const saved=await admin.rpc('rotate_website_analytics_token',{target_client:clientId,provider:service,expected_refresh:credential.refresh_token,new_token:token});
 if(saved.error)throw new Error('Could not save refreshed authorization. Reconnect this service.');
 if(saved.data===false){const latest=await admin.rpc('read_website_analytics_credential',{target_client:clientId,provider:service});if(latest.data?.access_token&&latest.data.expires_at>Date.now()+60000)return latest.data.access_token;throw new Error('Authorization changed. Refresh the report again.');}
 return token.access_token;
}
