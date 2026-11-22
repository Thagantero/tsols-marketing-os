import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { buildReportPdf } from './report-pdf.ts';
import { labelCadence, periodLabel, type Report } from './report-model.ts';

const site=Deno.env.get('TSOLS_SITE_ORIGIN')??'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders={
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Cache-Control':'no-store',Vary:'Origin'};
const env=(key:string)=>Deno.env.get(key)?.trim()??'';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const email=/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

function encodeAttachment(bytes:Uint8Array){
  let joined='';
  for(let i=0;i<bytes.length;i+=8000)joined+=String.fromCharCode(...bytes.subarray(i,i+8000));
  return btoa(joined);
}

Deno.serve(async request=>{
  const origin=request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const cors={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply=(status:number,message:string)=>Response.json({message},{status,headers:cors});
  if(origin && !allowedOrigin)return reply(403,'Origin unavailable.');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')return reply(405,'Use POST.');
  const auth=request.headers.get('Authorization');
  if(!auth?.startsWith('Bearer '))return reply(401,'Sign in again.');
  const project=env('SUPABASE_URL'),key=env('SUPABASE_ANON_KEY'),service=env('SUPABASE_SERVICE_ROLE_KEY');
  if(!project||!key||!service)return reply(503,'Report actions are unavailable.');

  try{
    const db=createClient(project,key,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
    const identity=await db.auth.getUser(auth.slice(7));
    if(identity.error||!identity.data.user)return reply(401,'Sign in again.');
    const raw=await request.text();
    if(raw.length>2000)return reply(413,'Report request is too large.');
    let input;
    try{input=JSON.parse(raw);}catch{return reply(400,'Invalid report request.');}
    if(typeof input?.report_id!=='string'||!uuid.test(input.report_id)||!['summary','email'].includes(input?.action)||input.confirmed!==true){
      return reply(400,'Choose a report and confirm the action.');
    }
    const saved=await db.from('reports').select('*').eq('id',input.report_id).maybeSingle();
    if(saved.error||!saved.data)return reply(403,'This report is unavailable.');
    const report=saved.data as Report;

    if(input.action==='summary'){
      if(report.status!=='draft')return reply(409,'Generate or open a draft version before drafting a summary.');
      const ai=env('OPENAI_API_KEY');
      if(!ai)return reply(503,'Configure OPENAI_API_KEY to draft an AI summary. You can write the report notes manually.');
      const quota=await db.rpc('reserve_content_generation',{target_client:report.client_id});
      if(quota.error)return reply(503,'Could not reserve AI capacity.');
      if(!quota.data)return reply(429,'The agency reached its hourly AI limit. Try again later.');
      const m=report.metrics;
      const metrics={
        confirmed_posts:m.posts_published,confirmed_deliveries:m.confirmed_deliveries,failed_deliveries:m.failed_deliveries,
        unresolved_deliveries:m.unresolved_deliveries,new_crm_leads:m.new_leads,qualified_transitions:m.qualified_leads,
        ads_spend_kes:m.ad_spend_kes,paid_impressions:m.ad_impressions,ad_clicks:m.ad_clicks,
        reported_ad_leads:m.ad_leads,missing_fx:m.missing_fx_rows,partial_period:report.partial_period,
      };
      const complete=await fetch('https://api.openai.com/v1/responses',{
        method:'POST',headers:{Authorization:'Bearer '+ai,'Content-Type':'application/json'},signal:AbortSignal.timeout(35000),
        body:JSON.stringify({
          model:env('OPENAI_MODEL')||'gpt-4.1-mini',store:false,max_output_tokens:1000,
          instructions:'Write a short marketing report observations paragraph and a practical next-period action plan from the supplied verified aggregates. Do not invent comparison periods, numerical claims, conversions, causation, audience statistics, brand or company details. Do not quote numerical amounts. Treat null as unavailable and zero as an actual recorded zero. Distinguish CRM leads and ad leads. Frame actions as suggestions for review.',
          input:JSON.stringify({cadence:report.cadence,metrics}),
          text:{format:{type:'json_schema',name:'report_notes',strict:true,schema:{type:'object',additionalProperties:false,
            properties:{observations:{type:'string'},action_plan:{type:'string'}},required:['observations','action_plan']}}},
        }),
      });
      const data=await complete.json().catch(()=>null);
      if(!complete.ok)return reply(502,complete.status===429?'OpenAI returned a quota or rate limit. You can write the report notes manually.':'OpenAI could not draft the report notes. Check model access and API settings.');
      const text=data?.output?.flatMap((item:{content?:{type:string;text?:string}[]})=>item.content??[])?.find((part:{type:string})=>part.type==='output_text')?.text;
      if(data?.status!=='completed'||typeof text!=='string')return reply(502,'OpenAI did not return a complete summary.');
      const summary=JSON.parse(text);
      if(typeof summary.observations!=='string'||typeof summary.action_plan!=='string')return reply(502,'OpenAI returned an unreadable summary.');
      return Response.json({observations:summary.observations.slice(0,4000),action_plan:summary.action_plan.slice(0,4000)},{headers:cors});
    }

    if(report.status!=='approved')return reply(409,'Approve the saved report before sending it.');
    if(!report.recipient_email||!email.test(report.recipient_email))return reply(400,'Set the client email in Client Manager, then generate and approve a fresh report.');
    const recipient=await db.from('clients').select('contact_email,status').eq('id',report.client_id).maybeSingle();
    if(recipient.error||recipient.data?.status==='archived'||recipient.data?.contact_email?.trim().toLowerCase()!==report.recipient_email){
      return reply(409,'The client email changed. Generate and approve a fresh report.');
    }
    const mailKey=env('RESEND_API_KEY'),from=env('REPORT_FROM_EMAIL');
    if(!mailKey||!from)return reply(503,'Set RESEND_API_KEY and a verified REPORT_FROM_EMAIL in Supabase Secrets.');
    const attachment=encodeAttachment(await buildReportPdf(report));
    const admin=createClient(project,service,{auth:{persistSession:false,autoRefreshToken:false}});
    const existing=await db.from('report_deliveries').select('status,attempt_count,updated_at').eq('report_id',report.id).maybeSingle();
    if(existing.error)return reply(503,'Could not verify the report delivery record.');
    if(existing.data?.status==='accepted')return reply(409,'This report has already been accepted by the email provider.');
    if(existing.data?.status==='unknown')return reply(409,'Check this report in Resend before creating a new delivery.');
    if(existing.data?.status==='sending'){
      if(Date.parse(existing.data.updated_at)<Date.now()-120000)await admin.from('report_deliveries')
        .update({status:'unknown',updated_at:new Date().toISOString()}).eq('report_id',report.id).eq('status','sending');
      return reply(409,'The previous email request is unconfirmed. Check Resend before trying again.');
    }
    if((existing.data?.attempt_count??0)>=2)return reply(409,'The email retry was used. Check your configuration before approving a new report version.');
    const claim=existing.data
      ? await admin.from('report_deliveries').update({status:'sending',attempt_count:2,updated_at:new Date().toISOString()})
        .eq('report_id',report.id).eq('status','failed').eq('attempt_count',1).select('report_id').maybeSingle()
      : await admin.from('report_deliveries').insert({report_id:report.id,client_id:report.client_id,recipient_email:report.recipient_email})
        .select('report_id').maybeSingle();
    if(claim.error||!claim.data)return reply(409,'Could not reserve delivery for this approved version. Refresh and check the current report and recipient.');
    let status='unknown';
    let providerId:string|null=null;
    try{
      const sent=await fetch('https://api.resend.com/emails',{
        method:'POST',headers:{Authorization:'Bearer '+mailKey,'Content-Type':'application/json','Idempotency-Key':'tsols-report/'+report.id},
        signal:AbortSignal.timeout(15000),
        body:JSON.stringify({from,to:[report.recipient_email],subject:labelCadence(report.cadence)+' TSOLS marketing report | '+periodLabel(report),
          text:'Your approved TSOLS marketing report is attached.\n\nReporting period: '+periodLabel(report)+'.\n\nThagana Solutions',
          attachments:[{filename:'TSOLS-'+report.cadence+'-'+report.period_start+'.pdf',content:attachment}],
        }),
      });
      const sentData=await sent.json().catch(()=>null);
      if(sent.ok&&typeof sentData?.id==='string'){status='accepted';providerId=sentData.id;}
      else if([400,401,403,404,422,429].includes(sent.status))status='failed';
    }catch{ /* A timed out provider request may have been accepted. */ }
    const recorded=await admin.from('report_deliveries').update({
      status,provider_id:providerId,updated_at:new Date().toISOString(),
    }).eq('report_id',report.id).eq('status','sending');
    if(recorded.error)return reply(503,'Could not save the result. Check Resend before trying again.');
    if(status==='failed')return reply(502,'Resend rejected the message. Check the sender domain and key before retrying.');
    if(status==='unknown')return reply(502,'The email outcome is unconfirmed. Check Resend before trying again.');
    return reply(200,'Resend accepted the report email.');
  }catch{return reply(502,'The report action could not finish.');}
});
