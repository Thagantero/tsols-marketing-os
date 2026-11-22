import { useEffect,useRef,useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate,supabase } from './data';
import { edgeMessage } from './publishing';
import { engagement,metricValue,safePostLink,totalMetric,type PerformancePost } from './content-performance-model';
type Account={id:string;buffer_channel_id:string;name:string;platform:string};
type Result={posts:PerformancePost[];accounts:Account[];pageInfo:{hasNextPage:boolean;endCursor:string|null};fetchedAt:string;warning?:string;diagnostic_code?:string;coverage?:'complete'|'partial';successfulChannels?:number;channelErrors?:{account_id:string;name:string;message:string;code:string}[]};
const count=(v:number|null)=>v===null?'—':new Intl.NumberFormat('en-KE',{maximumFractionDigits:2}).format(v);
const day=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function ContentPerformance({clientId}:{clientId:string}){
  const [result,setResult]=useState<Result>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [channel,setChannel]=useState('');
  const [from,setFrom]=useState('');const [to,setTo]=useState('');
  const [sort,setSort]=useState('recent');
  const sequence=useRef(0);
  async function load(more=false){
    if(!supabase||!clientId)return;
    const request=++sequence.current;
    setBusy(true);setError('');
    try{
      const response=await supabase.functions.invoke<Result>('content-performance',{body:{client_id:clientId,...(more&&result?.pageInfo.endCursor?{after:result.pageInfo.endCursor}:{})}});
      if(response.error)throw new Error(await edgeMessage(response.error,'Could not load content analytics.'));
      if(!response.data||!Array.isArray(response.data.posts))throw new Error('The analytics response was incomplete.');
      if(sequence.current!==request)return;
      const data=response.data;
      setResult(previous=>more&&previous?{...data,posts:[...new Map([...previous.posts,...data.posts].map(post=>[post.id,post])).values()]}:data);
    }catch(problem){if(sequence.current===request)setError(problem instanceof Error?problem.message:'Could not load content analytics.');}
    finally{if(sequence.current===request)setBusy(false);}
  }
  useEffect(()=>{setResult(undefined);setChannel('');setFrom('');setTo('');setError('');void load();return()=>{sequence.current++;};},[clientId]);
  const invalidRange=Boolean(from&&to&&from>to);
  const posts=(result?.posts??[]).filter(post=>(!channel||post.channelId===channel)&&(!from||Boolean(post.sentAt&&day(post.sentAt)>=from))&&(!to||Boolean(post.sentAt&&day(post.sentAt)<=to)));
  const sorted=[...posts].sort((a,b)=>sort==='recent'?(b.sentAt??'').localeCompare(a.sentAt??''):sort==='engagement'?(engagement(b)??-1)-(engagement(a)??-1):(metricValue(b,sort)??-1)-(metricValue(a,sort)??-1));
  const metrics=[['views','Views'],['impressions','Impressions'],['reach','Reach'],['reactions','Reactions'],['comments','Comments'],['shares','Shares'],['reposts','Reposts'],['saves','Saves'],['clicks','Post clicks']] as const;
  const reportedMetrics=metrics.filter(([key])=>totalMetric(posts,key).covered>0);
  const refreshed=posts.filter(post=>post.metricsUpdatedAt&&post.metrics?.length).length;
  return <div className="content-analytics">
    <section className="panel form-section analytics-hero">
      <span className="studio-eyebrow">SOCIAL INTELLIGENCE</span><div className="calendar-controls"><div><h2>Content performance</h2><p>Actual post metrics from your connected Buffer channels.</p></div>
        <Button variant="outline" disabled={busy||!clientId} onClick={()=>void load()}><RefreshCw size={16}/>{busy?'Checking Buffer…':'Verify & refresh Buffer'}</Button></div>
      <p className="muted">Lifetime performance for your published posts. Availability varies by social network; Buffer refreshes metrics daily.</p>
      {error&&<p role="alert" className="notice error">{error}{result?' Previously fetched results remain below.':''}</p>}
      <div className="calendar-filters">
        <label>Channel<select value={channel} onChange={e=>setChannel(e.target.value)}><option value="">All connected channels</option>{result?.accounts.map(a=><option key={a.id} value={a.buffer_channel_id}>{a.name} · {a.platform}</option>)}</select></label>
        <label>Published from (EAT)<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
        <label>Published through (EAT)<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
      </div>
      {result?.warning&&<p className="notice" role="status">{result.warning}</p>}
      {invalidRange&&<p className="notice error" role="alert">Choose an end date on or after the start date.</p>}
      {!clientId?<p className="empty">Choose a client to view their content performance.</p>:busy&&!result?<p className="empty" role="status">Reading published posts and metrics from Buffer…</p>:result&&<>
        <p className="muted">Fetched {displayDate(result.fetchedAt)} · {posts.length} posts shown of {result.posts.length} loaded.{result.pageInfo.hasNextPage?' More posts are available; totals cover loaded posts only.':result.coverage==='partial'?' Coverage excludes channels whose reads were rejected.':' All available Buffer posts for these connected channels are loaded.'}</p>
        <div className="analytics-kpis"><div className="analytics-kpi"><small>Published posts loaded</small><strong>{result.successfulChannels===0?'Not loaded':posts.length}</strong><small>{refreshed} with refreshed metrics</small></div>{reportedMetrics.slice(0,5).map(([key,label])=>{const m=totalMetric(posts,key);return <div className="analytics-kpi" key={key}><small>{label}</small><strong>{count(m.value)}</strong><small>Reported for {m.covered} of {posts.length} posts</small></div>;})}
          </div>
        {!result.accounts.length&&<p className="notice">No Buffer channels are linked to this client. Link the client’s accounts in Content Studio to load their stats.</p>}
        <div className="analytics-data-health"><span className={"status-pill "+(result.channelErrors?.length?"paused":result.accounts.length?"active":"")}>{result.accounts.length?result.successfulChannels===0?"Post reads blocked":result.channelErrors?.length?"Partial channel access":"Buffer post access verified":"No linked channels"}</span><span>{result.accounts.length} linked channels · {refreshed} of {posts.length} posts with refreshed metrics</span><a href="https://publish.buffer.com/" target="_blank" rel="noopener noreferrer">Open Buffer</a></div>
        {!reportedMetrics.length&&posts.length>0&&<div className="notice analytics-missing"><strong>Posts are connected. Performance metrics have not been supplied yet.</strong><p>Buffer returned your published posts, but no refreshed metrics for this view. Check the channels in Buffer Insights and refresh later. Connecting Google Analytics enables separate website and attribution reporting.</p><a className="text-link" href={"#/reports/"+clientId+"/website"}>Set up website analytics</a></div>}
        <p className="muted">Only metrics supplied for these posts appear in the summaries. A dash means the network did not supply a refreshed value. Reported zeros remain zero.</p>
      </>}
    </section>
    {result&&<section className="panel form-section"><h2>Channel breakdown</h2><div className="table-scroll"><table><thead><tr><th>Channel</th><th>Access</th><th>Loaded posts</th>{reportedMetrics.map(([key,label])=><th key={key}>{label}</th>)}</tr></thead>
      <tbody>{result.accounts.filter(a=>!channel||a.buffer_channel_id===channel).map(account=>{const rows=posts.filter(post=>post.channelId===account.buffer_channel_id);const denied=result.channelErrors?.find(e=>e.account_id===account.id);return <tr key={account.id}><td>{account.name}<small>{account.platform}</small></td><td>{denied?<><span className="status-pill paused">Read unavailable</span><small>{denied.message}</small></>:<span className="status-pill active">Readable</span>}</td><td>{denied?'—':rows.length}</td>{reportedMetrics.map(([key])=>{const m=totalMetric(rows,key);return <td key={key}>{count(m.value)}<small>{m.covered}/{rows.length} posts reporting</small></td>;})}</tr>;})}</tbody></table></div></section>}
    {result&&<section className="panel form-section"><div className="calendar-controls"><h2>Post performance</h2><label>Sort by<select value={sort} onChange={e=>setSort(e.target.value)}><option value="recent">Most recent</option><option value="views">Views</option><option value="impressions">Impressions</option><option value="clicks">Post clicks</option><option value="engagement">Recorded interactions</option></select></label></div>
      <p className="muted">Recorded interactions sum available reactions, comments, shares, reposts and saves. Coverage differs by network; expand a post to see every metric supplied.</p>
      {posts.length?<div className="table-scroll"><table><thead><tr><th>Post</th><th>Channel</th>{reportedMetrics.map(([key,label])=><th key={key}>{label}</th>)}<th>Interactions</th><th>Metrics updated</th></tr></thead><tbody>{sorted.map(post=>{const account=result.accounts.find(a=>a.buffer_channel_id===post.channelId);const link=safePostLink(post.externalLink);const rate=metricValue(post,'engagementRate');return <tr key={post.id}>
        <td className="performance-post">{link?<a href={link} target="_blank" rel="noopener noreferrer">{post.text.slice(0,160)||'Published post'}</a>:<strong>{post.text.slice(0,160)||'Published post'}</strong>}<small>{post.sentAt?displayDate(post.sentAt):'Publish time unavailable'}</small>
          <details><summary>All supplied metrics</summary>{post.metricsUpdatedAt&&post.metrics?.length?post.metrics.map(m=><p key={m.type}>{m.name}: {count(m.value)}{m.unit==='percentage'?'%':''}</p>):<p>Buffer has not supplied refreshed metrics for this post.</p>}</details></td>
        <td>{account?.name??'Connected channel'}<small>{account?.platform}</small></td>{reportedMetrics.map(([key])=><td key={key}>{count(metricValue(post,key))}</td>)}<td>{count(engagement(post))}</td><td>{post.metricsUpdatedAt?displayDate(post.metricsUpdatedAt):'Not supplied yet'}</td>
      </tr>;})}</tbody></table></div>:<p className="empty">{result.successfulChannels===0?'Buffer did not allow post reads for these channels. Check each channel’s access result above.':'No published posts match this view.'}</p>}
      {result.pageInfo.hasNextPage&&<Button variant="outline" disabled={busy} onClick={()=>void load(true)}>{busy?'Loading…':'Load more posts'}</Button>}
    </section>}
  </div>;
}
