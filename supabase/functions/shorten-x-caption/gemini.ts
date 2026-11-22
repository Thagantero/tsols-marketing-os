// These Flash-Lite models offer a free tier; the Google project's billing tier still applies.
const fallbackModels=['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash-lite'];
export const normalizeModel=(value:string|undefined)=>value?.trim().replace(/^models\//,'')||fallbackModels[0];
export async function generateCaption(key:string,configured:string|undefined,payload:Record<string,unknown>,request:typeof fetch=fetch){
 let model=normalizeModel(configured);
 if(!/^gemini-[a-z0-9.-]+$/.test(model))throw new Error('GEMINI_MODEL is invalid. Enter an API model ID, not its display name.');
 const headers={'x-goog-api-key':key,'Content-Type':'application/json'};
 const send=(name:string)=>request('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(name)+':generateContent',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
 const tried=[model];let response=await send(model);
 // Authentication, safety, quota and server errors must not trigger model switching.
 if(response.status!==404)return {response,model,tried};
 const available=new Set<string>();let pageToken:string|undefined;
 for(let page=0;page<3;page++){
  const url=new URL('https://generativelanguage.googleapis.com/v1beta/models');url.searchParams.set('pageSize','100');if(pageToken)url.searchParams.set('pageToken',pageToken);
  const listed=await request(url.href,{headers,signal:AbortSignal.timeout(10000)});
  if(!listed.ok)return {response:listed,model,tried};
  const body=await listed.json();
  for(const item of body.models??[])if(typeof item.name==='string'&&Array.isArray(item.supportedGenerationMethods)&&item.supportedGenerationMethods.includes('generateContent'))available.add(normalizeModel(item.name));
  pageToken=body.nextPageToken;if(!pageToken)break;
 }
 for(const candidate of fallbackModels){
  if(tried.includes(candidate)||!available.has(candidate))continue;
  tried.push(candidate);model=candidate;response=await send(model);
  if(response.status!==404)break;
 }
 return {response,model,tried};
}
