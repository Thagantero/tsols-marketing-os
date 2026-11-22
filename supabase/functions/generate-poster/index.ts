import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const site = Deno.env.get('TSOLS_SITE_ORIGIN') ?? 'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders = {
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
  'Cache-Control':'no-store',Vary:'Origin',
};
const sizes:Record<string,string> = {'1:1':'1024x1024','4:5':'1024x1536','9:16':'1024x1536','16:9':'1536x1024'};

Deno.serve(async request => {
  const origin = request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const cors={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply = (status:number, body:Record<string, unknown>) => Response.json(body,{status,headers:cors});
  if (origin && !allowedOrigin) return reply(403,{message:'Origin unavailable.'});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  if (request.method !== 'POST') return reply(405,{message:'Use POST.'});
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return reply(401,{message:'Sign in again to generate a backdrop.'});
  const projectUrl = Deno.env.get('SUPABASE_URL');
  const projectKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!projectUrl || !projectKey) return reply(503,{message:'Supabase configuration is incomplete.'});
  try {
    const db = createClient(projectUrl,projectKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
    const identity = await db.auth.getUser(auth.slice(7));
    if (identity.error || !identity.data.user) return reply(401,{message:'Sign in again to generate a backdrop.'});
    const raw = await request.text();
    if (raw.length > 2500) return reply(413,{message:'The visual brief is too long.'});
    let input;
    try {input=JSON.parse(raw);} catch {return reply(400,{message:'Invalid visual brief.'});}
    if (typeof input?.client_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.client_id)
      || typeof input?.brief !== 'string' || !input.brief.trim() || input.brief.length > 1000
      || typeof input?.ratio !== 'string' || !Object.hasOwn(sizes,input.ratio)) return reply(400,{message:'Enter a visual brief and choose a layout.'});
    const client = await db.from('clients').select('id').eq('id',input.client_id).neq('status','archived').maybeSingle();
    if (client.error || !client.data) return reply(403,{message:'This client is unavailable.'});
    const key = Deno.env.get('OPENAI_API_KEY');
    if (!key) return reply(503,{message:'Add OPENAI_API_KEY in Supabase to enable image generation.'});
    const quota = await db.rpc('reserve_content_generation',{target_client:input.client_id});
    if (quota.error) return reply(500,{message:'Could not reserve generation capacity.'});
    if (!quota.data) return reply(429,{message:'The agency reached its hourly generation limit.'});
    const model = Deno.env.get('OPENAI_IMAGE_MODEL') ?? 'gpt-image-2.5-flare';
    const result = await fetch('https://api.openai.com/v1/images/generations',{
      method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(100000),body:JSON.stringify({
        model,n:1,size:sizes[input.ratio],quality:'low',output_format:'jpeg',
        prompt:`Generate an editorial photo backdrop for a social poster. Keep the lower third simple for a separate text overlay. Do not include words, numbers, logos or watermarks. Visual brief:\n${input.brief.trim()}`,
      }),
    });
    const data = await result.json().catch(() => null);
    if (!result.ok) {
      const code = data?.error?.code ?? data?.error?.type;
      const message = code === 'insufficient_quota' || result.status === 402
        ? 'The OpenAI API project has no available image-generation quota.'
        : result.status === 429 ? 'OpenAI returned a rate limit for image generation. Check the API project limits before retrying.'
        : 'OpenAI could not generate the image. Check the API key, image model access, and billing.';
      return reply(502,{message});
    }
    const image = data?.data?.[0]?.b64_json;
    if (typeof image !== 'string' || image.length > 9500000) return reply(502,{message:'The image response could not be opened.'});
    return reply(200,{image,model,usage:{input_tokens:data.usage?.input_tokens ?? null,output_tokens:data.usage?.output_tokens ?? null}});
  } catch {return reply(502,{message:'The image request did not finish. Try a client photo or a solid backdrop.'});}
});
