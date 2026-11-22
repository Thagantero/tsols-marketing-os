import {loadChannelAnalytics} from './channel-analytics.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const defaults={project:'https://rexnutczviawkbpjanmt.supabase.co',agency:'a8816370-4462-4741-8ac9-79d31b51f2af',organization:'6afa0ae5b8d434e1d6df2d4f'};
Deno.serve(async request=>{
  const origin=request.headers.get('Origin');
  const allowed=new Set(['https://os.tsols.co.ke','https://tsols-marketing-os.partedmars4.chatgpt.site',Deno.env.get('TSOLS_SITE_ORIGIN')].filter(Boolean));
  const headers={'Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',...(origin&&allowed.has(origin)?{'Access-Control-Allow-Origin':origin}:{})};
  const reply=(status:number,body:unknown)=>Response.json(body,{status,headers});
  if(origin&&!allowed.has(origin))return reply(403,{message:'Origin unavailable.'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply(405,{message:'Use POST.'});
  const auth=request.headers.get('Authorization');
  if(!auth?.startsWith('Bearer '))return reply(401,{message:'Sign in again.'});
  try{
    const project=Deno.env.get('SUPABASE_URL');
    const anon=Deno.env.get('SUPABASE_ANON_KEY');
    if(!project||!anon)return reply(503,{message:'Content analytics configuration is incomplete.'});
    const db=createClient(project,anon,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
    const identity=await db.auth.getUser(auth.slice(7));
    if(identity.error||!identity.data.user)return reply(401,{message:'Sign in again.'});
    const raw=await request.text();
    if(raw.length>18000)return reply(413,{message:'Request is too large.'});
    let input;try{input=JSON.parse(raw);}catch{return reply(400,{message:'Invalid request.'});}
    if(!uuid(input?.client_id)||(input.after!==undefined&&(typeof input.after!=='string'||input.after.length>16000)))return reply(400,{message:'Choose a client.'});
    // Every account is read under the caller's JWT and existing client RLS.
    const client=await db.from('clients').select('id,agency_id').eq('id',input.client_id).maybeSingle();
    if(client.error||!client.data)return reply(403,{message:'This client is unavailable.'});
    const isTsols=project===defaults.project;
    const agency=Deno.env.get('BUFFER_AGENCY_ID')?.trim()||(isTsols?defaults.agency:'');
    const organization=Deno.env.get('BUFFER_ORGANIZATION_ID')?.trim()||(isTsols?defaults.organization:'');
    if(!agency||agency!==client.data.agency_id)return reply(403,{message:'Buffer analytics is not connected for this agency.'});
    const accounts=await db.from('publishing_accounts').select('id,buffer_channel_id,name,platform').eq('client_id',input.client_id).eq('active',true);
    if(accounts.error)return reply(500,{message:'Could not read connected channels.'});
    if(!accounts.data?.length)return reply(200,{posts:[],accounts:[],pageInfo:{hasNextPage:false,endCursor:null},fetchedAt:new Date().toISOString()});
    const key=Deno.env.get('BUFFER_API_KEY')?.trim();
    if(!key||!organization)return reply(503,{message:'The saved Buffer connection is incomplete. An administrator needs to check the API key and organization.'});
    const channels=[...new Set(accounts.data.map(a=>a.buffer_channel_id))];
    if(channels.length>1){
      const send=async(query:string)=>{const r=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(20000)});return {status:r.status,body:await r.json().catch(()=>null)};};
      const result=await loadChannelAnalytics({accounts:accounts.data,clientId:input.client_id,after:input.after,
        sanitize:value=>value.split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/https?:\/\/[^\s]+/gi,'[provider URL]').replace(/[A-Za-z0-9_-]{48,}/g,'[redacted]').slice(0,350),
        read:(channel,cursor,metrics)=>send('query { posts(first:20'+(cursor?',after:'+JSON.stringify(cursor):'')+',input:{organizationId:'+JSON.stringify(organization)+',filter:{status:[sent],channelIds:['+JSON.stringify(channel)+']}}) { edges { node { id text channelId sentAt '+(metrics?'externalLink metrics { type name value unit } metricsUpdatedAt':'')+' } } pageInfo { endCursor hasNextPage } } }'),
        readChannels:()=>send('query { channels(input:{organizationId:'+JSON.stringify(organization)+'}) { id isDisconnected } }'),
      });
      for(const error of (result.body as any).channelErrors??[])console.warn(JSON.stringify({event:'buffer_channel_read_error',channel:error.name,reason:error.code,mapping:error.mapping_status,detail:error.message}));
      return reply(result.status,result.body);
    }
    const query=(metrics=true)=>'query { posts(first:20'+(input.after?',after:'+JSON.stringify(input.after):'')+',input:{organizationId:'+JSON.stringify(organization)+',filter:{status:[sent],channelIds:'+JSON.stringify(channels)+'}}) { edges { node { id text channelId sentAt '+(metrics?'externalLink metrics { type name value unit } metricsUpdatedAt':'')+' } } pageInfo { endCursor hasNextPage } } }';
    const requestPosts=async(metrics:boolean)=>{const response=await fetch('https://api.buffer.com',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({query:query(metrics)}),signal:AbortSignal.timeout(20000)});return {response,body:await response.json().catch(()=>null)};};
    const reason=(body:any,status:number)=>{
      const errors=Array.isArray(body?.errors)?body.errors:[];
      if(status===401||errors.some((e:any)=>e.extensions?.code==='UNAUTHENTICATED'))return 'authentication';
      if(status===429||errors.some((e:any)=>/RATE|THROTTL/.test(String(e.extensions?.code??''))))return 'rate_limit';
      if(errors.some((e:any)=>/cannot query field.*(?:metrics|metricsUpdatedAt)/i.test(String(e.message??''))))return 'metrics_not_supported';
      if(status===403||errors.some((e:any)=>/FORBIDDEN|PERMISSION|ACCESS_DENIED/.test(String(e.extensions?.code??''))||/permission|not authorized|not authorised|access denied/i.test(String(e.message??''))))return 'permissions';
      if(errors.some((e:any)=>/VALIDATION|BAD_USER_INPUT/.test(String(e.extensions?.code??''))||/cannot query field|unknown argument/i.test(String(e.message??''))))return 'query_rejected';
      return 'provider_error';
    };
    const providerDetail=(body:any)=>{
      const clean=(value:string)=>value.split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/https?:\/\/[^\s]+/gi,'[provider URL]').replace(/[A-Za-z0-9_-]{48,}/g,'[redacted]').slice(0,350);
      return (Array.isArray(body?.errors)?body.errors:[]).slice(0,2).map((error:any)=>typeof error?.message==='string'?clean(error.message):'').filter(Boolean).join(' · ');
    };
    const warningText=(code:string)=>code==='metrics_not_supported'?'Buffer accepts post access but does not expose the analytics fields to this API key. Published posts are shown below; metrics are not available through this connection.':code==='permissions'?'Buffer allows post access, but denied the analytics request. Check this key’s analytics permissions in Buffer. Published posts are shown below.':code==='query_rejected'?'Buffer rejected the analytics query. Published posts were loaded separately; performance metrics are not confirmed.':'Buffer could not return performance metrics. Published posts were loaded separately; retry metrics later.';
    let {response,body}=await requestPosts(true);
    let diagnostic=reason(body,response.status),warning:string|undefined;
    if(diagnostic==='authentication')return reply(502,{message:'Buffer rejected the saved API key. Reconnect Buffer.',diagnostic_code:diagnostic});
    if(diagnostic==='rate_limit')return reply(429,{message:'Buffer rate limit reached. Wait a moment and refresh again.',diagnostic_code:diagnostic});
    const validRows=()=>Array.isArray(body?.data?.posts?.edges);
    if(body?.errors?.length||!response.ok||!validRows()){
      // Only classify failures in logs; provider text may contain request details.
      console.warn(JSON.stringify({event:'buffer_analytics_error',phase:'metrics',status:response.status,reason:diagnostic,detail:providerDetail(body)}));
      const partialMetrics=validRows()&&body.errors?.every((e:any)=>Array.isArray(e.path)&&e.path.some((part:unknown)=>part==='metrics'||part==='metricsUpdatedAt'));
      if(partialMetrics){warning='Buffer returned posts with partial analytics. Only the metrics actually supplied are shown.';}
      else{
        const recoverable=Array.isArray(body?.errors)&&body.errors.length>0||response.status===403;
        if(!recoverable)return reply(502,{message:'Buffer could not load post analytics. Try again later.',diagnostic_code:diagnostic});
        const fallback=await requestPosts(false);const fallbackReason=reason(fallback.body,fallback.response.status);
        if(!fallback.response.ok||fallback.body?.errors?.length||!Array.isArray(fallback.body?.data?.posts?.edges)){
          console.warn(JSON.stringify({event:'buffer_analytics_error',phase:'posts',status:fallback.response.status,reason:fallbackReason,detail:providerDetail(fallback.body)}));
          return reply(fallbackReason==='rate_limit'?429:502,{message:(fallbackReason==='authentication'?'Buffer rejected the saved API key. Reconnect Buffer.':fallbackReason==='permissions'?'Buffer rejected the post-reading request. Posting and scheduling use a separate API operation.':fallbackReason==='query_rejected'?'Buffer rejected the post-list request. The API query needs review; reconnecting Google or Bing will not resolve this.':'Buffer could not return published posts or metrics. Try again later.')+(providerDetail(fallback.body)?' Buffer says: '+providerDetail(fallback.body):''),diagnostic_code:fallbackReason});
        }
        warning=warningText(diagnostic)+(providerDetail(body)?' Buffer says: '+providerDetail(body):'');response=fallback.response;body=fallback.body;
      }
    }
    const posts=body.data.posts.edges.map((edge:any)=>edge?.node).filter((post:any)=>post&&channels.includes(post.channelId)).map((post:any)=>({...post,externalLink:post.externalLink??null,metrics:post.metrics??null,metricsUpdatedAt:post.metricsUpdatedAt??null}));
    return reply(200,{posts,accounts:accounts.data,pageInfo:body.data.posts.pageInfo,fetchedAt:new Date().toISOString(),...(warning?{warning,diagnostic_code:diagnostic}:{})});
  }catch{return reply(502,{message:'Could not refresh content analytics. Please try again.'});}
});
