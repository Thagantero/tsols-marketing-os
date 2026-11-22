import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {trackedLink,gaRows} from '../../src/website-analytics-model.ts';
test('tracked links preserve destination parameters and identify saved organic posts',()=>{
 const link=new URL(trackedLink('https://tsols.co.ke/services?plan=a#enquire','LinkedIn','launch','saved-post-uuid'));
 assert.equal(link.searchParams.get('plan'),'a');assert.equal(link.hash,'#enquire');assert.equal(link.searchParams.get('utm_content'),'saved-post-uuid');assert.equal(link.searchParams.get('utm_medium'),'organic_social');assert.equal(link.searchParams.get('utm_source'),'linkedin');
 for(const url of ['javascript:alert(1)','http://example.com','https://user:pass@example.com'])assert.throws(()=>trackedLink(url,'x','c','p'));
});
test('empty analytics remains no data, while actual reported zeros remain zero',()=>{
 assert.deepEqual(gaRows({}),[]);assert.deepEqual(gaRows({metricHeaders:[{name:'sessions'}],rows:[{metricValues:[{value:'0'}]}]}),[{sessions:'0'}]);
});
const providerSource=await readFile(new URL('../functions/website-analytics/providers.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(providerSource.replace(/^import .*\n/,'').replace(/export /g,''));
function providers(fetch){const context={fetch,URL,Date,JSON,Number,Math,AbortSignal,Error};vm.createContext(context);vm.runInContext(code,context);return context;}
test('GA4 uses five reports, session scope and organic filter without summing unique users',async()=>{
 let body;const api=providers(async(url,opts)=>{assert.match(url,/analyticsdata.googleapis.com/);body=JSON.parse(opts.body);return Response.json({reports:[{},{},{},{},{}]});});
 await api.ga4('token','123','2026-11-01','2026-11-10');assert.equal(body.requests.length,5);assert.equal(body.requests[4].dimensionFilter.filter.stringFilter.value,'organic_social');assert.equal(body.requests[4].dimensions[0].name,'sessionManualAdContent');
});
test('Bing transport errors never expose the secret URL',async()=>{
 const api=providers(async()=>{throw new Error('request failed with apikey=PRIVATE');});await assert.rejects(()=>api.bingRequest('PRIVATE','GetUserSites'),error=>!error.message.includes('PRIVATE'));
});
test('Bing provider dates honor reporting date offsets',()=>{
 const api=providers(()=>{});assert.equal(api.bingDate('/Date(1316156400000-0700)/'),'2011-09-16');assert.equal(api.bingDate('not-a-date'),null);
});
const handlerSource=await readFile(new URL('../functions/website-analytics/index.ts',import.meta.url),'utf8');
const handlerCode=stripTypeScriptTypes(handlerSource.replace(/^import .*\n/gm,''));
async function call({authorized=true,user=true,action='status'}={}){
 let handler,secretReads=0;
 const chain=data=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data,error:null})});
 const context={Response,Set,JSON,Date,Number,Error,createClient:()=>({auth:{getUser:async()=>({data:{user:user?{id:'u'}:null},error:null})},from:name=>chain(name==='clients'?{agency_id:'agency',website:'https://tsols.co.ke',status:'active'}:name==='agency_memberships'?(authorized?{agency_id:'agency'}:null):null),rpc:()=>{secretReads++;throw new Error('unexpected credential read');}}),Deno:{env:{get:name=>({SUPABASE_URL:'project',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private'}[name])},serve:fn=>handler=fn}};
 vm.runInNewContext(handlerCode,context);
 const r=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer session'},body:JSON.stringify({client_id:'10000000-0000-4000-8000-000000000001',action,from:'2026-11-01',to:'2026-11-10'})}));return {status:r.status,data:await r.json(),secretReads};
}
test('agency admin authorization gates all access to server-side credentials',async()=>{
 for(const options of [{authorized:false},{user:false}]){const r=await call(options);assert.ok([401,403].includes(r.status));assert.equal(r.secretReads,0);}
 const r=await call();assert.equal(r.status,200);assert.equal(r.data.connection,null);assert.equal(r.secretReads,0);
});
test('unconnected providers yield no invented data',async()=>{const r=await call({action:'report'});assert.equal(r.status,200);assert.equal(r.data.ga4,undefined);assert.equal(r.data.search,undefined);assert.equal(r.data.bing,undefined);assert.equal(r.secretReads,0);});

test('multi-channel publishing attributes tagged links to their actual platform',async()=>{
 const {channelTracking}=await import('../functions/publish-post/tracking.ts');
 const text='Visit '+trackedLink('https://tsols.co.ke','instagram','launch','saved-post');
 const output=channelTracking(text,'saved-post','LinkedIn');assert.ok(output.includes('utm_source=linkedin'));assert.ok(output.includes('utm_content=saved-post'));
 assert.equal(channelTracking(text,'different-post','twitter'),text);assert.equal(channelTracking('Visit https://tsols.co.ke','saved-post','twitter'),'Visit https://tsols.co.ke');
});

async function independentRequest(input,{failGa=false,config={ga4_property_id:'111',search_console_property:'sc-domain:example.com',bing_site_url:'https://example.com/'}}={}){
 let handler;const calls=[];
 const chain=data=>({select(){return this;},eq(){return this;},update(values){calls.push(['update',values]);return this;},maybeSingle:async()=>({data,error:null})});
 const context={Response,Set,JSON,Date,Number,Error,String,
 createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'u'}},error:null})},from:name=>chain(name==='clients'?{agency_id:'agency',website:'https://example.com',status:'active'}:name==='agency_memberships'?{agency_id:'agency'}:config),rpc:async(name,args)=>{calls.push([name,args.provider,args.configuration]);return {data:name==='read_website_analytics_credential'?{client_email:args.provider,api_key:'fake-test'}:null,error:null};}}),
 googleKey:key=>key,googleToken:async(key,provider)=>{calls.push(['token',provider]);return 'token';},ga4:async()=>{calls.push(['ga4']);if(failGa)throw new Error('GA4 permission denied');return {summary:{rows:[]}};},searchConsole:async()=>{calls.push(['search']);return {summary:{rows:[]}};},bing:async()=>{calls.push(['bing']);return {queries:[]};},bingRequest:async()=>[{Url:'https://example.com/',IsVerified:true}],
 Deno:{env:{get:name=>({SUPABASE_URL:'project',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private'}[name])},serve:fn=>handler=fn}};
 vm.runInNewContext(handlerCode,context);
 const r=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer session'},body:JSON.stringify({client_id:'10000000-0000-4000-8000-000000000001',from:'2026-11-01',to:'2026-11-10',...input})}));return {status:r.status,data:await r.json(),calls};
}
test('GA4 and Search Console save and verify separately with isolated scopes',async()=>{
 for(const provider of ['ga4','search']){
  const r=await independentRequest({action:'save_'+provider,ga4_property_id:'222',search_console_property:'sc-domain:example.com',credential:{client_email:'test'}});
  assert.equal(r.status,200);assert.equal(r.calls.filter(c=>c[0]==='store_website_analytics_connection').length,1);assert.equal(r.calls.find(c=>c[0]==='store_website_analytics_connection')[1],provider);
  assert.equal(r.calls.some(c=>c[0]===(provider==='ga4'?'search':'ga4')),false);assert.deepEqual(r.calls.find(c=>c[0]==='token'),['token',provider]);
 }
});
test('stored connection can be verified without uploading another credential',async()=>{
 const r=await independentRequest({action:'verify',provider:'search'});assert.equal(r.status,200);assert.deepEqual(r.calls.find(c=>c[0]==='read_website_analytics_credential').slice(0,2),['read_website_analytics_credential','search']);assert.equal(r.calls.some(c=>c[0]==='ga4'),false);assert.ok(r.calls.some(c=>c[0]==='update'&&c[1].search_verified_at));
});
test('failed verification does not mark a connection verified',async()=>{const r=await independentRequest({action:'verify',provider:'ga4'},{failGa:true});assert.equal(r.status,400);assert.equal(r.calls.some(c=>c[0]==='update'||c[0]==='store_website_analytics_connection'),false);});
test('one failed report never blocks other connected services',async()=>{const r=await independentRequest({action:'report'},{failGa:true});assert.equal(r.status,200);assert.ok(r.data.errors.ga4);assert.ok(r.data.search);assert.ok(r.data.bing);assert.equal(r.data.ga4,undefined);});
test('unconnected service verification fails without reading secrets',async()=>{const r=await independentRequest({action:'verify',provider:'ga4'},{config:{}});assert.equal(r.status,409);assert.equal(r.calls.length,0);});
