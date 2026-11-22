import {createClient} from 'npm:@supabase/supabase-js@2.119.0';

const site=Deno.env.get('TSOLS_SITE_ORIGIN')??'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const projectClient='f91d40c1-547a-4626-8f96-fc527fa9c486';
const page='103605634352615';
const graph='https://graph.facebook.com/v27.0/';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const postId=/^[0-9]+(?:_[0-9]+)?$/;
const responseHeaders={
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Cache-Control':'no-store',Vary:'Origin'};
const env=(name:string)=>Deno.env.get(name)?.trim()??'';
const auth={persistSession:false,autoRefreshToken:false};

Deno.serve(async request=>{
  const origin=request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const headers={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply=(status:number,message:string,extra={})=>Response.json({message,...extra},{status,headers});
  if(origin && !allowedOrigin)return reply(403,'Origin unavailable.');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply(405,'Use POST.');
  const authorization=request.headers.get('Authorization');
  if(!authorization?.startsWith('Bearer '))return reply(401,'Sign in again.');
  try{
    const project=env('SUPABASE_URL'),key=env('SUPABASE_ANON_KEY');
    const db=createClient(project,key,{auth,global:{headers:{Authorization:authorization}}});
    const identity=await db.auth.getUser(authorization.slice(7));
    if(identity.error||!identity.data.user)return reply(401,'Sign in again.');
    const raw=await request.text();
    if(raw.length>1000)return reply(413,'Request too large.');
    let input;
    try{input=JSON.parse(raw);}catch{return reply(400,'Invalid request.');}
    if(input?.client_id!==projectClient||!['verify','publish'].includes(input?.action))return reply(400,'Choose the Facebook destination.');
    const allowed=await db.from('clients').select('id').eq('id',projectClient)
      .eq('agency_id','a8816370-4462-4741-8ac9-79d31b51f2af').neq('status','archived').maybeSingle();
    if(allowed.error||!allowed.data)return reply(403,'This Page is unavailable for your workspace.');
    const token=env('META_FACEBOOK_PAGE_ACCESS_TOKEN');
    if(!token)return reply(503,'Save the Page token as META_FACEBOOK_PAGE_ACCESS_TOKEN in Supabase Edge Function Secrets.');
    const metaHeaders={Authorization:'Bearer '+token};
    const verified=await fetch(graph+'me?fields=id,name',{headers:metaHeaders,signal:AbortSignal.timeout(10000)});
    const profile=await verified.json().catch(()=>null);
    if(!verified.ok||profile?.id!==page)return reply(409,'Meta did not verify the saved token for THAGANA SOLUTIONS. Check its Page ID, validity and permissions.');
    if(input.action==='verify')return reply(200,'Meta verified the token for THAGANA SOLUTIONS.');
    if(input.confirmed!==true||typeof input.post_id!=='string'||!uuid.test(input.post_id)
      ||!Number.isSafeInteger(input.revision)||input.revision<1)return reply(400,'Confirm an approved saved revision before publishing.');
    const workerKey=env('SUPABASE_SERVICE_ROLE_KEY');
    if(!workerKey)return reply(503,'Facebook delivery is unavailable.');
    const worker=createClient(project,workerKey,{auth});

    const lookup=await db.from('content_calendar').select('caption,hashtags,call_to_action,media_asset_id')
      .eq('id',input.post_id).eq('client_id',projectClient).eq('revision',input.revision).eq('status','approved').maybeSingle();
    if(lookup.error||!lookup.data)return reply(409,'Save a ready or approved revision first.');
    const snapshot=lookup.data;
    const caption=[snapshot.caption,snapshot.hashtags,snapshot.call_to_action].map(value=>value.trim()).filter(Boolean).join('\n\n');
    let image:Blob|undefined;
    let type='';
    if(snapshot.media_asset_id){
      const asset=await db.from('media_assets').select('object_path,mime_type').eq('client_id',projectClient)
        .eq('id',snapshot.media_asset_id).maybeSingle();
      if(asset.error||!asset.data)return reply(409,'The saved attachment is unavailable.');
      type=asset.data.mime_type;
      if(!['image/jpeg','image/png'].includes(type))return reply(400,'Direct Facebook supports JPEG and PNG images. Use Buffer for this attachment.');
      const download=await db.storage.from('tsols-media').download(asset.data.object_path);
      if(download.error||!download.data||download.data.size>8388608)return reply(409,'Could not prepare this image for Facebook.');
      image=download.data;
    }
    if(!caption&&!image)return reply(400,'Add a caption or a supported image before publishing.');
    const reserved=await worker.rpc('claim_facebook_delivery',{content:input.post_id,expected_revision:input.revision,actor:identity.data.user.id});
    if(reserved.error||!reserved.data)return reply(409,'This revision is unavailable or has a Facebook delivery already. Check its receipt before trying again.');
    const receipt={content_id:input.post_id,revision:input.revision,page_id:page,status:'sending'};
    if(reserved.data.media_asset_id!==snapshot.media_asset_id||reserved.data.caption!==snapshot.caption
      ||reserved.data.hashtags!==snapshot.hashtags||reserved.data.call_to_action!==snapshot.call_to_action){
      await worker.from('facebook_page_deliveries').update({status:'rejected'}).match(receipt);
      return reply(409,'The saved content changed. Open the latest revision before posting.');
    }

    let status='unknown',externalId:string|null=null;
    try{
      const form=new FormData();
      if(caption)form.set('message',caption);
      if(image)form.set('source',image,type==='image/png'?'post.png':'post.jpg');
      const sent=await fetch(graph+page+(image?'/photos':'/feed'),{
        method:'POST',headers:metaHeaders,body:form,signal:AbortSignal.timeout(35000),
      });
      const result=await sent.json().catch(()=>null);
      const candidate=result?.post_id??result?.id;
      if(sent.ok&&typeof candidate==='string'&&postId.test(candidate)){status='published';externalId=candidate;}
      else if([400,401,403,404,429].includes(sent.status)&&result?.error)status='rejected';
    }catch{ /* A timeout can occur after Meta receives the request. */ }
    const save=await worker.from('facebook_page_deliveries').update({
      status,provider_post_id:externalId,sent_at:status==='published'?new Date().toISOString():null,
    }).match(receipt).select('status').maybeSingle();
    if(save.error||!save.data||status==='unknown')return reply(502,'Delivery is unconfirmed. Check the Facebook Page before creating another post.');
    if(status==='rejected')return reply(422,'Meta rejected the request. Check the Page token permissions and attachment.');
    return reply(200,'Facebook confirmed publication.',{post_id:externalId});
  }catch{return reply(502,'Could not complete the Facebook request. Check the receipt and Page before trying again.');}
});
