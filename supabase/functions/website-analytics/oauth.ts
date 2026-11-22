export type Service='ga4'|'search'|'bing';
export type OAuthApp={client_id:string;client_secret:string;redirect_uri:string};
export type OAuthToken={type:'oauth';access_token:string;refresh_token:string;expires_at:number;client_email?:string};
export const scopes={google:'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly',ga4:'https://www.googleapis.com/auth/analytics.readonly',search:'https://www.googleapis.com/auth/webmasters.readonly',bing:'webmaster.read'};
export const appProvider=(service:Service|'google')=>service==='bing'?'bing':'google';
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const randomSecret=()=>encode(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value:string){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
export async function stateHash(value:string){return Array.from(await digest(value),b=>b.toString(16).padStart(2,'0')).join('');}
export async function authorizationUrl(service:Service|'google',app:OAuthApp,state:string,verifier:string){
 const url=new URL(service==='bing'?'https://www.bing.com/webmasters/oauth/authorize':'https://accounts.google.com/o/oauth2/v2/auth');
 for(const [key,value] of Object.entries({client_id:app.client_id,redirect_uri:app.redirect_uri,response_type:'code',scope:scopes[service],state}))url.searchParams.set(key,value);
 if(service!=='bing'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','select_account consent');url.searchParams.set('code_challenge_method','S256');url.searchParams.set('code_challenge',encode(await digest(verifier)));}
 return url.href;
}
export async function tokenRequest(service:Service|'google',app:OAuthApp,fields:Record<string,string>,previous?:OAuthToken):Promise<OAuthToken>{
 let response:Response;
 try{response=await fetch(service==='bing'?'https://www.bing.com/webmasters/oauth/token':'https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:app.client_id,client_secret:app.client_secret,...fields}),signal:AbortSignal.timeout(18000)});}catch{throw new Error('Could not contact the authorization service. Try connecting again.');}
 const data=await response.json().catch(()=>null);
 if(!response.ok||typeof data?.access_token!=='string')throw new Error(data?.error==='invalid_client'?'The OAuth app credentials were rejected. Check the client ID and secret.':'Authorization expired or was rejected. Connect this service again.');
 const refresh=typeof data.refresh_token==='string'?data.refresh_token:previous?.refresh_token;
 if(!refresh)throw new Error('Offline access was not granted. Reconnect and allow the requested permissions.');
 const expires=Number(data.expires_in);
 return {type:'oauth',access_token:data.access_token,refresh_token:refresh,expires_at:Date.now()+(Number.isFinite(expires)&&expires>0?expires:3600)*1000,...(previous?.client_email?{client_email:previous.client_email}:{})};
}
export function validProperty(service:Service,value:unknown):value is string{
 if(typeof value!=='string'||value.length>500)return false;
 if(service==='ga4')return /^\d{1,20}$/.test(value);
 if(service==='search'&&/^sc-domain:[a-z0-9.-]+$/i.test(value))return true;
 try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}
