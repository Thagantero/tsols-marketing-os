import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

function json(status:number, message:string) {
  return Response.json({message},{status,headers:{'Cache-Control':'no-store'}});
}

Deno.serve(async request=>{
  if(request.method!=='POST')return json(405,'Use POST.');
  const token=request.headers.get('X-TSOLS-Intake-Token')??'';
  if(!/^[0-9a-f]{64}$/i.test(token))return json(401,'Invalid capture token.');
  if(Number(request.headers.get('Content-Length'))>4096)return json(413,'Lead request is too large.');
  const project=Deno.env.get('SUPABASE_URL');
  const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!project||!service)return json(503,'Lead intake is unavailable.');
  try{
    const raw=await request.text();
    if(raw.length>4096)return json(413,'Lead request is too large.');
    let data;
    try{data=JSON.parse(raw);}catch{return json(400,'Use a JSON request body.');}
    const fields:Record<string,number>={name:160,phone:40,whatsapp_number:40,email:254,service:200,intent:30};
    const payload:Record<string,string|boolean>={};
    for(const [field,max] of Object.entries(fields)){
      const value=data?.[field]??'';
      if(typeof value!=='string'||value.length>max)return json(400,'Lead fields are invalid.');
      payload[field]=value.trim();
    }
    if(!payload.name||!(payload.phone||payload.email||payload.whatsapp_number))return json(400,'Name and a contact method are required.');
    if(data.whatsapp_opt_in!==undefined&&typeof data.whatsapp_opt_in!=='boolean')return json(400,'WhatsApp opt-in must be a boolean.');
    if(data.whatsapp_opt_in&&!payload.whatsapp_number)return json(400,'A WhatsApp number is required when opting in.');
    payload.whatsapp_opt_in=data.whatsapp_opt_in===true;
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token.toLowerCase())));
    const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    const db=createClient(project,service,{auth:{persistSession:false,autoRefreshToken:false}});
    const result=await db.rpc('capture_website_lead',{token_digest:hash,payload});
    if(result.error)return json(['23514','P0001','22P02'].includes(result.error.code)?400:503,'The lead could not be accepted. Check the contact details.');
    if(result.data==='invalid_token')return json(401,'Invalid or disabled capture token.');
    if(result.data==='rate_limited')return json(429,'Too many submissions. Try again shortly.');
    return json(202,'Lead accepted.');
  }catch{return json(503,'Lead intake could not finish.');}
});
