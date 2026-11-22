import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import twitterText from 'twitter-text';
import {generateCaption,normalizeModel} from '../functions/shorten-x-caption/gemini.ts';
const source=await readFile(new URL('../functions/shorten-x-caption/rewrite.ts',import.meta.url),'utf8');
const context={twitterText,RegExp};vm.createContext(context);vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*\n/,'').replace(/export /g,'')),context);
test('rewriting protects and restores exact tagged URLs',()=>{
 const link='https://tsols.co.ke/?utm_source=twitter&utm_medium=organic_social&utm_content=post-id';
 const input=context.protectedSource('Explore our services. '+link);assert.ok(input.source.includes('TSOLS_LINK_0'));assert.equal(input.links[0],link);
 const restored=context.restoreAndValidate('Explore our services: TSOLS_LINK_0',input.links);assert.ok(restored.caption.includes(link));assert.ok(restored.length<=280);
});
test('omitted, invented and oversized rewrite results are rejected',()=>{
 assert.ok(context.restoreAndValidate('No link',['https://tsols.co.ke']).error);
 assert.ok(context.restoreAndValidate('Go TSOLS_LINK_0 https://invented.example.com',['https://tsols.co.ke']).error);
 assert.ok(context.restoreAndValidate('a'.repeat(281),[]).error);
 assert.ok(context.restoreAndValidate('🚀'.repeat(141),[]).error);
 assert.ok(context.restoreAndValidate('Original message. Book a consultation.',[]).caption);
});
const handlerSource=await readFile(new URL('../functions/shorten-x-caption/index.ts',import.meta.url),'utf8');
const handlerCode=stripTypeScriptTypes(handlerSource.replace(/^import .*\n/gm,''));
async function generate({authorized=true,sourceChanged=false,existing=null,apiStatus=200,apiKey=true}={}){
 let handler,calls=0,saved=null,postReads=0;
 const row={id:'10000000-0000-4000-8000-000000000001',client_id:'client',revision:1,title:'Services',caption:'Explore our services. https://tsols.co.ke/',hashtags:'#Services',call_to_action:'Book a consultation.',updated_at:'2026-11-20T01:00:00Z'};
 const chain=data=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data,error:null})});
 const db={auth:{getUser:async()=>({data:{user:{id:'admin'}},error:null})},rpc:async()=>({data:true,error:null}),from:name=>{
  if(name==='content_calendar'){postReads++;return chain({...row,...(sourceChanged&&postReads>1?{updated_at:'changed'}:{})});}
  if(name==='clients')return chain({agency_id:'agency',status:'active'});
  if(name==='agency_memberships')return chain(authorized?{agency_id:'agency'}:null);
  if(name==='content_x_captions')return {...chain(existing),insert(value){saved=value;return chain({...value,status:'draft'});}};
  throw new Error('unexpected table');
 }};
 const sandbox={Response,Set,JSON,Number,AbortSignal,Error,protectedSource:context.protectedSource,restoreAndValidate:context.restoreAndValidate,createClient:()=>db,Deno:{env:{get:name=>({SUPABASE_URL:'project',SUPABASE_ANON_KEY:'anon',GEMINI_API_KEY:apiKey?'key':undefined}[name])},serve:fn=>handler=fn},fetch:async(_url,options)=>{
  calls++;if(apiStatus!==200)return Response.json({error:{message:'provider error'}},{status:apiStatus});const body=JSON.parse(options.body);assert.match(_url,/^https:\/\/generativelanguage.googleapis.com\//);assert.equal(options.headers['x-goog-api-key'],'key');assert.equal(body.generationConfig.responseMimeType,'application/json');assert.ok(body.systemInstruction.parts[0].text.includes('call to action'));
  const caption=calls===1?'a'.repeat(300):'Explore our services and book a consultation: TSOLS_LINK_0';
  return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({caption})}]},finishReason:'STOP'}]});
 }};
 sandbox.generateCaption=(key,model,body)=>generateCaption(key,model,body,sandbox.fetch);
 vm.runInNewContext(handlerCode,sandbox);
 const r=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({post_id:row.id,revision:1})}));
 return {status:r.status,body:await r.json(),calls,saved};
}
test('automatic rewriting retries invalid text and saves a draft without changing the full post',async()=>{
 const r=await generate();assert.equal(r.status,200);assert.equal(r.calls,2);assert.equal(r.body.variant.status,'draft');assert.ok(r.saved.caption.includes('https://tsols.co.ke/'));assert.ok(r.saved.caption.includes('book a consultation'));assert.ok(twitterText.parseTweet(r.saved.caption).valid);
});
test('unauthorized generation and source edits cannot save a short version',async()=>{
 const denied=await generate({authorized:false});assert.equal(denied.status,403);assert.equal(denied.calls,0);
 const stale=await generate({sourceChanged:true});assert.equal(stale.status,409);assert.equal(stale.saved,null);
});
test('already saved variants are reused without paid generation calls',async()=>{
 const r=await generate({existing:{caption:'Approved version',status:'approved'}});assert.equal(r.status,200);assert.equal(r.calls,0);assert.equal(r.body.variant.caption,'Approved version');
});


test('Gemini quota errors stop without paid fallback or saving substitute text',async()=>{
 const r=await generate({apiStatus:429});assert.equal(r.status,429);assert.equal(r.calls,1);assert.equal(r.saved,null);assert.match(r.body.message,/Gemini usage limit/);
});
test('missing Gemini key produces setup guidance without any provider call',async()=>{
 const r=await generate({apiKey:false});assert.equal(r.status,503);assert.equal(r.calls,0);assert.match(r.body.message,/GEMINI_API_KEY/);
});


test('unavailable model discovers a supported Flash-Lite model without exposing the key in URLs',async()=>{
 const calls=[];
 const request=async(url,options)=>{
  calls.push(url);assert.equal(options.headers['x-goog-api-key'],'secret-key');assert.ok(!url.includes('secret-key'));
  if(url.includes('/models?'))return Response.json({models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']},{name:'models/gemini-paid-pro',supportedGenerationMethods:['generateContent']}]});
  return url.includes('unavailable')?Response.json({error:{}},{status:404}):Response.json({candidates:[]});
 };
 const r=await generateCaption('secret-key','models/gemini-unavailable',{},request);assert.equal(r.response.status,200);assert.equal(r.model,'gemini-3.5-flash-lite');assert.equal(calls.length,3);
});
test('model discovery does not select unsupported or unlisted models',async()=>{
 let calls=0;
 const r=await generateCaption('key','gemini-missing',{},async(url)=>{calls++;return url.includes('/models?')?Response.json({models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['embedContent']},{name:'models/gemini-pro',supportedGenerationMethods:['generateContent']}]}):Response.json({},{status:404});});
 assert.equal(r.response.status,404);assert.equal(calls,2);
});
test('quota and auth errors do not trigger fallback or model discovery',async()=>{
 for(const status of [401,403,429]){let calls=0;const r=await generateCaption('key',undefined,{},async()=>{calls++;return Response.json({},{status});});assert.equal(r.response.status,status);assert.equal(calls,1);}
 assert.equal(normalizeModel(' models/gemini-3.5-flash-lite '),'gemini-3.5-flash-lite');
});
