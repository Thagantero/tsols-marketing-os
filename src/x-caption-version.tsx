import {useEffect,useRef,useState} from 'react';
import {Button} from './components/ui/button';
import {supabase} from './data';
import {edgeMessage} from './publishing';
import {xCaptionStatus} from './x-caption';
export type XVariant={content_id:string;revision:number;caption:string;status:'draft'|'approved';updated_at:string;approved_at:string|null};
export function XCaptionVersion({postId,revision,approved,disabled,autoGenerate,onVariant}:{postId:string;revision:number;approved:boolean;disabled:boolean;autoGenerate:boolean;onVariant:(variant:XVariant|null)=>void}){
 const [variant,setVariant]=useState<XVariant|null>(null),[text,setText]=useState(''),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const attempted=useRef(false),alive=useRef(true);
 const count=xCaptionStatus(text),dirty=text!==(variant?.caption??'');
 function accept(v:XVariant){if(!alive.current)return;setVariant(v);setText(v.caption);onVariant(v);}
 useEffect(()=>{alive.current=true;let active=true;void supabase?.from('content_x_captions').select('*').eq('content_id',postId).eq('revision',revision).maybeSingle().then(r=>{if(!active)return;if(r.error)setError('Could not load the saved X version.');else if(r.data)accept(r.data as XVariant);setLoaded(true);});return()=>{active=false;alive.current=false;};},[postId,revision]);
 async function generate(regenerate=false){
  if(busy||disabled||variant?.status==='approved')return;attempted.current=true;setBusy(true);setError('');setNotice('');
  try{const r=await supabase!.functions.invoke<{variant:XVariant;message?:string}>('shorten-x-caption',{body:{post_id:postId,revision,...(regenerate?{regenerate:true,expected_updated_at:variant?.updated_at}:{})}});if(r.error)throw new Error(await edgeMessage(r.error,'Could not rewrite the X caption.'));if(!r.data?.variant)throw new Error('No X version was returned.');accept(r.data.variant);if(alive.current)setNotice('X caption ready for review.');}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not rewrite the caption.');}finally{if(alive.current)setBusy(false);}
 }
 useEffect(()=>{if(loaded&&autoGenerate&&!variant&&!attempted.current&&!error&&!dirty)void generate();},[loaded,autoGenerate,variant,error,dirty,disabled]);
 async function save(){
  if(busy||disabled||!text.trim()||variant?.status==='approved')return;setBusy(true);setError('');setNotice('');
  try{const r=variant?await supabase!.from('content_x_captions').update({caption:text.trim()}).eq('content_id',postId).eq('revision',revision).eq('updated_at',variant.updated_at).select().maybeSingle():await supabase!.from('content_x_captions').insert({content_id:postId,revision,caption:text.trim()}).select().single();if(r.error||!r.data)throw new Error(r.error?.code==='P0001'?r.error.message:'Could not save the X version. Reopen it if it changed elsewhere.');accept(r.data as XVariant);setNotice('X version saved for review.');}catch(e){setError(e instanceof Error?e.message:'Could not save.');}finally{setBusy(false);}
 }
 async function approve(){
  if(busy||disabled||dirty||!approved||!count.valid||!variant||variant.status==='approved')return;setBusy(true);setError('');
  try{const r=await supabase!.from('content_x_captions').update({status:'approved'}).eq('content_id',postId).eq('revision',revision).eq('updated_at',variant.updated_at).select().maybeSingle();if(r.error||!r.data)throw new Error(r.error?.code==='P0001'?r.error.message:'Could not approve the X version. Reopen it if it changed.');accept(r.data as XVariant);setNotice('X caption approved.');}catch(e){setError(e instanceof Error?e.message:'Could not approve.');}finally{setBusy(false);}
 }
 return <section className="panel form-section x-caption-version"><h3>X caption</h3>
 {error&&<p className="notice error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}{busy&&<p role="status">Preparing the X version…</p>}
 <label>Complete caption for X<textarea rows={5} maxLength={6000} value={text} onChange={e=>setText(e.target.value)} disabled={disabled||busy||variant?.status==='approved'}/></label>
 <p aria-live="polite">{count.length} / 280 weighted characters · {variant?.status==='approved'?'Approved and locked':'Needs review'}{count.over?' · '+count.over+' over':''}</p>
 <div className="studio-actions"><Button type="button" variant="outline" disabled={disabled||busy||!loaded||dirty||variant?.status==='approved'} onClick={()=>void generate(Boolean(variant))}>{variant?'Regenerate X caption':'Generate short X caption'}</Button><Button type="button" variant="outline" disabled={disabled||busy||!text.trim()||!dirty||variant?.status==='approved'} onClick={()=>void save()}>Apply edits</Button><Button type="button" disabled={disabled||busy||!variant||dirty||!approved||!count.valid||variant.status==='approved'} onClick={()=>void approve()}>Approve X caption</Button></div>
 {!approved&&<p className="notice">Main post approval required.</p>}</section>;
}
