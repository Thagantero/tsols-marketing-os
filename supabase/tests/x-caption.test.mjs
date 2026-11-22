import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import twitterText from 'twitter-text';
import {xCaptionCheck,isX,isExplicitRejection} from '../functions/publish-post/x-validation.ts';
import {channelTracking} from '../functions/publish-post/tracking.ts';
test('X limits count whole combined text including separators, links and emoji',()=>{
 assert.equal(xCaptionCheck('a'.repeat(280),twitterText).valid,true);
 assert.equal(xCaptionCheck('a'.repeat(281),twitterText).over,1);
 assert.equal(xCaptionCheck('a'.repeat(275)+'\n\n#tag',twitterText).valid,false);
 assert.equal(xCaptionCheck('https://example.com/'+ 'a'.repeat(120),twitterText).length,23);
 assert.equal(xCaptionCheck('👨‍👩‍👧',twitterText).length,2);
 assert.equal(xCaptionCheck('🚀'.repeat(141),twitterText).valid,false);
 assert.equal(xCaptionCheck('a'.repeat(300),twitterText,25000).valid,true);
 assert.equal(xCaptionCheck('a'.repeat(300),twitterText,99999).valid,false);
 assert.equal(xCaptionCheck('',twitterText,280,true).valid,true);assert.equal(xCaptionCheck('',twitterText).valid,false);
 assert.equal(isX('Twitter'),true);assert.equal(isX('linkedin'),false);
});
test('typed mutation errors are explicit rejections, transport ambiguity stays unknown',()=>{
 assert.equal(isExplicitRejection({__typename:'PostTextTooLongError',message:'too long'}),true);
 assert.equal(isExplicitRejection(null),false);assert.equal(isExplicitRejection({errors:['timeout']}),false);
});
const source=await readFile(new URL('../functions/publish-post/index.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*\n/gm,''));
const client='10000000-0000-4000-8000-000000000001',post='10000000-0000-4000-8000-000000000002',account='10000000-0000-4000-8000-000000000003';
async function invoke(caption,platform='twitter',variant=null){
 let handler,writes=0,publishes=0;
 const chain=data=>({select(){return this;},eq(){return this;},neq(){return this;},in(){return this;},maybeSingle:async()=>({data,error:null}),then(resolve){return Promise.resolve({data,error:null}).then(resolve);}});
 const context={Response,Set,Map,JSON,Date,Number,URL,AbortSignal,console,twitterText,isX,xCaptionCheck,isExplicitRejection,channelTracking,createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'u'}},error:null})},from:name=>{
 if(name==='clients')return chain({id:client,agency_id:'a8816370-4462-4741-8ac9-79d31b51f2af'});
 if(name==='content_calendar')return chain({id:post,caption,hashtags:'',call_to_action:'',scheduled_at:null,media_asset_id:null});
 if(name==='content_x_captions')return chain(variant);
 if(name==='publishing_accounts')return chain([{id:account,buffer_channel_id:'channel',platform}]);
 return {upsert(){writes++;throw new Error('stop before live write');}};
 }}),Deno:{env:{get:name=>({SUPABASE_URL:'https://rexnutczviawkbpjanmt.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service',BUFFER_API_KEY:'buffer'}[name])},serve:fn=>handler=fn},fetch:async(_url,opts)=>{const query=JSON.parse(opts.body).query;if(query.includes('createPost'))publishes++;return Response.json({data:{channels:[{id:'channel',service:platform,name:'channel',isDisconnected:false}]}});}};
 vm.runInNewContext(code,context);
 const result=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({action:'publish',client_id:client,post_id:post,revision:1,account_ids:[account]})}));
 return {status:result.status,body:await result.json(),writes,publishes};
}
test('oversized X posts fail before delivery reservations or provider mutations',async()=>{
 const r=await invoke('a'.repeat(873));assert.equal(r.status,400);assert.match(r.body.message,/873.*280/);assert.equal(r.writes,0);assert.equal(r.publishes,0);
});
test('a long LinkedIn post is not blocked by the X limit',async()=>{
 const r=await invoke('a'.repeat(873),'linkedin');assert.equal(r.writes,1);assert.doesNotMatch(r.body.message??'',/weighted characters/);
});


test('only approved X variants replace overlong full captions during preflight',async()=>{
 const approved=await invoke('a'.repeat(873),'twitter',{caption:'Short approved message. Book now.',status:'approved'});
 assert.equal(approved.writes,1);
 const draft=await invoke('a'.repeat(873),'twitter',{caption:'Short unreviewed message.',status:'draft'});
 assert.equal(draft.status,400);assert.equal(draft.writes,0);
});
