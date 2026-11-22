import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

type Snapshot={
  external_campaign_id:string;campaign_name:string;report_date:string;spend:number;impressions:number;clicks:number;
  reach:number|null;leads:number|null;conversions:number|null;conversion_label:string|null;
};
type Account={id:string;client_id:string;external_account_id:string;platform:'meta'|'google'};
const site=Deno.env.get('TSOLS_SITE_ORIGIN')??'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders={
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Cache-Control':'no-store',Vary:'Origin'};
const env=(name:string)=>Deno.env.get(name)?.trim()??'';
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const day=86400000;

class ImportError extends Error{constructor(message:string,readonly status=502){super(message);}}

function date(value:unknown) {
  if(typeof value!=='string'||!datePattern.test(value))return false;
  const parsed=new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.valueOf())&&parsed.toISOString().slice(0,10)===value;
}

function metric(value:unknown,integer=false){
  if(typeof value!=='string'&&typeof value!=='number')throw new ImportError('The provider returned an invalid metric.');
  const result=Number(value);
  if(value===''||!Number.isFinite(result)||(integer&&(!Number.isSafeInteger(result)||result<0)))throw new ImportError('The provider returned an invalid metric.');
  return result;
}

async function responseJson(url:string,params:RequestInit,provider:string){
  const response=await fetch(url,{...params,signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.error){
    if(response.status===429)throw new ImportError(provider+' rate-limited the report. Wait before importing again.',429);
    if(response.status===401||response.status===403)throw new ImportError(provider+' denied access. Check the token, permissions and linked ad account.');
    throw new ImportError(provider+' did not return the requested report. Check the account and API version.');
  }
  return data;
}

async function metaReport(account:Account,from:string,to:string){
  const token=env('META_ADS_ACCESS_TOKEN');
  const version=env('META_ADS_GRAPH_VERSION');
  if(!token||!/^v\d{2}\.\d+$/.test(version))throw new ImportError('Configure the Meta ads_read token and Graph version in Supabase Secrets.',503);
  const base='https://graph.facebook.com/'+version+'/act_'+account.external_account_id;
  const headers={Authorization:'Bearer '+token};
  const details=await responseJson(base+'?fields=currency,timezone_name',{headers},'Meta Ads');
  const rows:Snapshot[]=[];
  const query=new URLSearchParams({
    level:'campaign',time_increment:'1',time_range:JSON.stringify({since:from,until:to}),
    fields:'campaign_id,campaign_name,date_start,spend,impressions,reach,clicks,actions',limit:'500',
    use_account_attribution_setting:'true',
  });
  const conversionType=env('META_ADS_CONVERSION_ACTION');
  let after='';
  for(let page=0;page<10;page++){
    if(after)query.set('after',after);
    const result=await responseJson(base+'/insights?'+query.toString(),{headers},'Meta Ads');
    if(!Array.isArray(result.data))throw new ImportError('Meta Ads returned an unreadable report.');
    for(const item of result.data){
      const action=(type:string)=>{
        if(!type||!Array.isArray(item.actions))return null;
        const found=item.actions.find((row:{action_type:string})=>row.action_type===type);
        return found?metric(found.value):null;
      };
      rows.push({
        external_campaign_id:String(item.campaign_id??''),campaign_name:String(item.campaign_name??'').slice(0,300),report_date:item.date_start,
        spend:metric(item.spend??0),impressions:metric(item.impressions??0,true),clicks:metric(item.clicks??0,true),
        reach:item.reach==null?null:metric(item.reach,true),leads:action('lead'),conversions:action(conversionType),
        conversion_label:conversionType?conversionType.slice(0,100):null,
      });
    }
    if(rows.length>5000)throw new ImportError('The report is too large. Use a shorter date range.',413);
    if(!result.paging?.next)return {rows,currency:details.currency,zone:details.timezone_name};
    const cursor=result.paging?.cursors?.after;
    if(typeof cursor!=='string'||!cursor||cursor===after)throw new ImportError('Meta Ads did not provide a valid page cursor.');
    after=cursor;
  }
  throw new ImportError('The Meta report is too large. Use a shorter date range.',413);
}

async function googleReport(account:Account,from:string,to:string){
  const developer=env('GOOGLE_ADS_DEVELOPER_TOKEN');
  const clientId=env('GOOGLE_ADS_OAUTH_CLIENT_ID');
  const clientSecret=env('GOOGLE_ADS_OAUTH_CLIENT_SECRET');
  const refresh=env('GOOGLE_ADS_REFRESH_TOKEN');
  const version=env('GOOGLE_ADS_API_VERSION');
  const manager=env('GOOGLE_ADS_MANAGER_ID').replaceAll('-','');
  if(!developer||!clientId||!clientSecret||!refresh||!/^v\d{2}$/.test(version)
    ||(manager&&!/^\d{10}$/.test(manager)))throw new ImportError('Configure the Google Ads developer token, OAuth credentials, API version and optional manager ID in Supabase Secrets.',503);
  const token=await responseJson('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,client_secret:clientSecret,refresh_token:refresh}),
  },'Google OAuth');
  if(typeof token.access_token!=='string')throw new ImportError('Google OAuth did not issue an access token.');
  const headers:Record<string,string>={'Content-Type':'application/json',Authorization:'Bearer '+token.access_token,'developer-token':developer};
  if(manager)headers['login-customer-id']=manager;
  const url='https://googleads.googleapis.com/'+version+'/customers/'+account.external_account_id+'/googleAds:searchStream';
  async function run(query:string){
    const data=await responseJson(url,{method:'POST',headers,body:JSON.stringify({query})},'Google Ads');
    if(!Array.isArray(data))throw new ImportError('Google Ads returned an unreadable report.');
    return data.flatMap(batch=>Array.isArray(batch.results)?batch.results:[]);
  }
  const connection=await run('SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1');
  const info=connection[0]?.customer;
  const reports=await run("SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '"+from+"' AND '"+to+"'");
  if(reports.length>5000)throw new ImportError('The Google Ads report is too large. Use a shorter date range.',413);
  const rows:Snapshot[]=reports.map(row=>({
    external_campaign_id:String(row.campaign?.id??''),campaign_name:String(row.campaign?.name??'').slice(0,300),report_date:row.segments?.date,
    spend:metric(row.metrics?.costMicros??0,true)/1000000,impressions:metric(row.metrics?.impressions??0,true),clicks:metric(row.metrics?.clicks??0,true),
    reach:null,leads:null,conversions:metric(row.metrics?.conversions??0),conversion_label:'Google Ads conversions',
  }));
  return {rows,currency:info?.currencyCode,zone:info?.timeZone};
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
  if(!auth?.startsWith('Bearer '))return reply(401,'Sign in again to import ad performance.');
  const project=env('SUPABASE_URL');
  const publicKey=env('SUPABASE_ANON_KEY');
  const service=env('SUPABASE_SERVICE_ROLE_KEY');
  if(!project||!publicKey||!service)return reply(503,'Ads import is unavailable.');
  try{
    const db=createClient(project,publicKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
    const identity=await db.auth.getUser(auth.slice(7));
    if(identity.error||!identity.data.user)return reply(401,'Sign in again to import ad performance.');
    const raw=await request.text();
    if(raw.length>3000)return reply(413,'The import request is too large.');
    let payload;
    try{payload=JSON.parse(raw);}catch{return reply(400,'Invalid import request.');}
    const {account_id:id,date_from:from,date_to:to,fx_rate:rate,fx_source:source,fx_as_of:effective}=payload??{};
    if(typeof id!=='string'||!idPattern.test(id)||!date(from)||!date(to)||from>to||Date.parse(to)-Date.parse(from)>30*day){
      return reply(400,'Choose an account and a range of up to 31 days.');
    }
    if(rate!=null&&(typeof rate!=='number'||!Number.isFinite(rate)||rate<=0||rate>=1e9
      ||typeof source!=='string'||source.trim().length<1||source.length>160||!date(effective))){
      return reply(400,'A positive KES rate requires a source and effective date.');
    }
    const mapping=await db.from('ad_accounts').select('id,client_id,platform,external_account_id,clients!inner(status)')
      .eq('id',id).neq('clients.status','archived').maybeSingle();
    if(mapping.error||!mapping.data)return reply(403,'This advertising account is unavailable.');
    const account=mapping.data as Account;
    let bindings;
    try{bindings=JSON.parse(env('ADS_ACCOUNT_BINDINGS')||'{}');}catch{return reply(503,'ADS_ACCOUNT_BINDINGS is not valid JSON.');}
    const binding=account.platform+':'+account.external_account_id;
    if(!bindings||!Object.hasOwn(bindings,binding)||bindings[binding]!==account.client_id){
      return reply(503,'Bind this provider account to the selected client in ADS_ACCOUNT_BINDINGS first.');
    }
    if(account.platform==='meta'&&!/^\d{5,24}$/.test(account.external_account_id))return reply(400,'Invalid Meta account ID.');
    if(account.platform==='google'&&!/^\d{10}$/.test(account.external_account_id))return reply(400,'Invalid Google Ads account ID.');
    const report=account.platform==='meta'?await metaReport(account,from,to):await googleReport(account,from,to);
    if(typeof report.currency!=='string'||!/^[A-Z]{3}$/.test(report.currency)||
      report.rows.some(row=>!/^\d{1,24}$/.test(row.external_campaign_id)||!row.campaign_name||!date(row.report_date)||row.report_date<from||row.report_date>to)){
      return reply(502,'The provider returned an invalid account currency or campaign row.');
    }
    const admin=createClient(project,service,{auth:{persistSession:false,autoRefreshToken:false}});
    const write=await admin.rpc('ingest_ad_performance',{
      target_account:account.id,operator_id:identity.data.user.id,source_currency:report.currency,reporting_zone:report.zone??null,
      from_date:from,to_date:to,rate_kes:rate??null,rate_source:rate!=null?source.trim():null,rate_date:rate!=null?effective:null,snapshot_rows:report.rows,
    });
    if(write.error)return reply(503,'The report was retrieved but could not be stored. Verify the currency and date range.');
    return Response.json({row_count:write.data,currency:report.currency},{headers:cors});
  }catch(error){
    if(error instanceof ImportError)return reply(error.status,error.message);
    return reply(502,'The read-only provider request could not finish.');
  }
});
