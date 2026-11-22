import {useEffect,useState} from 'react';
import {Button} from './components/ui/button';
import {supabase} from './data';
import {trackedLink} from './website-analytics-model';
export function TrackedLinkBuilder({clientId,postId}:{clientId:string;postId?:string}){
 const [url,setUrl]=useState(''),[source,setSource]=useState('instagram'),[campaign,setCampaign]=useState('content'),[post,setPost]=useState(postId??'');
 const [posts,setPosts]=useState<{id:string;title:string}[]>([]),[message,setMessage]=useState('');
 useEffect(()=>{let active=true;void supabase?.from('clients').select('website').eq('id',clientId).maybeSingle().then(r=>{if(active)setUrl(r.data?.website??'');});if(!postId)void supabase?.from('content_calendar').select('id,title').eq('client_id',clientId).order('updated_at',{ascending:false}).limit(100).then(r=>{if(active)setPosts(r.data??[]);});return()=>{active=false;};},[clientId,postId]);
 let link='';try{link=trackedLink(url,source,campaign,post);}catch{/* incomplete fields */}
 return <details className="panel form-section tracked-link"><summary>Organic tracking link</summary><p>Use this link in the saved caption or call to action before publishing. It identifies this post in GA4 using the saved post ID. Existing untagged posts cannot be attributed retroactively.</p>
 <div className="calendar-filters"><label>Destination URL<input type="url" value={url} onChange={e=>setUrl(e.target.value)}/></label><label>Source<select value={source} onChange={e=>setSource(e.target.value)}>{['instagram','facebook','linkedin','twitter','tiktok','youtube','other'].map(s=><option key={s}>{s}</option>)}</select></label><label>Campaign<input value={campaign} maxLength={100} onChange={e=>setCampaign(e.target.value)}/></label>
 {!postId&&<label>Saved post<select value={post} onChange={e=>setPost(e.target.value)}><option value="">Choose a post</option>{posts.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}</div>
 {link&&<label>Tagged URL<textarea readOnly value={link} rows={3}/></label>}<Button type="button" variant="outline" disabled={!link} onClick={()=>void navigator.clipboard.writeText(link).then(()=>setMessage('Link copied. Paste it into the caption or call to action and save.'),()=>setMessage('Select and copy the tagged URL above.'))}>Copy tracking link</Button>{message&&<p role="status">{message}</p>}
 <p className="muted">GA4 must be installed on the destination website. Mark meaningful actions such as a successful enquiry or purchase as key events in GA4. An Instagram caption link is not clickable; use a clickable bio, story or other supported link placement.</p></details>;
}
