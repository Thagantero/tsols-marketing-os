import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {metricValue,totalMetric,engagement,safePostLink} from '../../src/content-performance-model.ts';
const base={id:'p',text:'Real post',channelId:'c',sentAt:null,externalLink:null,metricsUpdatedAt:'2026-11-19T08:00:00Z'};
test('missing and unrefreshed metrics remain unavailable; provider zeros stay zero',()=>{
  assert.equal(metricValue({...base,metrics:null},'views'),null);
  assert.equal(metricValue({...base,metrics:[{type:'views',value:0}],metricsUpdatedAt:null},'views'),null);
  assert.equal(metricValue({...base,metrics:[{type:'views',value:0}]},'views'),0);
  assert.deepEqual(totalMetric([{...base,metrics:[{type:'views',value:12}]},{...base,metrics:[]}],'views'),{value:12,covered:1});
  assert.deepEqual(totalMetric([],'views'),{value:null,covered:0});
});
test('interactions avoid double-counting Facebook likes and exclude rates',()=>{
  assert.equal(engagement({...base,metrics:[{type:'reactions',value:10},{type:'likes',value:8},{type:'comments',value:2},{type:'engagementRate',value:50}]}),12);
  assert.equal(engagement({...base,metrics:[]}),null);
  assert.equal(safePostLink('javascript:alert(1)'),null);
});
const source=await readFile(new URL('../functions/content-performance/index.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*\n/gm,''));
async function invoke({user=true,client=true,after,body,providerError=false,responses}={}){
  let handler,called=0,query;
  const chain=(data)=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data,error:null}),then(resolve){return Promise.resolve({data,error:null}).then(resolve);}});
  const context={Response,Set,Date,JSON,Number,String,encodeURIComponent,AbortSignal,console:{warn(){}},createClient:()=>({auth:{getUser:async()=>({data:{user:user?{id:'u'}:null},error:null})},from:(name)=>chain(name==='clients'?(client?{id:'client',agency_id:'a8816370-4462-4741-8ac9-79d31b51f2af'}:null):[{id:'a',buffer_channel_id:'allowed',name:'My channel',platform:'instagram'}])}),Deno:{env:{get:name=>({SUPABASE_URL:'https://rexnutczviawkbpjanmt.supabase.co',SUPABASE_ANON_KEY:'public',BUFFER_API_KEY:'server-only'}[name])},serve:fn=>{handler=fn;}},fetch:async(_url,options)=>{called++;if(responses){query=JSON.parse(options.body).query;return responses(called,query);}query=JSON.parse(options.body).query;return Response.json(providerError?{errors:[{message:'denied'}]}:{data:{posts:{edges:[{node:{id:'real',channelId:'allowed',metrics:[{type:'views',value:12}]}},{node:{id:'other-client',channelId:'forbidden'}}],pageInfo:{hasNextPage:false,endCursor:null}}}});}};
  vm.runInNewContext(code,context);
  const response=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer session',Origin:'https://os.tsols.co.ke'},body:JSON.stringify(body??{client_id:'10000000-0000-4000-8000-000000000001',...(after?{after}:{})})}));
  return {status:response.status,data:await response.json(),called,query};
}
test('unavailable client and unauthenticated callers cannot reach Buffer',async()=>{
  for(const options of [{user:false},{client:false}]){const r=await invoke(options);assert.ok([401,403].includes(r.status));assert.equal(r.called,0);}
});
test('only mapped channel metrics are returned and pagination is quoted',async()=>{
  const r=await invoke({after:'cursor"value'});assert.equal(r.status,200);assert.equal(r.data.posts.length,1);assert.equal(r.data.posts[0].id,'real');assert.match(r.query,/channelIds:\["allowed"\]/);assert.ok(r.query.includes(JSON.stringify('cursor"value')));assert.ok(!JSON.stringify(r.data).includes('server-only'));
});
test('provider errors never turn into empty or zero-valued success',async()=>{
  const r=await invoke({providerError:true});assert.equal(r.status,502);assert.equal(r.data.posts,undefined);
});
test('unsupported metrics fall back to published posts without inventing metric values',async()=>{
 const r=await invoke({responses:(call,query)=>call===1?Response.json({errors:[{message:'Cannot query field "metrics" on type "Post".',extensions:{code:'GRAPHQL_VALIDATION_FAILED'}}]}):Response.json({data:{posts:{edges:[{node:{id:'real',text:'Saved post',channelId:'allowed',sentAt:'2026-11-20T12:00:00Z'}}],pageInfo:{hasNextPage:true,endCursor:'next'}}}})});
 assert.equal(r.status,200);assert.equal(r.called,2);assert.equal(r.data.diagnostic_code,'metrics_not_supported');assert.equal(r.data.posts[0].metrics,null);assert.equal(r.data.posts[0].metricsUpdatedAt,null);assert.equal(r.data.pageInfo.endCursor,'next');assert.match(r.data.warning,/does not expose/);assert.equal(r.query.includes('metrics {'),false);
});
test('partial GraphQL metric errors retain valid posts and actual supplied metrics',async()=>{
 const r=await invoke({responses:()=>Response.json({data:{posts:{edges:[{node:{id:'real',channelId:'allowed',metrics:[{type:'views',value:12}],metricsUpdatedAt:'2026-11-20T12:00:00Z'}}],pageInfo:{hasNextPage:false,endCursor:null}}},errors:[{message:'metrics unavailable',path:['posts','edges',1,'node','metrics']}]})});assert.equal(r.status,200);assert.equal(r.called,1);assert.equal(r.data.posts[0].metrics[0].value,12);assert.match(r.data.warning,/partial/);
});
test('authentication and rate-limit failures are not retried through metadata fallback',async()=>{
 for(const status of [401,429]){const r=await invoke({responses:()=>Response.json({errors:[{message:'rejected'}]},{status})});assert.equal(r.called,1);assert.equal(r.status,status===401?502:429);assert.equal(r.data.posts,undefined);}
});
test('a fallback cannot expose posts from channels assigned to another client',async()=>{const r=await invoke({responses:call=>call===1?Response.json({errors:[{message:'denied',extensions:{code:'FORBIDDEN'}}]}):Response.json({data:{posts:{edges:[{node:{id:'mine',channelId:'allowed'}},{node:{id:'other',channelId:'forbidden'}}],pageInfo:{hasNextPage:false,endCursor:null}}}})});assert.equal(r.data.posts.length,1);assert.equal(r.data.posts[0].id,'mine');assert.equal(JSON.stringify(r.data).includes('server-only'),false);});
test('read failures show the actual provider reason without exposing the saved credential',async()=>{const r=await invoke({responses:()=>Response.json({errors:[{message:'Missing permission posts:read; key server-only; Bearer secret-token; https://api.example/?key=server-only',extensions:{code:'FORBIDDEN'}}]})});assert.equal(r.status,502);assert.match(r.data.message,/posts:read/);assert.match(r.data.message,/separate API operation/);assert.equal(r.data.message.includes('server-only'),false);assert.equal(r.data.message.includes('secret-token'),false);assert.equal(r.data.message.includes('https://api.example'),false);});
