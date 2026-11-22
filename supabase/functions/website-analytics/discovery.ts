import {bingRequest} from './providers.ts';
import type {Service} from './oauth.ts';
export type PropertyOption={id:string;name:string;urls:string[]};
export type PropertyGroup={provider:Service;label:string;options:PropertyOption[];suggested:string|null;error?:string};
async function get(url:string,token:string){const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(18000)});const data=await response.json().catch(()=>null);if(!response.ok||data?.error)throw new Error(url.includes('analyticsadmin')?'Google could not list Analytics properties. Enable the Google Analytics Admin API once in your agency’s Google Cloud project and check account access.':'Google could not list Search Console websites. Check account permissions and that the Search Console API is enabled.');return data;}
export function matchedProperty(options:PropertyOption[],website:string){
 let host:string;try{host=new URL(website).hostname.toLowerCase().replace(/^www\./,'');}catch{return null;}
 const matches=options.filter(option=>option.urls.some(value=>{try{return (value.startsWith('sc-domain:')?value.slice(10):new URL(value).hostname).toLowerCase().replace(/^www\./,'')===host;}catch{return false;}}));
 return matches.length===1?matches[0].id:null;
}
export async function discoverProperties(service:Service,token:string,website:string):Promise<PropertyGroup>{
 const group:PropertyGroup={provider:service,label:service==='ga4'?'Google Analytics':service==='search'?'Search Console':'Bing Webmaster',options:[],suggested:null};
 let completeMatching=true;
 if(service==='ga4'){
  let page='';const seen=new Set<string>();
  do{const url=new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');url.searchParams.set('pageSize','200');if(page)url.searchParams.set('pageToken',page);const data=await get(url.href,token);
   for(const account of data.accountSummaries??[])for(const property of account.propertySummaries??[]){const id=String(property.property??'').replace(/^properties\//,'');if(/^\d+$/.test(id)&&!group.options.some(o=>o.id===id))group.options.push({id,name:property.displayName??'Analytics property '+id,urls:[]});}
   page=data.nextPageToken??'';if(page&&seen.has(page))throw new Error('Google property pagination did not finish. Try again.');seen.add(page);
  }while(page);
  // URI matching is optional; a failed stream lookup always falls back to an explicit choice.
  if(group.options.length<=40)for(let start=0;start<group.options.length;start+=8)await Promise.all(group.options.slice(start,start+8).map(async option=>{try{const data=await get('https://analyticsadmin.googleapis.com/v1beta/properties/'+option.id+'/dataStreams',token);if(data.nextPageToken)completeMatching=false;option.urls=(data.dataStreams??[]).map((s:any)=>s.webStreamData?.defaultUri).filter((s:unknown)=>typeof s==='string');}catch{completeMatching=false;}}));
 }else if(service==='search'){
  const data=await get('https://www.googleapis.com/webmasters/v3/sites',token);group.options=(data.siteEntry??[]).filter((s:any)=>s.permissionLevel!=='siteUnverifiedUser'&&typeof s.siteUrl==='string').map((s:any)=>({id:s.siteUrl,name:s.siteUrl.replace(/^sc-domain:/,''),urls:[s.siteUrl]}));
 }else{const sites=await bingRequest({access_token:token},'GetUserSites');group.options=sites.filter((s:any)=>s.IsVerified===true&&typeof s.Url==='string').map((s:any)=>({id:s.Url,name:s.Url,urls:[s.Url]}));}
 group.suggested=completeMatching?matchedProperty(group.options,website):null;return group;
}
