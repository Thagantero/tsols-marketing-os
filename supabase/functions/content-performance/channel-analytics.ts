type Account={id:string;buffer_channel_id:string;name:string;platform:string};
type Remote={status:number;body:any};
const prefix='tsols-channels:';
export async function loadChannelAnalytics({accounts,clientId,after,read,readChannels,sanitize}:{accounts:Account[];clientId:string;after?:string;read:(channel:string,after:string|undefined,metrics:boolean)=>Promise<Remote>;readChannels:()=>Promise<Remote>;sanitize:(message:string)=>string}){
 let state:Record<string,string|null>={},previousErrors:any[]=[];
 if(after){try{if(!after.startsWith(prefix))throw new Error();const parsed=JSON.parse(decodeURIComponent(after.slice(prefix.length)));if(parsed.client!==clientId||parsed.channels!==accounts.map(a=>a.buffer_channel_id).sort().join(','))throw new Error();state=parsed.cursors;previousErrors=parsed.errors??[];if(!state||typeof state!=='object'||Object.values(state).some(v=>v!==null&&typeof v!=='string'))throw new Error();}catch{return {status:400,body:{message:'The channel list or paging context changed. Refresh metrics to restart.'}};}}
 const detail=(r:Remote)=>(Array.isArray(r.body?.errors)?r.body.errors:[]).slice(0,2).map((e:any)=>typeof e?.message==='string'?sanitize(e.message):'').filter(Boolean).join(' · ');
 const code=(r:Remote)=>r.status===401||r.body?.errors?.some((e:any)=>e.extensions?.code==='UNAUTHENTICATED')?'authentication':r.status===429||r.body?.errors?.some((e:any)=>/RATE|THROTTL/.test(String(e.extensions?.code??'')))?'rate_limit':r.status===403||r.body?.errors?.some((e:any)=>/FORBIDDEN|PERMISSION|ACCESS_DENIED/.test(String(e.extensions?.code??''))||/cannot access|permission|access denied/i.test(String(e.message??'')))?'permissions':'provider_error';
 const valid=(r:Remote)=>r.status>=200&&r.status<300&&Array.isArray(r.body?.data?.posts?.edges);
 const results=await Promise.all(accounts.map(async account=>{
  const channel=account.buffer_channel_id;
  if(Object.prototype.hasOwnProperty.call(state,channel)&&state[channel]===null)return {account,skipped:true,error:previousErrors.find(e=>e.account_id===account.id)};
  let response:Remote;try{response=await read(channel,state[channel]??undefined,true);}catch{return {account,error:{account_id:account.id,name:account.name,message:'Buffer did not respond for this channel.',code:'provider_error'}};}
  const initial=detail(response);let warning='';
  const partial=valid(response)&&response.body.errors?.every((e:any)=>e.path?.some((p:unknown)=>p==='metrics'||p==='metricsUpdatedAt'));
  if((response.body?.errors?.length&&!partial)||!valid(response)){
   const failure=code(response);if(failure==='authentication'||failure==='rate_limit')return {account,error:{account_id:account.id,name:account.name,message:initial||'Buffer '+failure,code:failure}};
   try{response=await read(channel,state[channel]??undefined,false);}catch{return {account,error:{account_id:account.id,name:account.name,message:'Buffer did not respond for this channel.',code:'provider_error'}};}
   if(response.body?.errors?.length||!valid(response))return {account,error:{account_id:account.id,name:account.name,message:detail(response)||initial||'Buffer rejected this channel.',code:code(response)}};
   warning=initial||'Metrics are not supplied for this channel.';
  }else if(partial)warning='Buffer supplied partial metrics for this channel.';
  const posts=response.body.data.posts.edges.map((e:any)=>e?.node).filter((p:any)=>p?.channelId===channel).map((p:any)=>({...p,metrics:p.metrics??null,metricsUpdatedAt:p.metricsUpdatedAt??null,externalLink:p.externalLink??null}));
  const page=response.body.data.posts.pageInfo;
  return {account,posts,next:page?.hasNextPage&&typeof page.endCursor==='string'?page.endCursor:null,warning};
 }));
 const errors=results.filter(r=>r.error).map(r=>r.error!);
 if(errors.length===accounts.length&&errors.every(e=>e.code==='authentication'))return {status:502,body:{message:'Buffer rejected authentication for every channel.',diagnostic_code:'authentication'}};
 if(errors.length===accounts.length&&errors.every(e=>e.code==='rate_limit'))return {status:429,body:{message:'Buffer rate limit reached. Wait before refreshing.',diagnostic_code:'rate_limit'}};
 // The live channel listing distinguishes stale mappings from post-read restrictions.
 if(errors.some(e=>e.code==='permissions')){
  try{const listing=await readChannels();if(listing.status===200&&Array.isArray(listing.body?.data?.channels)){
   const live=new Map<string,any>(listing.body.data.channels.map((c:any)=>[c.id,c]));
   for(const error of errors.filter(e=>e.code==='permissions')){const account=accounts.find(a=>a.id===error.account_id)!;const channel=live.get(account.buffer_channel_id);error.mapping_status=channel?channel.isDisconnected?'disconnected':'present':'missing';error.message=channel?channel.isDisconnected?'This channel is disconnected in Buffer.':error.message+' Buffer lists this channel, but rejects post reads for it.':'The saved channel ID is not in the channels this Buffer account can access. Relink this account in Publishing.';}
  }}catch{}
 }
 const cursors=Object.fromEntries(results.map(r=>[r.account.buffer_channel_id,r.skipped?null:r.next??null]));
 const hasNextPage=Object.values(cursors).some(Boolean);
 const posts=results.flatMap(r=>r.posts??[]).sort((a,b)=>(b.sentAt??'').localeCompare(a.sentAt??''));
 const successful=accounts.length-errors.length;
 const warnings=results.filter(r=>r.warning).map(r=>r.account.name+': '+r.warning);
 if(errors.length)warnings.unshift((successful?'Some channels could not load: ':'Buffer could not read these channels: ')+errors.map(e=>e.name).join(', ')+'. See channel access status below.');
 return {status:200,body:{posts,accounts,channelErrors:errors,successfulChannels:successful,coverage:errors.length?'partial':'complete',warning:warnings.join(' '),pageInfo:{hasNextPage,endCursor:hasNextPage?prefix+encodeURIComponent(JSON.stringify({client:clientId,channels:accounts.map(a=>a.buffer_channel_id).sort().join(','),cursors,errors})):null},fetchedAt:new Date().toISOString()}};
}
