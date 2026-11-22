import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const encoder=new TextEncoder();
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const stopWords=new Set(['stop','unsubscribe','opt out','opt-out','acha','sitaki','jiondoe','stop messages','stop messaging me','acha kunitumia ujumbe']);
const reply=(status:number,message:string)=>Response.json({message},{status,headers:{'Cache-Control':'no-store'}});

async function sameSecret(expected:string,actual:string) {
  const [left,right]=await Promise.all([expected,actual].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const a=new Uint8Array(left),b=new Uint8Array(right);
  let difference=0;
  for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
}

async function verifiedWebhook(secret:string,raw:string,signature:string) {
  if(!/^sha256=[0-9a-f]{64}$/.test(signature))return false;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.slice(7).match(/../g)??[],byte=>parseInt(byte,16));
  return crypto.subtle.verify('HMAC',key,bytes,encoder.encode(raw));
}

Deno.serve(async request=>{
  const url=new URL(request.url);
  if(request.method==='GET'){
    const configured=Deno.env.get('WHATSAPP_VERIFY_TOKEN');
    const token=url.searchParams.get('hub.verify_token')??'';
    const challenge=url.searchParams.get('hub.challenge')??'';
    if(configured&&url.searchParams.get('hub.mode')==='subscribe'&&/^\d{1,40}$/.test(challenge)&&await sameSecret(configured,token)){
      return new Response(challenge,{headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
    }
    return reply(403,'Webhook verification failed.');
  }
  if(request.method!=='POST')return reply(405,'Use POST.');
  const signature=request.headers.get('X-Hub-Signature-256');
  const workerToken=request.headers.get('X-TSOLS-Worker-Secret')??'';
  const workerSecret=Deno.env.get('WHATSAPP_WORKER_SECRET');
  const appSecret=Deno.env.get('WHATSAPP_APP_SECRET');
  let webhookBody:unknown;
  if(signature){
    if(!appSecret||Number(request.headers.get('Content-Length'))>200000)return reply(401,'Webhook authentication failed.');
    const raw=await request.text();
    if(raw.length>200000||!await verifiedWebhook(appSecret,raw,signature))return reply(401,'Webhook authentication failed.');
    try{webhookBody=JSON.parse(raw);}catch{return reply(400,'Invalid webhook body.');}
  } else if(!workerSecret||workerSecret.length<32||!workerToken||!await sameSecret(workerSecret,workerToken)){
    return reply(401,'Worker authentication failed.');
  }

  const project=Deno.env.get('SUPABASE_URL');
  const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const client=Deno.env.get('WHATSAPP_CLIENT_ID')??'';
  const sender=Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')??'';
  if(!project||!service||!uuid.test(client)||!/^\d{5,30}$/.test(sender))return reply(503,'WhatsApp sender is not configured.');
  const db=createClient(project,service,{auth:{persistSession:false,autoRefreshToken:false}});
  try{
    if(signature){
      const data=webhookBody as {entry?:{changes?:{value?:Record<string,unknown>}[]}[];object?:string}|null;
      if(data?.object!=='whatsapp_business_account'||!Array.isArray(data.entry))return reply(200,'Ignored.');
      for(const entry of data.entry){
        for(const item of entry.changes??[]){
          const value=item.value;
          if(!value||(value.metadata as {phone_number_id?:string})?.phone_number_id!==sender)continue;
          const statuses=Array.isArray(value.statuses)?value.statuses:[];
          for(const packet of statuses){
            if(typeof packet?.id!=='string'||!['sent','delivered','read','failed'].includes(packet.status))continue;
            const allowed:Record<string,string[]>={sent:['accepted'],delivered:['accepted','sent'],read:['accepted','sent','delivered'],failed:['accepted','sent']};
            const outcome=await db.from('whatsapp_messages').update({status:packet.status,
              reason:packet.status==='failed'?'provider_delivery_failed':null,updated_at:new Date().toISOString()})
              .eq('client_id',client).eq('provider_id',packet.id).in('status',allowed[packet.status]);
            if(outcome.error)return reply(503,'Could not record delivery update.');
          }
          const messages=Array.isArray(value.messages)?value.messages:[];
          for(const message of messages){
            if(typeof message?.id!=='string'||message.id.length>250||typeof message.from!=='string'||!/^\d{8,15}$/.test(message.from))continue;
            const text=typeof message.text?.body==='string'?message.text.body.trim().toLowerCase().replace(/[.!]+$/,''):'';
            const outcome=await db.rpc('record_whatsapp_reply',{
              sender_client:client,provider_event:message.id,phone_value:'+'+message.from,unsubscribe:stopWords.has(text),
            });
            if(outcome.error)return reply(503,'Could not record the reply.');
          }
        }
      }
      return reply(200,'Webhook accepted.');
    }

    const token=Deno.env.get('WHATSAPP_ACCESS_TOKEN');
    const version=Deno.env.get('WHATSAPP_GRAPH_VERSION')??'';
    const language=Deno.env.get('WHATSAPP_TEMPLATE_LANGUAGE')??'en';
    const templates:Record<string,string>={welcome:Deno.env.get('WHATSAPP_WELCOME_TEMPLATE')??'',follow_up:Deno.env.get('WHATSAPP_FOLLOW_UP_TEMPLATE')??''};
    if(!token||!/^v\d{2}\.\d+$/.test(version)||!templates.welcome||!templates.follow_up
      ||Object.values(templates).some(name=>!(/^[a-z0-9_]{1,100}$/).test(name))||!(/^[a-z]{2,3}(?:_[A-Z]{2})?$/).test(language)){
      return reply(503,'Configure the access token, Graph version, and two approved templates before starting.');
    }

    await db.from('whatsapp_messages').update({status:'unknown',reason:'unconfirmed',updated_at:new Date().toISOString()})
      .eq('client_id',client).eq('status','sending').lt('attempted_at',new Date(Date.now()-900000).toISOString());
    const jobs=await db.rpc('claim_whatsapp_jobs',{sender_client:client});
    if(jobs.error)return reply(503,'Could not reserve WhatsApp jobs.');
    await Promise.all((jobs.data??[]).map(async(job:{message_id:string;recipient:string;message_kind:string})=>{
      let status='skipped',reason:string|null='no_longer_eligible',providerId:string|null=null;
      try{
        const entry=await db.from('whatsapp_messages').select('lead_id').eq('id',job.message_id).eq('client_id',client).eq('status','sending').maybeSingle();
        if(entry.error||!entry.data)throw new Error('Claim no longer available.');
        const lead=await db.from('leads').select('id').eq('id',entry.data.lead_id).eq('client_id',client)
          .eq('consent_status','opted_in').eq('whatsapp_number',job.recipient).is('last_reply_at',null).not('status','in','(booked,won,lost)').maybeSingle();
        if(lead.error)throw new Error('Eligibility lookup failed.');
        if(lead.data){
          const request=await fetch('https://graph.facebook.com/'+version+'/'+sender+'/messages',{
            method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(12000),
            body:JSON.stringify({messaging_product:'whatsapp',to:job.recipient.slice(1),type:'template',
              template:{name:templates[job.message_kind],language:{code:language}}}),
          });
          const response=await request.json().catch(()=>null);
          if(request.ok&&typeof response?.messages?.[0]?.id==='string'){
            status='accepted';reason=null;providerId=response.messages[0].id;
          }else if(request.status>=400&&request.status<500){
            status='failed';reason='provider_rejected';
          }else{status='unknown';reason='unconfirmed';}
        }
      }catch{status='unknown';reason='unconfirmed';}
      const outcome=await db.from('whatsapp_messages').update({
        status,reason,provider_id:providerId,updated_at:new Date().toISOString(),
      }).eq('id',job.message_id).eq('client_id',client).eq('status','sending');
      if(outcome.error)console.warn('WhatsApp delivery outcome could not be recorded.');
    }));
    return Response.json({processed:jobs.data?.length??0},{headers:{'Cache-Control':'no-store'}});
  }catch{return reply(503,'WhatsApp processing could not finish.');}
});
