import twitterText from 'npm:twitter-text@3.1.0';
import {isX,xCaptionCheck,isExplicitRejection} from './x-validation.ts';
import { channelTracking } from './tracking.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const site = Deno.env.get('TSOLS_SITE_ORIGIN') ?? 'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders = {
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
  'Cache-Control':'no-store',Vary:'Origin',
};
const uuid = (value:unknown):value is string => typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
type Channel = {id:string;name:string;displayName:string|null;service:string;isDisconnected:boolean};
const receiptFields='content_id,revision,account_id,client_id,status,external_post_id,due_at,provider_status,attempt_count,failure_code,status_checked_at,provider_sent_at';
const remoteStatuses=new Set(['draft','scheduled','sending','sent','error','needs_approval']);
const day=86400000;
const tsolsBufferDefaults={
  projectOrigin:'https://rexnutczviawkbpjanmt.supabase.co',
  agencyId:'a8816370-4462-4741-8ac9-79d31b51f2af',
  organizationId:'6afa0ae5b8d434e1d6df2d4f',
};

function bufferIds(project:string) {
  const isTsolsProject=new URL(project).origin===tsolsBufferDefaults.projectOrigin;
  return {
    agency:Deno.env.get('BUFFER_AGENCY_ID')?.trim()||(isTsolsProject?tsolsBufferDefaults.agencyId:undefined),
    organization:Deno.env.get('BUFFER_ORGANIZATION_ID')?.trim()||(isTsolsProject?tsolsBufferDefaults.organizationId:undefined),
  };
}

function bufferAuthenticationFailed(result:Awaited<ReturnType<typeof bufferApi>>) {
  return result.status===401||(Array.isArray(result.body?.errors)&&result.body.errors
    .some((error:{extensions?:{code?:string}})=>error?.extensions?.code==='UNAUTHENTICATED'));
}

async function bufferApi(key:string,query:string,variables?:Record<string,unknown>) {
  const response=await fetch('https://api.buffer.com',{
    method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000),
  });
  return {status:response.status,ok:response.ok,body:await response.json().catch(()=>null)};
}

async function readChannels(key:string,organization:string){
  const result=await bufferApi(key,'query { channels(input:{organizationId:'+JSON.stringify(organization)+'}) { id name displayName service isDisconnected } }');
  const channels=result.body?.data?.channels as Channel[]|undefined;
  if(bufferAuthenticationFailed(result))return {error:'Buffer rejected BUFFER_API_KEY. Replace it with a current API key from Buffer.'};
  if(!result.ok||!Array.isArray(channels))return {error:'Buffer did not return channels for this organization. Verify that the API key has access to it.'};
  return {channels:new Map(channels.filter(channel=>!channel.isDisconnected).map(channel=>[channel.id,channel]))};
}

