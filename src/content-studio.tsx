import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, FilePenLine, Plus, Sparkles, Upload, Images, ImagePlus, X, CalendarClock } from 'lucide-react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Button } from './components/ui/button';
import { displayDate, supabase } from './data';
import { mediaAccept,saveMedia,signedMedia, type Asset } from './media-data';
import {xCaptionStatus} from './x-caption';
import {editorCaption,inferredFormat} from './manual-post';
import {XCaptionVersion,type XVariant} from './x-caption-version';
import {isX} from './x-caption';
import {nairobiDay,nairobiTime} from './calendar-dates';
import { PublishingPanel,publishingAction } from './publishing';
import {contentLifecycle,type ContentDelivery,type Lifecycle} from './content-lifecycle';

const platforms = ['Facebook','Instagram','LinkedIn','TikTok','Other'];
const formats = ['Image Post','Poster','Carousel','Reel Idea','Video Script','Story','Promotional Announcement','Educational Post'];
const goals = ['Brand Awareness','Lead Generation','Sales','Engagement','Event Promotion','Customer Education','Website Traffic'];
const languages = ['Professional English','Kenyan English','English and Swahili','Sheng and English'];
const statuses = { draft:'Draft', pending_approval:'Needs review', approved:'Approved' };
type Status = keyof typeof statuses;
type Client = {id:string; business_name:string; status:string};
type Draft = {
  id:string; client_id:string; status:Status; revision:number; updated_at:string;
  publishing_deliveries?:(ContentDelivery&{account_id:string;external_post_id:string|null})[];
  title:string; caption:string; hashtags:string; call_to_action:string; visual_concept:string;
  suggested_date:string|null; suggested_time:string|null; platform:string; format:string; media_asset_id:string|null; content_origin:'manual'|'ai'|'unclassified'; scheduled_at:string|null; schedule_cancelled_at:string|null;
};
type StudioView = 'list' | 'generate' | 'new' | 'edit';
const pageSize = 12;

const monthlyBrief = 'Create one idea for each topic: digital marketing, social media management, website development, branding, local business growth, lead generation, online advertising, customer engagement, automation, marketing education, client success stories only if verified, and TSOLS service promotion.';

function Options({name,label,items,value}: {name:string;label:string;items:string[];value?:string}) {
  return <label>{label}<select name={name} defaultValue={value}>{items.map(item => <option key={item}>{item}</option>)}</select></label>;
}

