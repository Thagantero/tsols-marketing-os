import {discoverProperties,type PropertyGroup} from './discovery.ts';
import {appProvider,randomSecret,stateHash,tokenRequest,type Service} from './oauth.ts';
import {ga4,searchConsole,bingRequest} from './providers.ts';
export async function grantAccess(admin:any,agencyId:string,userId:string,provider:string,expectedId?:string){
 const read=async()=>{const r=await admin.rpc('read_analytics_oauth_grant',{target_agency:agencyId,target_user:userId,provider,grant_id:expectedId??null});if(r.error)throw new Error('Saved account authorization could not be loaded.');return r.data;};
 let grant=await read();if(!grant)return null;
 if(expectedId&&grant.grant_id!==expectedId)throw new Error('The connected account changed. Connect this client again.');
 if(Number(grant.expires_at)>Date.now()+60000)return grant;
 const app=await admin.rpc('read_analytics_oauth_app',{target_agency:agencyId,provider:provider==='bing'?'bing':'google'});if(app.error||!app.data)throw new Error('The agency OAuth app is not configured.');
 const fresh=await tokenRequest(provider==='google'?'ga4':provider as Service,app.data,{grant_type:'refresh_token',refresh_token:grant.refresh_token},grant);
 const updated={...grant,...fresh};const saved=await admin.rpc('store_analytics_oauth_grant',{target_agency:agencyId,target_user:userId,provider,credential:updated,expected_refresh:grant.refresh_token});
 if(saved.error)throw new Error('Account authorization could not be refreshed.');
 if(saved.data===false){grant=await read();if(!grant||grant.expires_at<=Date.now()+60000||expectedId&&grant.grant_id!==expectedId)throw new Error('Account authorization changed. Retry the connection.');return grant;}
 return updated;
}
async function saveChoices(admin:any,client:any,userId:string,grantProvider:string,grant:any,groups:PropertyGroup[],choices:Record<string,string>){
 const selected=groups.filter(g=>Boolean(choices[g.provider]));if(!selected.length)throw new Error('Choose at least one website or property.');
 for(const group of selected){const property=choices[group.provider];if(!group.options.some(option=>option.id===property))throw new Error('Choose a property returned by the connected account.');
  if(group.provider==='ga4')await ga4(grant.access_token,property,'7daysAgo','yesterday');
  else if(group.provider==='search')await searchConsole(grant.access_token,property,new Date(Date.now()-7*86400000).toISOString().slice(0,10),new Date(Date.now()-86400000).toISOString().slice(0,10));
  else{const sites=await bingRequest({access_token:grant.access_token},'GetUserSites');if(!sites.some((s:any)=>s.IsVerified===true&&s.Url===property))throw new Error('Bing site access could not be verified.');}
 }
 for(const group of selected){const property=choices[group.provider];const configuration=group.provider==='ga4'?{ga4_property_id:property}:group.provider==='search'?{search_console_property:property}:{bing_site_url:property};
  const saved=await admin.rpc('store_website_analytics_connection',{target_client:client.id,provider:group.provider,credential:{type:'oauth_grant',authorized_user:userId,agency_id:client.agency_id,grant_provider:grantProvider,grant_id:grant.grant_id},configuration});
  if(saved.error)throw new Error('Could not save every selected connection. Refresh analytics before retrying.');
 }
 return {connected:true,message:'Connected and verified '+selected.length+' analytics service'+(selected.length===1?'':'s')+'.'};
}
export async function prepareAccountConnection(admin:any,client:any,userId:string,provider:string,grant:any,onlyMissing=false){
 let services:Service[]=provider==='google'?['ga4','search']:[provider as Service];
 if(onlyMissing)services=services.filter(service=>!client.analytics_connection?.[service==='ga4'?'ga4_property_id':service==='search'?'search_console_property':'bing_site_url']);
 if(!services.length)return {connected:true,message:'Analytics services are already connected.'};
 const groups=await Promise.all(services.map(async service=>{try{return await discoverProperties(service,grant.access_token,client.website??'');}catch(e){return {provider:service,label:service==='ga4'?'Google Analytics':service==='search'?'Search Console':'Bing Webmaster',options:[],suggested:null,error:e instanceof Error?e.message:'Property discovery failed.'} as PropertyGroup;}}));
 if(groups.every(g=>Boolean(g.suggested))){return {...await saveChoices(admin,client,userId,provider,grant,groups,Object.fromEntries(groups.map(g=>[g.provider,g.suggested!]))),automatic:true};}
 const selection=randomSecret();const saved=await admin.rpc('issue_analytics_oauth_state',{state_hash:await stateHash(selection),target_user:userId,target_client:client.id,payload:{phase:'select',grant_provider:provider,grant_id:grant.grant_id,groups}});
 if(saved.error)throw new Error('Could not prepare website selection. Try connecting again.');
 return {needs_selection:true,selection_id:selection,groups,website:client.website??'',message:'Choose the website for this client. No property IDs or keys are required.'};
}
export async function chooseAccountProperties(input:any,admin:any,client:any,userId:string){
 if(typeof input.selection_id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.selection_id))throw new Error('This website selection expired. Connect again.');
 const r=await admin.rpc('consume_analytics_oauth_state',{state_hash:await stateHash(input.selection_id),target_user:userId,target_client:client.id});const state=r.data;
 if(r.error||state?.phase!=='select')throw new Error('This website selection expired or belongs to another account. Connect again.');
 const grant=await grantAccess(admin,client.agency_id,userId,state.grant_provider,state.grant_id);if(!grant)throw new Error('Authorize the provider account again.');
 return saveChoices(admin,client,userId,state.grant_provider,grant,state.groups,input.choices??{});
}
