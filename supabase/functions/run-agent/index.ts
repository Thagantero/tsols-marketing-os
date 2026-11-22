import {createClient} from 'npm:@supabase/supabase-js@2.119.0';

const site=Deno.env.get('TSOLS_SITE_ORIGIN')??'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders={
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
  'Cache-Control':'no-store',Vary:'Origin',
};
const env=(name:string)=>Deno.env.get(name)?.trim()??'';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const prompts={
  content:'Create two generic examples for a small-business social media campaign. Include one caption, four hashtag ideas and a short creative brief. Use placeholders for business details.',
  design:'Suggest two reusable small-business poster layouts. Include hierarchy, visual placement, headline and call-to-action placeholders.',
} as const;
type Output={status?:string;model?:string;output?:{content?:{type:string;text?:string}[]}[];usage?:{input_tokens?:number;output_tokens?:number}};
const auth={persistSession:false,autoRefreshToken:false};
const rate=(name:string)=>{const value=env(name);return value&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;};

Deno.serve(async request=>{
  const origin=request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const headers={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply=(status:number,message:string)=>Response.json({message},{status,headers});
  if(origin && !allowedOrigin)return reply(403,'Origin unavailable.');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply(405,'Use POST.');
  const authorization=request.headers.get('Authorization');
  if(!authorization?.startsWith('Bearer '))return reply(401,'Sign in again.');
  const project=env('SUPABASE_URL'),key=env('SUPABASE_ANON_KEY'),worker=env('SUPABASE_SERVICE_ROLE_KEY');
  if(!project||!key||!worker)return reply(503,'Agent execution is unavailable.');
  const db=createClient(project,key,{auth,global:{headers:{Authorization:authorization}}});
  const service=createClient(project,worker,{auth});
  let attempt:{id:string;attempts:number}|undefined;
  let model:string|null=null,tokensIn:number|null=null,tokensOut:number|null=null,price:number|null=null;
  async function finish(output:string|null,error:string|null) {
    if(!attempt)return false;
    const result=await service.rpc('finish_ai_agent',{
      task_id:attempt.id,attempt:attempt.attempts,output_text:output,error_text:error,
      model,tokens_in:tokensIn,tokens_out:tokensOut,price,
    });
    return !result.error&&result.data===true;
  }
  async function fail(status:number,message:string) {
    return await finish(null,message)?reply(status,message):reply(503,'The execution record could not be confirmed. Check the automation log before retrying.');
  }

  try {
    const identity=await db.auth.getUser(authorization.slice(7));
    if(identity.error||!identity.data.user)return reply(401,'Sign in again.');
    const raw=await request.text();
    if(raw.length>1000)return reply(413,'Agent request is too large.');
    let input;
    try {input=JSON.parse(raw);} catch {return reply(400,'Invalid agent request.');}
    if(typeof input?.task_id!=='string'||!uuid.test(input.task_id)||input.confirmed!==true)
      return reply(400,'Choose and confirm an approved AI task.');
    const target=await db.from('agent_tasks').select('agent').eq('id',input.task_id).maybeSingle();
    const kind:unknown=target.data?.agent;
    if(target.error||(kind!=='content'&&kind!=='design'))return reply(403,'AI ideas are available for Content and Design tasks.');
    const claimed=await service.rpc('start_ai_agent',{task_id:input.task_id,operator:identity.data.user.id});
    const job=claimed.data;
    if(claimed.error)return reply(503,'Could not start the agent task. Check Automations and try again.');
    if(!job?.id)return reply(409,'This approved task is unavailable, paused or already running.');
    attempt={id:job.id,attempts:job.attempts};
    const apiKey=env('OPENAI_API_KEY');
    if(!apiKey)return fail(503,'Add OPENAI_API_KEY in Supabase to run AI tasks. Standard workflows remain available.');
    const quota=await db.rpc('reserve_content_generation',{target_client:job.client_id});
    if(quota.error||!quota.data)return fail(429,'Could not reserve AI capacity. Check the hourly limit before retrying.');
    model=env('OPENAI_MODEL')||'gpt-4.1-mini';
    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(35000),
      body:JSON.stringify({
        model,store:false,max_output_tokens:900,
        input:prompts[kind],
      }),
    });
    const data:Output|null=await response.json().catch(()=>null);
    if(!response.ok)return fail(502,response.status===429?'OpenAI returned a quota or rate limit. Check billing and usage before retrying.':'OpenAI could not complete this task. Check the key and model access.');
    const rawModel=data?.model;
    if(typeof rawModel==='string')model=rawModel.slice(0,120);
    const checkTokens=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<2147483648?value:null;
    tokensIn=checkTokens(data?.usage?.input_tokens);
    tokensOut=checkTokens(data?.usage?.output_tokens);
    const inputRate=rate('AGENT_INPUT_USD_PER_MILLION'),outputRate=rate('AGENT_OUTPUT_USD_PER_MILLION');
    if(tokensIn!==null&&tokensOut!==null&&inputRate!==null&&outputRate!==null){
      const estimate=(tokensIn*inputRate+tokensOut*outputRate)/1e6;
      if(Number.isFinite(estimate)&&estimate<999999)price=estimate;
    }
    const output=data?.output?.flatMap(item=>item.content??[]).filter(part=>part.type==='output_text')
      .map(part=>part.text??'').join('\n').trim();
    if(data?.status!=='completed'||!output)return fail(502,'OpenAI did not return a complete recommendation. Review the brief before retrying.');
    if(!await finish(output.slice(0,6000),null))return reply(503,'The execution record could not be confirmed. Check Automations before retrying.');
    return reply(200,'Recommendation saved for review.');
  } catch {
    return attempt?fail(502,'Execution was interrupted. Check provider usage before retrying.'):reply(502,'The agent could not start. Try again.');
  }
});