export function ContentStudio({agencyId,initialClientId,initialItem,initialDay}: {agencyId:string;initialClientId?:string;initialItem?:string;initialDay?:string}) {
  const [clients,setClients] = useState<Client[]>();
  const [clientId,setClientId] = useState('');
  const [drafts,setDrafts] = useState<Draft[]>([]);
  const [view,setView] = useState<StudioView>(initialItem==='new'?'new':'list');
  const [draft,setDraft] = useState<Draft>();
  const editorForm=useRef<HTMLFormElement>(null);
  const [planDate,setPlanDate]=useState(initialDay??nairobiDay());
  const [planTime,setPlanTime]=useState('');
  const [hasXAccounts,setHasXAccounts]=useState(false);
  const [xSelected,setXSelected]=useState(false);
  const [prepareX,setPrepareX]=useState(false);
  const [xVariant,setXVariant]=useState<XVariant|null>(null);
  useEffect(()=>{
    const active=draft?.schedule_cancelled_at?null:draft?.scheduled_at;
    if(active){setPlanDate(nairobiDay(active));setPlanTime(nairobiTime(active));}
    else {if(draft?.suggested_date)setPlanDate(draft.suggested_date);if(draft?.suggested_time)setPlanTime(draft.suggested_time.slice(0,5));}
  },[draft?.id]);
  useEffect(()=>{let active=true;setHasXAccounts(false);setXSelected(false);if(clientId)void supabase?.from('publishing_accounts').select('platform').eq('client_id',clientId).eq('active',true).then(r=>{if(active)setHasXAccounts(Boolean(r.data?.some(a=>isX(a.platform))));});return()=>{active=false;};},[clientId]);
  const [xPreview,setXPreview]=useState<string|null>(null);
  useEffect(()=>setXPreview(null),[draft?.id,draft?.revision]);
  const xCount=xCaptionStatus(xPreview??editorCaption(draft?.caption,draft?.hashtags,draft?.call_to_action));
  const [loading,setLoading] = useState(true);
  const [pending,setPending] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [status,setStatus] = useState<Lifecycle | 'needs_review' | ''>(initialItem==='review'?'needs_review':'');
  const [page,setPage] = useState(0);
  const [count,setCount] = useState(0);
  const [refresh,setRefresh] = useState(0);
  const [warning,setWarning] = useState('');
  const [notice,setNotice] = useState('');
  const [variationCount,setVariationCount] = useState(12);
  const [direction,setDirection] = useState('');
  const [assets,setAssets] = useState<Asset[]>([]);
  const [attachment,setAttachment] = useState('');
  const [preview,setPreview] = useState('');
  const [upload,setUpload] = useState<File>();
  const [uploadKey,setUploadKey] = useState(0);
  const mediaPicker=useRef<HTMLDialogElement>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const [mediaTab,setMediaTab]=useState<'choose'|'library'>('choose');
  const [mediaSearch,setMediaSearch]=useState('');
  const [uploadPreview,setUploadPreview]=useState('');
  useEffect(()=>{if(!upload){setUploadPreview('');return;}const url=URL.createObjectURL(upload);setUploadPreview(url);return()=>URL.revokeObjectURL(url);},[upload]);
  function openMedia(){setMediaTab('choose');setMediaSearch('');mediaPicker.current?.showModal();}
  function chooseAsset(id:string){setAttachment(id);setUpload(undefined);setUploadKey(k=>k+1);setDirty(true);mediaPicker.current?.close();}

  const manual = !draft || draft.content_origin==='manual';
  const attachmentType=assets.find(asset=>asset.id===attachment)?.mime_type;
  const current = clients?.find(item => item.id === clientId);
  const canWrite = Boolean(current && current.status !== 'archived');

  useEffect(() => {
    let active = true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name')
      .then(result => {
        if (!active) return;
        if (result.error) setWarning('Could not load clients for Content Studio.');
        setClients(result.data ?? []);
        setClientId(result.data?.find(client => client.id === initialClientId)?.id ?? result.data?.find(client => client.status !== 'archived')?.id ?? result.data?.[0]?.id ?? '');
        setLoading(Boolean(result.data?.length));
      });
    return () => {active = false;};
  },[agencyId,initialClientId]);

  useEffect(() => {
    if (!supabase || !clientId) return;
    let active = true;
    setLoading(true);
    const db=supabase;
    void (async()=>{
      let filteredIds:string[]|undefined;
      if(status&&status!=='needs_review'){
        filteredIds=[];
        // Classify the current revision before paginating so filters and totals agree.
        for(let offset=0;active;offset+=500){
          const summary=await db.from('content_calendar').select('id,revision,publishing_deliveries(revision,status,provider_status,account_id,external_post_id)').eq('client_id',clientId).order('id').range(offset,offset+499);
          if(summary.error)throw summary.error;
          filteredIds.push(...summary.data.filter(item=>contentLifecycle(item).key===status).map(item=>item.id));
          if(summary.data.length<500)break;
        }
        if(!active)return;
        if(!filteredIds.length){setDrafts([]);setCount(0);setLoading(false);return;}
      }
      let query=db.from('content_calendar').select('*,publishing_deliveries(revision,status,provider_status,account_id,external_post_id)',{count:'exact'}).eq('client_id',clientId);
      if(status==='needs_review')query=query.neq('status','approved').neq('content_origin','manual');
      if(filteredIds)query=query.in('id',filteredIds);
      const result=await query.order('updated_at',{ascending:false}).order('id').range(page*pageSize,(page+1)*pageSize-1);
      if(!active)return;
      if(result.error)throw result.error;
      setDrafts(result.data as Draft[]);setCount(result.count??0);setLoading(false);
    })().catch(()=>{if(active){setLoading(false);setDrafts([]);setCount(0);setWarning('Could not load content and publishing statuses.');}});
    return () => {active = false;};
  },[clientId,status,page,refresh]);

  const checkedDeliveries=useRef(new Map<string,number>());
  useEffect(()=>{
    if(view!=='list')return;
    const candidates=drafts.map(item=>({item,ids:(item.publishing_deliveries??[]).filter(r=>r.revision===item.revision&&r.external_post_id&&!['sent','cancelled','error'].includes(r.provider_status??'')).map(r=>r.account_id)})).filter(({item,ids})=>ids.length&&Date.now()-(checkedDeliveries.current.get(item.id+':'+item.revision)??0)>60000);
    if(!candidates.length)return;
    let active=true;
    for(const {item} of candidates)checkedDeliveries.current.set(item.id+':'+item.revision,Date.now());
    void Promise.allSettled(candidates.map(async({item,ids})=>{
      const results=[];
      for(let i=0;i<ids.length;i+=8)results.push(...await publishingAction('sync',item,ids.slice(i,i+8)));
      return results.some(r=>r.provider_status!==item.publishing_deliveries?.find(old=>old.revision===r.revision&&old.account_id===r.account_id)?.provider_status);
    })).then(results=>{if(!active)return;if(results.some(r=>r.status==='fulfilled'&&r.value))refreshList();if(results.some(r=>r.status==='rejected'))setWarning('Some Buffer statuses could not be refreshed. Showing the last confirmed results.');});
    return()=>{active=false;};
  },[drafts,view]);

  useEffect(() => {
    if(!supabase||!initialItem||initialItem==='new'||initialItem==='review'||!clientId)return;
    let active=true;
    void supabase.from('content_calendar').select('*').eq('id',initialItem).eq('client_id',clientId).maybeSingle().then(result=>{
      if(!active)return;
      if(result.error||!result.data){setWarning('Could not open the requested draft.');return;}
      const item=result.data as Draft;
      setDraft(item);setAttachment(item.media_asset_id??'');setView('edit');
    });
    return ()=>{active=false;};
  },[clientId,initialItem]);

  useEffect(() => {
    if(!supabase||!clientId||(view!=='new'&&view!=='edit'))return;
    let active=true;
    const db=supabase;
    const savedAsset=draft?.media_asset_id;
    void Promise.all([
      db.from('media_assets').select('*').eq('client_id',clientId).order('created_at',{ascending:false}).limit(100),
      savedAsset ? db.from('media_assets').select('*').eq('id',savedAsset).eq('client_id',clientId).maybeSingle() : Promise.resolve({data:null,error:null}),
    ]).then(([result,existing])=>{
      if(!active)return;
      if(result.error||existing.error){setWarning('Could not load media attachments.');return;}
      setAssets(existing.data&&!result.data.some(item=>item.id===existing.data?.id)?[existing.data,...result.data]:result.data);
    });
    return ()=>{active=false;};
  },[clientId,view,draft?.media_asset_id]);

  useEffect(() => {
    let active=true;
    setPreview('');
    const item=assets.find(asset=>asset.id===attachment);
    if(item)void signedMedia([item.object_path]).then(urls=>{
      if(active)setPreview(urls[item.object_path]??'');
    }).catch(()=>{});
    return ()=>{active=false;};
  },[assets,attachment]);

  function changeView(next: StudioView, item?: Draft) {
    setWarning('');
    setNotice('');
    setDraft(item);
    setAttachment(item?.media_asset_id ?? '');
    setUpload(undefined);
    setDirty(false);
    setView(next);
  }

  function refreshList() {
    setRefresh(previous => previous+1);
  }

  async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();await saveContent();}

  async function saveContent():Promise<Draft|null> {
    if (!supabase || pending || !canWrite || !editorForm.current) return null;
    if(!editorForm.current.reportValidity())return null;
    if(draft&&!dirty&&!upload)return draft;
    const form = new FormData(editorForm.current);
    const field = (name:string) => String(form.get(name) ?? '').trim();
    const fields = {
      title:field('title'),platform:manual?'Other':field('platform'),format:manual?inferredFormat(Boolean(upload||attachment),upload?.type||attachmentType,attachment===draft?.media_asset_id?draft?.format:undefined):field('format'),caption:field('caption'),
      hashtags:'',call_to_action:'',visual_concept:manual?(draft?.visual_concept??''):field('visual_concept'),
      suggested_date:draft?.suggested_date??planDate??null,suggested_time:draft?.suggested_time??(planTime||null),media_asset_id:attachment || null,
    };
    if(fields.caption.length>6000){setWarning('Shorten the caption, including its hashtags, to 6,000 characters before saving.');return null;}
    if (!fields.title) {setWarning('Enter a post title.');return null;}
    if (manual && !fields.caption && !attachment && !upload) {setWarning('Add a caption or attach media before saving.');return null;}
    if (fields.suggested_time && !fields.suggested_date) {setWarning('Choose a date for the suggested time.');return null;}
    setPending(true);
    setWarning('');
    setNotice('');
    try {
      if(upload){
        const mediaId=await saveMedia(clientId,upload,upload.name,'upload');
        fields.media_asset_id=mediaId;
        setAttachment(mediaId);
        setUpload(undefined);
        setUploadKey(value=>value+1);
      }
      const result = draft
        ? await supabase.from('content_calendar').update(fields).eq('id',draft.id).eq('updated_at',draft.updated_at).select().maybeSingle()
        : await supabase.from('content_calendar').insert({...fields,client_id:clientId,content_origin:'manual'}).select().single();
      if (result.error || !result.data) {setWarning(result.error?.code==='P0001'?result.error.message:'Could not save. Reopen the draft if it was changed elsewhere.');return null;}
      setDraft(result.data as Draft);
      setDirty(false);
      setView('edit');
      setNotice(manual?'Manual post saved and ready to publish.':'Draft changes saved.');
      refreshList();
      return result.data as Draft;
    } catch(failure) {
      setWarning(failure instanceof Error?failure.message:'Could not upload and save the post.');
      return null;
    } finally {setPending(false);}
  }

  async function advance(next: Status) {
    if (!supabase || !draft || draft.content_origin==='manual' || pending || dirty || !canWrite) return;
    if (next !== 'draft' && !draft.caption.trim()) {setWarning('Save a caption before approving the draft.');return;}
    setPending(true);
    setWarning('');
    setNotice('');
    try {
      const result = await supabase.from('content_calendar').update({status:next}).eq('id',draft.id)
        .eq('updated_at',draft.updated_at).select().maybeSingle();
      if (result.error || !result.data) {setWarning(result.error?.code === 'P0001' ? result.error.message : 'Could not change status. Reopen the draft if it was changed elsewhere.');return;}
      setDraft(result.data as Draft);
      setNotice(`Revision ${result.data.revision} · ${statuses[next]}`);
      refreshList();
    } finally {setPending(false);}
  }

  async function markManual() {
    if(!supabase||!draft||draft.content_origin!=='unclassified'||draft.status==='approved'||dirty||pending||!canWrite)return;
    if(!window.confirm('Mark this older draft as manually written? It will skip review.'))return;
    setPending(true);setWarning('');setNotice('');
    try {
      const result=await supabase.from('content_calendar').update({content_origin:'manual'}).eq('id',draft.id)
        .eq('updated_at',draft.updated_at).select().maybeSingle();
      if(result.error||!result.data){setWarning(result.error?.code==='P0001'?result.error.message:'Could not mark this draft as manual. Reopen it and try again.');return;}
      setDraft(result.data as Draft);
      setNotice(result.data.status==='approved'?'Marked as manual and ready to publish.':'Marked as manual. Add a caption or media and save.');
      refreshList();
    }finally{setPending(false);}
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || pending || !canWrite) return;
    const brief = Object.fromEntries(new FormData(event.currentTarget));
    setPending(true);
    setWarning('');
    try {
      const result = await supabase.functions.invoke<{count:number}>('generate-content',{
        body:{...brief,count:Number(brief.count),client_id:clientId},
      });
      if (result.error) {
        const detail = result.error instanceof FunctionsHttpError ? await result.error.context.json().catch(() => null) : null;
        setWarning(detail?.message ?? 'Generation is unavailable. Refresh the draft list before retrying.');
        return;
      }
      if (!result.data) {setWarning('Could not confirm the batch. Refresh the draft list before retrying.');return;}
      changeView('list');
      setStatus('draft');
      setPage(0);
      refreshList();
      setNotice(`${result.data.count} drafts saved for review.`);
    } finally {setPending(false);}
  }

  return <>
    {view !== 'list' && <button className="text-link back-link" disabled={pending} onClick={() => changeView('list')}><ArrowLeft size={16}/> All drafts</button>}
    <header className="page-heading"><div><h1>{view === 'generate' ? 'Generate drafts' : view === 'new' ? 'New manual post' : view === 'edit' ? manual ? 'Edit manual post' : 'Edit draft' : 'Content Studio'}</h1>
      <p>{view === 'list' ? 'Write and publish manual posts or generate AI drafts for review.' : current?.business_name}</p></div>
      {view === 'list' && <div className="studio-actions">
        <Button variant="outline" disabled={!canWrite} onClick={() => changeView('new')}><Plus size={18}/ > New manual post</Button>
        <Button disabled={!canWrite} onClick={() => changeView('generate')}><Sparkles size={17}/> Generate drafts</Button>
      </div>}
    </header>
    {warning && <p className="notice error" role="alert">{warning}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {view === 'list' && <section className="panel">
      <div className="table-tools studio-filters">
        <label>Client<select value={clientId} onChange={event => {setClientId(event.target.value);setPage(0);setNotice('');setWarning('');}}>
          {!clients?.length && <option value="">No clients</option>}
          {clients?.map(client => <option key={client.id} value={client.id}>{client.business_name}{client.status==='archived' ? ' (archived)' : ''}</option>)}
        </select></label>
        <label>Status<select value={status} onChange={event => {setStatus(event.target.value as Lifecycle | 'needs_review' | '');setPage(0);}}>
          <option value="">All statuses</option><option value="needs_review">Review queue</option><option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="published">Published</option>
        </select></label>
      </div>
      {loading ? <p className="empty" role="status">Loading drafts…</p> : !drafts.length ? <p className="empty">{current ? 'No drafts match this view.' : 'Add a client before creating content.'}</p>
        : <div className="table-scroll"><table><thead><tr><th scope="col">Post</th><th scope="col">Channel</th><th scope="col">Status</th><th scope="col">Last update</th></tr></thead>
          <tbody>{drafts.map(item => <tr key={item.id}><td><button className="text-link" onClick={() => changeView('edit',item)}><FilePenLine size={15}/>{item.title}</button></td>
            <td>{item.platform}<small>{item.format}</small></td><td><span className={`status-pill ${contentLifecycle(item).key==='published'?'active':contentLifecycle(item).key==='scheduled'?'scheduled':''}`}>{contentLifecycle(item).label}</span>{contentLifecycle(item).detail&&<small>{contentLifecycle(item).detail}</small>}</td>
            <td>{displayDate(item.updated_at)}</td></tr>)}</tbody></table></div>}
      {count > pageSize && <div className="pagination"><span>{page*pageSize+1}–{Math.min((page+1)*pageSize,count)} of {count} drafts</span>
        <Button variant="outline" aria-label="Previous page" disabled={loading || !page} onClick={() => setPage(page-1)}><ChevronLeft size={17}/></Button>
        <Button variant="outline" aria-label="Next page" disabled={loading || (page+1)*pageSize>=count} onClick={() => setPage(page+1)}><ChevronRight size={17}/></Button></div>}
    </section>}

    {view === 'generate' && <form className="panel form-section" onSubmit={generate}>
      <fieldset disabled={pending}>
        <div className="studio-generate-heading"><div><h2>Generation brief</h2><p className="muted">OpenAI receives the brief you enter. The results are saved under the selected client for review.</p></div>
          {current?.business_name === 'Thagana Solutions' && <Button variant="outline" type="button" onClick={() => {setVariationCount(12);setDirection(monthlyBrief);}}>Use 12-topic brief</Button>}
        </div>
        <div className="form-grid">
          <Options name="platform" label="Platform" items={platforms}/><Options name="format" label="Format" items={formats}/>
          <Options name="goal" label="Marketing goal" items={goals}/><Options name="language" label="Language" items={languages} value="Kenyan English"/>
          <label>Product or service<input name="service" maxLength={1000}/></label><label>Target audience<input name="audience" maxLength={1000}/></label>
          <label>Tone<input name="tone" maxLength={1000}/></label><label>Verified promotional offer<input name="offer" maxLength={1000}/></label>
          <label>Preferred call to action<input name="action" maxLength={1000}/></label><label>Number of drafts<input name="count" type="number" min={1} max={12} value={variationCount} required
            onChange={event => setVariationCount(Number(event.target.value))}/></label>
          <label className="form-wide">Public brand context<textarea name="public_context" maxLength={1000} rows={3} placeholder="Public business name, services, and brand voice"/></label>
          <label className="form-wide">Topic or creative direction<textarea name="direction" maxLength={1000} rows={4} value={direction} onChange={event => setDirection(event.target.value)}/></label>
        </div>
        <div className="form-actions"><Button type="submit"><Sparkles size={17}/>{pending ? 'Generating drafts…' : 'Send brief to OpenAI'}</Button></div>
      </fieldset>
    </form>}

    {(view === 'new' || view === 'edit') && <div className="studio-workbench">
      <div className="studio-creative-banner"><div><span className="studio-eyebrow">TSOLS CONTENT STUDIO</span><h2>Make your next post matter.</h2><p>{current?.business_name} · {manual?'Manual post':'AI assisted draft'}</p></div><div className="studio-workflow-labels"><span className="current"><FilePenLine size={16}/> Compose</span><span><Sparkles size={16}/> Refine for X</span><span><CalendarClock size={16}/> Schedule</span></div></div>
      <form ref={editorForm} id="studio-post-editor" className="panel form-section studio-composer" key={draft?.id ?? 'new'} onSubmit={save} onChange={event => {if(mediaPicker.current?.contains(event.target as Node))return;setNotice('');setDirty(true);const data=new FormData(event.currentTarget);setXPreview(String(data.get('caption')??''));}}>
      <div className="composer-heading"><div><span className="studio-eyebrow">THE STORY</span><h2>Compose your post</h2></div>{draft && <p className="studio-revision"><span className="status-pill">{draft.status==='approved'&&manual?'Ready':statuses[draft.status]}</span> Revision {draft.revision}</p>}</div>
      <fieldset disabled={pending || !canWrite}>
        <div className="form-grid">
          <label className="form-wide">Title<input name="title" defaultValue={draft?.title} maxLength={180} required/></label>
          {!manual&&<><Options name="platform" label="Platform" items={platforms} value={draft?.platform}/><Options name="format" label="Format" items={formats} value={draft?.format}/></>}
          <label className="form-wide">Caption<textarea name="caption" rows={6} maxLength={6000} defaultValue={editorCaption(draft?.caption,draft?.hashtags,draft?.call_to_action)} placeholder="Write your complete caption here, including any hashtags."/></label>
          <div className="composer-caption-meta form-wide"><span>Hashtags and links go in your caption</span><span>{xCount.length} weighted characters for X</span></div>
          <div className="composer-media form-wide">
            <div className="composer-media-heading"><div><span className="studio-eyebrow">THE VISUAL</span><h3>Give your post a presence</h3></div><Button type="button" variant="outline" onClick={openMedia}><ImagePlus size={18}/>{upload||attachment?'Change file':'Add file'}</Button></div>
            {upload||attachment?<div className="composer-attachment">
              {(uploadPreview||preview)&&((upload?.type??attachmentType)==='video/mp4'?<video src={uploadPreview||preview} controls preload="metadata" aria-label="Attached video"/>:<img src={uploadPreview||preview} alt="Post attachment preview"/>)}
              <div><strong>{upload?.name??assets.find(a=>a.id===attachment)?.name??'Attached media'}</strong><span>{upload?'Ready to upload':'From your media library'}</span></div>
              <Button type="button" variant="outline" onClick={()=>chooseAsset('')} aria-label="Remove attachment"><X size={17}/></Button>
            </div>:<button type="button" className="composer-media-empty" onClick={openMedia}><span className="media-empty-icon"><Images size={26}/></span><strong>Add an image or video</strong><span>Upload a file or choose from your media library</span></button>}
          </div>
          <input ref={fileInput} hidden key={uploadKey} type="file" accept={mediaAccept} onChange={event=>{const file=event.target.files?.[0];if(file){setUpload(file);setDirty(true);mediaPicker.current?.close();}}}/>
          <dialog ref={mediaPicker} onKeyDown={e=>{if(e.key==='Enter'&&e.target instanceof HTMLInputElement)e.preventDefault();}} className="studio-media-dialog" aria-labelledby="media-picker-title">
            <div className="media-picker-heading"><div><span className="studio-eyebrow">YOUR CREATIVE ASSETS</span><h2 id="media-picker-title">Add a file</h2></div><Button type="button" variant="outline" aria-label="Close media picker" onClick={()=>mediaPicker.current?.close()}><X size={19}/></Button></div>
            {mediaTab==='choose'?<div className="media-source-options"><button type="button" onClick={()=>fileInput.current?.click()}><Upload size={26}/><strong>Upload from device</strong><span>JPG, PNG, WebP up to 8 MB<br/>MP4 video up to 50 MB</span></button><button type="button" onClick={()=>setMediaTab('library')}><Images size={26}/><strong>Choose from library</strong><span>Reuse media saved for<br/>{current?.business_name}</span></button></div>:<><button type="button" className="text-link" onClick={()=>setMediaTab('choose')}><ArrowLeft size={16}/> File sources</button><label className="media-search">Search your library<input value={mediaSearch} onChange={e=>{e.stopPropagation();setMediaSearch(e.target.value);}} placeholder="Search by file name"/></label><div className="media-asset-list">{assets.filter(a=>a.name.toLowerCase().includes(mediaSearch.toLowerCase())).map(asset=><button type="button" key={asset.id} onClick={()=>chooseAsset(asset.id)}><span className="media-asset-icon">{asset.mime_type==='video/mp4'?<FilePenLine size={21}/>:<Images size={21}/>}</span><span><strong>{asset.name}</strong><small>{asset.mime_type==='video/mp4'?'Video':'Image'}{!asset.approved_at&&!manual?' · Needs review':''}</small></span><Plus size={18}/></button>)}{!assets.filter(a=>a.name.toLowerCase().includes(mediaSearch.toLowerCase())).length&&<p className="empty">{assets.length?'No files match your search.':'No media yet. Upload your first file.'}</p>}</div></>}
          </dialog>
          {!manual&&<label className="form-wide">Visual concept<textarea name="visual_concept" rows={3} maxLength={2000} defaultValue={draft?.visual_concept}/></label>}

        </div>
        {draft?.status === 'approved' && <p className="muted">{manual?'Manual posts are ready when saved.':'Changes create a new draft revision and require fresh approval.'} <a className="text-link" href={`#/calendar/${clientId}`}>Open calendar</a></p>}
        {dirty && draft && <p className="muted">{manual?'Use the save actions below X review to save this post or send it to Buffer.':'Save your changes before moving this revision through approval.'}</p>}
        <div className="form-actions studio-actions">
          {!manual && draft && draft.status !== 'approved' && <>
            {draft.content_origin==='unclassified'&&<Button variant="outline" type="button" disabled={dirty} onClick={()=>void markManual()}>Mark as manual</Button>}
            <Button variant="outline" type="button" disabled={dirty||!draft.caption.trim()} onClick={() => advance('approved')}><Check size={17}/> Approve draft</Button>
          </>}
        </div>
      </fieldset>
    </form>
    {hasXAccounts&&draft&&<><XCaptionVersion key={draft.id+':'+draft.revision} postId={draft.id} revision={draft.revision} approved={draft.status==='approved'} disabled={!canWrite||pending||dirty} autoGenerate={(xSelected||prepareX)&&xCount.over>0} onVariant={setXVariant}/>
      {dirty&&<Button variant="outline" disabled={!canWrite||pending} onClick={()=>{setPrepareX(true);void saveContent();}}>Update X preview from caption edits</Button>}</>}
    {hasXAccounts&&!draft&&<section className="panel form-section x-caption-version"><h3>X caption</h3><Button variant="outline" disabled={!canWrite||pending} onClick={()=>{setPrepareX(true);void saveContent();}}>Prepare X caption</Button></section>}
    {draft?<PublishingPanel key={draft.id} post={draft} disabled={!canWrite||pending} contentDirty={dirty} onSaveContent={saveContent} xVariant={xVariant} onXSelectionChange={setXSelected} date={planDate} time={planTime} onDateChange={setPlanDate} onTimeChange={setPlanTime}
      onPlanSaved={(plan,revision)=>setDraft(current=>current&&current.id===draft.id&&current.revision===(revision??draft.revision)?{...current,...plan}:current)}/>
      :<section className="panel form-section studio-schedule-start"><h2>Calendar planning · Nairobi time (EAT)</h2><div className="form-grid"><label>Publishing date<input type="date" value={planDate} min={nairobiDay()} onChange={e=>setPlanDate(e.target.value)}/></label><label>Publishing time (EAT)<input type="time" value={planTime} onChange={e=>setPlanTime(e.target.value)}/></label></div><div className="form-actions"><Button disabled={!canWrite||pending} onClick={()=>void saveContent()}>{pending?'Preparing…':'Continue to destination accounts'}</Button></div></section>}
    </div>}
  </>;
}