Deno.serve(async request=>{
  const origin=request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const cors={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply = (status:number, body:Record<string, unknown>) => Response.json(body,{status,headers:cors});
  if(origin && !allowedOrigin)return reply(403,{message:'Origin unavailable.'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')return reply(405,{message:'Use POST.'});
  const auth=request.headers.get('Authorization');
  if(!auth?.startsWith('Bearer '))return reply(401,{message:'Sign in again.'});
  const project=Deno.env.get('SUPABASE_URL');
  const publicKey=Deno.env.get('SUPABASE_ANON_KEY');
  if(!project||!publicKey)return reply(503,{message:'Publishing function configuration is incomplete.'});
  try {
    const db=createClient(project,publicKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
    const identity=await db.auth.getUser(auth.slice(7));
    if(identity.error||!identity.data.user)return reply(401,{message:'Sign in again.'});
    const raw=await request.text();
    if(raw.length>4000)return reply(413,{message:'Publishing request is too large.'});
    let input;
    try{input=JSON.parse(raw);}catch{return reply(400,{message:'Invalid publishing request.'});}
    const {agency,organization}=bufferIds(project);
    if(input?.action==='organizations'){
      if(!uuid(input.agency_id))return reply(400,{message:'Choose an agency.'});
      const membership=await db.from('agency_memberships').select('agency_id')
        .eq('agency_id',input.agency_id).eq('user_id',identity.data.user.id)
        .eq('role','administrator').maybeSingle();
      if(membership.error||!membership.data)return reply(403,{message:'Agency administrator access is required.'});
      if(!agency)return reply(503,{message:'First save the displayed agency ID as BUFFER_AGENCY_ID in Supabase Secrets.'});
      if(agency!==membership.data.agency_id)return reply(403,{message:'Buffer is unavailable for this agency. Check BUFFER_AGENCY_ID in Supabase.'});
      const key=Deno.env.get('BUFFER_API_KEY')?.trim();
      if(!key)return reply(503,{message:'Save the Buffer API key as BUFFER_API_KEY in Supabase Secrets.'});
      const result=await bufferApi(key,'query GetOrganizations { account { organizations { id name } } }');
      const organizations=result.body?.data?.account?.organizations;
      if(bufferAuthenticationFailed(result)){
        return reply(502,{message:'Buffer rejected the saved API key. Replace BUFFER_API_KEY with a current key from Buffer.'});
      }
      if(!result.ok||!Array.isArray(organizations))return reply(502,{message:'Could not read organizations from Buffer. Check the key and try again.'});
      return reply(200,{organizations:organizations
        .filter((item:{id?:unknown;name?:unknown})=>typeof item?.id==='string'&&typeof item.name==='string')
        .map(({id,name}:{id:string;name:string})=>({id,name}))});
    }
    if(!uuid(input?.client_id)||!['channels','publish','schedule','sync','retry','cancel'].includes(input?.action)){
      return reply(400,{message:'Choose a client and action.'});
    }
    const client=await db.from('clients').select('id,agency_id').eq('id',input.client_id).maybeSingle();
    if(client.error||!client.data)return reply(403,{message:'This client is unavailable.'});
    if(!agency)return reply(503,{message:'Save the agency ID as BUFFER_AGENCY_ID in Supabase Secrets.'});
    if(agency!==client.data.agency_id)return reply(403,{message:'Buffer is unavailable for this agency.'});
    const bufferKey=Deno.env.get('BUFFER_API_KEY')?.trim();
    if(!bufferKey)return reply(503,{message:'The Buffer API key is missing. Save it as BUFFER_API_KEY in Supabase Edge Function Secrets.'});
    if(!organization)return reply(503,{message:'Save the Buffer organization ID as BUFFER_ORGANIZATION_ID in Supabase Secrets.'});

    if(input.action==='channels'){
      const result=await readChannels(bufferKey,organization);
      if(!result.channels)return reply(502,{message:result.error});
      return reply(200,{channels:[...result.channels.values()].map(channel=>({
        id:channel.id,name:channel.displayName||channel.name||channel.service,platform:channel.service,
      }))});
    }

    const accountIds:unknown=input.account_ids;
    if(!uuid(input.post_id)||!Number.isSafeInteger(input.revision)||input.revision<1||
      !Array.isArray(accountIds)||!accountIds.length||accountIds.length>8||!accountIds.every(uuid)
      ||new Set(accountIds).size!==accountIds.length)return reply(400,{message:'Choose one to eight distinct accounts and a saved revision.'});

    const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if(!serviceKey)return reply(503,{message:'Publishing receipts are unavailable.'});
    const receipts=createClient(project,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const deliveryKey={content_id:input.post_id,client_id:input.client_id,revision:input.revision};
    const readDeliveries=()=>db.from('publishing_deliveries').select(receiptFields).match(deliveryKey).in('account_id',accountIds);

    if(input.action==='sync'||input.action==='cancel'){
      const current=await readDeliveries();
      if(current.error)return reply(500,{message:'Could not read delivery results.'});
      if(input.action==='cancel'&&accountIds.length!==1)return reply(400,{message:'Cancel one destination at a time.'});
      const candidates=current.data.filter(row=>row.external_post_id&&row.status==='submitted'&&row.provider_status!=='cancelled');
      if(!candidates.length)return reply(409,{message:'No Buffer receipt is available for those destinations.'});
      const aliases=candidates.map((row,index)=>'r'+index+': post(input:{id:'+JSON.stringify(row.external_post_id)+'}) { id status dueAt sentAt }');
      const result=await bufferApi(bufferKey,'query ReadDeliveries { '+aliases.join(' ')+' }');
      if(!result.ok||!result.body?.data)return reply(502,{message:'Could not refresh the posts in Buffer.'});
      let count=0;
      for(const [index,row] of candidates.entries()){
        const currentPost=result.body.data['r'+index];
        if(currentPost?.id!==row.external_post_id||!remoteStatuses.has(currentPost.status))continue;
        const match={...deliveryKey,account_id:row.account_id,external_post_id:row.external_post_id};
        if(input.action==='cancel'){
          const due=Date.parse(currentPost.dueAt);
          if(!row.due_at||currentPost.status!=='scheduled'||!Number.isFinite(due)||due<Date.now()+180000){
            return reply(409,{message:'Buffer no longer reports a safely cancellable schedule. Check it in Buffer.'});
          }
          const deletion=await bufferApi(bufferKey,'mutation CancelSchedule($input:DeletePostInput!) { deletePost(input:$input) { __typename ... on DeletePostSuccess { id } } }',
            {input:{id:row.external_post_id}});
          if(!deletion.ok||deletion.body?.data?.deletePost?.id!==row.external_post_id){
            return reply(502,{message:'Buffer did not confirm cancellation. Check the schedule in Buffer.'});
          }
        }
        const saved=await receipts.from('publishing_deliveries').update({
          provider_status:input.action==='cancel'?'cancelled':currentPost.status,
          status_checked_at:new Date().toISOString(),failure_code:currentPost.status==='error'?'provider_error':null,
          ...(currentPost.status==='sent'&&typeof currentPost.sentAt==='string'&&Number.isFinite(Date.parse(currentPost.sentAt))
            ? {provider_sent_at:new Date(currentPost.sentAt).toISOString()} : {}),
        }).match(match).or('provider_status.is.null,provider_status.neq.cancelled');
        if(saved.error)return reply(500,{message:'Could not update the delivery. Check Buffer before retrying.'});
        count++;
      }
      if(!count)return reply(409,{message:'Buffer did not return the selected status. Check the post directly in Buffer.'});
      const refreshed=await readDeliveries();
      if(refreshed.error)return reply(500,{message:'Could not reload updated delivery results.'});
      return reply(200,{deliveries:refreshed.data});
    }

    const result=await readChannels(bufferKey,organization);
    if(!result.channels)return reply(502,{message:result.error});
    const live=result.channels;
    const [post,accounts]=await Promise.all([
      db.from('content_calendar').select('id,client_id,revision,status,caption,hashtags,call_to_action,media_asset_id,scheduled_at,schedule_cancelled_at,content_origin,clients!inner(status)')
        .eq('id',input.post_id).eq('client_id',input.client_id).eq('revision',input.revision).eq('status','approved').neq('clients.status','archived').maybeSingle(),
      db.from('publishing_accounts').select('id,buffer_channel_id,name,platform').eq('client_id',input.client_id).eq('active',true).in('id',accountIds),
    ]);
    if(post.error||!post.data)return reply(409,{message:'Save a ready or approved revision before publishing.'});
    if(accounts.error||accounts.data?.length!==accountIds.length)return reply(400,{message:'One or more selected accounts are unavailable to this client.'});
    if(accounts.data.some(account=>!live.has(account.buffer_channel_id)))return reply(409,{message:'At least one selected account is disconnected in Buffer.'});
    const record=post.data;
    const scheduled=input.action==='schedule'||(input.action==='retry'&&input.scheduled===true);
    const due=scheduled?record.scheduled_at:null;
    const dueTime=due?Date.parse(due):0;
    if(scheduled&&(!due||!Number.isFinite(dueTime)||record.schedule_cancelled_at||dueTime<Date.now()+120000)){
      return reply(409,{message:'Save an active calendar plan at least two minutes in the future first.'});
    }
    if(input.action==='schedule'&&input.expected_due_at!==undefined
      &&(typeof input.expected_due_at!=='string'||Date.parse(input.expected_due_at)!==dueTime)){
      return reply(409,{message:'The saved publishing time changed. Reopen the post and confirm the new time.'});
    }
    if(due&&record.media_asset_id&&dueTime>Date.now()+7*day){
      return reply(400,{message:'Schedule posts with private media up to seven days ahead.'});
    }
    const caption=[record.caption,record.hashtags,record.call_to_action].map(value=>value.trim()).filter(Boolean).join('\n\n');
    let xCaption=caption;
    let usesXVariant=false;
    if(accounts.data.some(account=>isX(live.get(account.buffer_channel_id)!.service))){
      const variant=await db.from('content_x_captions').select('caption,status').eq('content_id',record.id).eq('revision',record.revision).maybeSingle();
      if(variant.error)return reply(503,{message:'Could not read the X-specific caption. Reopen the post and try again.'});
      if(variant.data?.status==='approved'){xCaption=variant.data.caption;usesXVariant=true;}
    }
    // Validate the actual outgoing text before signing media or reserving any delivery.
    for(const account of accounts.data){
      const channel=live.get(account.buffer_channel_id)!;
      if(isX(channel.service)){
        const check=xCaptionCheck(channelTracking(xCaption,record.id,channel.service),twitterText,input.x_character_limit,Boolean(record.media_asset_id));
        if(!check.valid)return reply(400,{message:check.message});
      }
    }
    let assets:Record<string,unknown>[]=[];
    let isVideo=false;
    if(record.media_asset_id){
      const media=await db.from('media_assets').select('object_path,mime_type').eq('id',record.media_asset_id).eq('client_id',input.client_id).maybeSingle();
      if(media.error||!media.data)return reply(409,{message:'The selected media is unavailable.'});
      const expires=due?Math.ceil((dueTime+day-Date.now())/1000):3600;
      const {data,error}=await db.storage.from('tsols-media').createSignedUrl(media.data.object_path,expires);
      if(error||!data?.signedUrl)return reply(500,{message:'Could not create the temporary media link for Buffer.'});
      isVideo=media.data.mime_type==='video/mp4';
      assets=isVideo?[{video:{url:data.signedUrl}}]:[{image:{url:data.signedUrl}}];
    }
    const configured=accounts.data.map(account=>({account,channel:live.get(account.buffer_channel_id)!}));
    for(const {channel} of configured){
      if(channel.service.toLowerCase()==='instagram'&&!assets.length)return reply(400,{message:'Instagram requires an image or a video.'});
      if(channel.service.toLowerCase()==='tiktok'&&!isVideo)return reply(400,{message:'TikTok publishing currently requires an MP4 video.'});
    }
    let fresh:Set<string>;
    if(input.action==='retry'){
      if(accountIds.length!==1)return reply(400,{message:'Retry one rejected destination at a time.'});
      let retry=receipts.from('publishing_deliveries').update({
        status:'sending',attempt_count:2,failure_code:null,
      }).match({...deliveryKey,account_id:accountIds[0],status:'rejected',attempt_count:1}).is('external_post_id',null);
      retry=due?retry.eq('due_at',due):retry.is('due_at',null);
      const claimed=await retry.select('account_id');
      if(claimed.error||claimed.data.length!==1)return reply(409,{message:'This delivery is no longer eligible for retry. Check its result and calendar plan.'});
      fresh=new Set([claimed.data[0].account_id]);
    }else{
      const claimed=await receipts.from('publishing_deliveries').upsert(accounts.data.map(account=>({
        ...deliveryKey,account_id:account.id,due_at:due,
      })),{onConflict:'content_id,revision,account_id',ignoreDuplicates:true}).select('account_id');
      if(claimed.error)return reply(409,{message:'Could not reserve delivery. Refresh the post and check that its revision and plan are current.'});
      fresh=new Set(claimed.data.map(row=>row.account_id));
    }
    await Promise.all(configured.filter(({account})=>fresh.has(account.id)).map(async ({account,channel})=>{
      let status='unknown';
      let externalId:string|null=null;
      let providerStatus:string|null=null;
      let failure='unconfirmed';
      let sentAt:string|null=null;
      try {
        const result=await bufferApi(bufferKey,'mutation SendPost($input:CreatePostInput!) { createPost(input:$input) { __typename ... on PostActionSuccess { post { id status sentAt } } ... on MutationError { message } } }',{
          input:{
            channelId:account.buffer_channel_id,text:channelTracking(isX(channel.service)?xCaption:caption,record.id,channel.service),schedulingType:'automatic',
            mode:due?'customScheduled':'shareNow',...(due?{dueAt:due}:{}),assets,aiAssisted:record.content_origin==='ai'||isX(channel.service)&&usesXVariant,
            ...(channel.service.toLowerCase()==='instagram'?{metadata:{instagram:{type:isVideo?'reel':'post',shouldShareToFeed:true}}}:{}),
          },
        });
        const outcome=result.body?.data?.createPost;
        if(typeof outcome?.post?.id==='string'){
          status='submitted';externalId=outcome.post.id;
          providerStatus=remoteStatuses.has(outcome.post.status)?outcome.post.status:null;
          failure=providerStatus==='error'?'provider_error':'';
          if(providerStatus==='sent'&&typeof outcome.post.sentAt==='string'&&Number.isFinite(Date.parse(outcome.post.sentAt))){
            sentAt=new Date(outcome.post.sentAt).toISOString();
          }
        }else if(isExplicitRejection(outcome)||[400,401,403,404,429].includes(result.status)){
          status='rejected';
          failure=result.status===429?'rate_limited':[401,403].includes(result.status)?'connection':'request_rejected';
        }
      }catch{ /* A timeout may occur after Buffer accepts a post. Leave it for reconciliation. */ }
      const saved=await receipts.from('publishing_deliveries').update({
        status,external_post_id:externalId,provider_status:providerStatus,provider_sent_at:sentAt,failure_code:failure||null,status_checked_at:providerStatus?new Date().toISOString():null,
      }).match({...deliveryKey,account_id:account.id,status:'sending'});
      if(saved.error)console.warn('Publishing receipt update failed');
    }));
    const results=await readDeliveries();
    if(results.error)return reply(503,{message:'Could not read delivery results. Refresh before sending again.'});
    return reply(200,{deliveries:results.data});
  }catch{return reply(502,{message:'The publishing request could not finish. Check account delivery results before trying again.'});}
});
