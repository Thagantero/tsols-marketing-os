import { useEffect,useRef,useState,type FormEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, CloudDownload, ImageIcon, Sparkles, Upload, Video } from 'lucide-react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Button } from './components/ui/button';
import { supabase } from './data';
import { driveConfigured,pickDriveImage,prepareDrive } from './drive-picker';
import { mediaAccept,loadBitmap,saveMedia,signedMedia,type Asset,type MediaClient } from './media-data';
import { posterSizes,renderPoster,type PosterRatio } from './poster-render';

const perPage=24;
const sourceLabels:Record<string,string>={upload:'Upload',drive:'Google Drive',poster:'Poster',ai_poster:'AI poster'};
type ImageOutput={image:string;model:string;usage:{input_tokens:number|null;output_tokens:number|null}};

export function MediaLibrary({agencyId}: {agencyId:string}) {
  const [clients,setClients]=useState<MediaClient[]>([]);
  const [client,setClient]=useState('');
  const [assets,setAssets]=useState<Asset[]>([]);
  const [posterAssets,setPosterAssets]=useState<Asset[]>([]);
  const [thumbnails,setThumbnails]=useState<Record<string,string>>({});
  const [selected,setSelected]=useState<Asset>();
  const [mode,setMode]=useState<'library'|'poster'>('library');
  const [page,setPage]=useState(0);
  const [count,setCount]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [driveReady,setDriveReady]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const upload=useRef<HTMLInputElement>(null);
  const modal=useRef<HTMLDialogElement>(null);
  const writable=clients.some(item=>item.id===client && item.status!=='archived');

  useEffect(()=>{
    let active=true;
    void supabase?.from('clients').select('id,business_name,status').eq('agency_id',agencyId).order('business_name')
      .then(result=>{
        if (!active) return;
        if (result.error) setError('Could not load clients.');
        setClients(result.data??[]);
        setClient(result.data?.find(item=>item.status!=='archived')?.id??result.data?.[0]?.id??'');
        setLoading(Boolean(result.data?.length));
      });
    if (driveConfigured) void prepareDrive().then(()=>{if(active)setDriveReady(true);}).catch(()=>{});
    return ()=>{active=false;};
  },[agencyId]);

  useEffect(()=>{
    if (!client || !supabase) return;
    let active=true;
    setLoading(true);
    setAssets([]);
    setThumbnails({});
    void supabase.from('media_assets').select('*',{count:'exact'}).eq('client_id',client)
      .order('created_at',{ascending:false}).order('id').range(page*perPage,(page+1)*perPage-1).then(async result=>{
        if (!active) return;
        setLoading(false);
        if (result.error) {setError('Could not load the media library.');return;}
        setAssets(result.data);
        setCount(result.count??0);
        try {
          const urls=await signedMedia(result.data.map(item=>item.object_path));
          if(active)setThumbnails(urls);
        } catch {if(active)setError('Images were listed, but previews failed.');}
      });
    return ()=>{active=false;};
  },[client,page,refresh]);

  useEffect(()=>{
    if (mode!=='poster' || !client || !supabase) return;
    let active=true;
    setPosterAssets([]);
    void supabase.from('media_assets').select('*').eq('client_id',client).neq('mime_type','video/mp4').order('created_at',{ascending:false}).limit(100)
      .then(result=>{if(active){if(result.error)setError('Could not load available poster photos.');else setPosterAssets(result.data);}});
    return ()=>{active=false;};
  },[mode,client]);

  async function perform(action:()=>Promise<void>) {
    if (busy || !writable) return;
    setBusy(true);setError('');setMessage('');
    try {await action();}
    catch (failure) {setError(failure instanceof Error ? failure.message : 'The media operation failed.');}
    finally {setBusy(false);}
  }

  function reloadMedia() {setPage(0);setRefresh(value=>value+1);}

  async function open(asset:Asset) {
    setSelected(asset);
    modal.current?.showModal();
    try {
      const urls=await signedMedia([asset.object_path]);
      setThumbnails(previous=>({...previous,...urls}));
    } catch {setError('Could not load the image preview.');}
  }

  return <>
    <header className="page-heading"><div><h1>{mode==='poster'?'Poster Studio':'Media Library'}</h1><p>{mode==='poster'?'Compose a poster with exact text, client photos and your logo.':'Upload medias and videos for a client.'}</p></div>
      <div className="studio-actions">
        {mode==='poster' ? <Button variant="outline" disabled={busy} onClick={()=>setMode('library')}>Back to library</Button> : <>
          <Button variant="outline" disabled={!writable||busy} onClick={()=>upload.current?.click()}><Upload size={16}/> Upload media</Button>
          <Button variant="outline" disabled={!writable||busy||!driveReady} onClick={()=>void perform(async()=>{
            const item=await pickDriveImage();
            if (!item) return;
            await saveMedia(client,item.file,item.name,'drive'); reloadMedia();setMessage('Drive image imported.');
          })}><CloudDownload size={16}/> Import from Drive</Button>
          <Button disabled={!writable||busy} onClick={()=>{setMode('poster');setError('');setMessage('');}}><Sparkles size={16}/> Create poster</Button>
        </>}
      </div></header>
    <input ref={upload} type="file" hidden accept={mediaAccept} onChange={event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value='';
      if(file)void perform(async()=>{await saveMedia(client,file,file.name,'upload');reloadMedia();setMessage('Media added to the library.');});
    }}/>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {message&&<p className="notice" role="status">{message}</p>}
    {mode==='library' ? <section className="panel form-section">
      <div className="media-toolbar"><label>Client<select value={client} disabled={busy} onChange={event=>{
        setClient(event.target.value);setPage(0);setCount(0);setError('');setMessage('');
      }}>
        {!clients.length&&<option value="">No clients</option>}
        {clients.map(item=><option key={item.id} value={item.id}>{item.business_name}{item.status==='archived'?' (archived)':''}</option>)}
      </select></label>
      {!driveConfigured&&<small className="muted">Drive import needs Google Cloud setup. You can upload images downloaded from Drive.</small>}
      {driveConfigured&&!driveReady&&<Button variant="outline" onClick={()=>void perform(async()=>{await prepareDrive();setDriveReady(true);})}>Load Drive picker</Button>}
      </div>
      {loading?<p className="empty" role="status">Loading images…</p>:!assets.length?<p className="empty">No media in this client’s library.</p>:
        <div className="media-grid">{assets.map(asset=><button type="button" key={asset.id} className="panel asset-card" onClick={()=>void open(asset)}>
          <span className="asset-thumb">{asset.mime_type==='video/mp4'?<Video size={26}/>:thumbnails[asset.object_path]?<img src={thumbnails[asset.object_path]} alt="" loading="lazy"/>:<ImageIcon size={26}/>}</span>
          <strong>{asset.name}</strong><small>{sourceLabels[asset.source]} · {asset.approved_at?'Approved':'Needs review'}</small>
        </button>)}</div>}
      {count>perPage&&<div className="pagination"><span>{page*perPage+1}–{Math.min(count,(page+1)*perPage)} of {count}</span>
        <Button variant="outline" disabled={page===0||loading} aria-label="Previous page" onClick={()=>setPage(page-1)}><ChevronLeft size={16}/></Button>
        <Button variant="outline" disabled={(page+1)*perPage>=count||loading} aria-label="Next page" onClick={()=>setPage(page+1)}><ChevronRight size={16}/></Button></div>}
    </section>:<PosterEditor key={client} client={client} assets={posterAssets} busy={busy} perform={perform}
      saved={()=>{setMode('library');reloadMedia();setMessage('Poster saved for review.');}}/>}
    <dialog ref={modal} className="panel confirmation media-dialog">
      {selected&&<><h2>{selected.name}</h2>
        {thumbnails[selected.object_path] ? (selected.mime_type==='video/mp4'
          ? <video src={thumbnails[selected.object_path]} controls preload="metadata" aria-label={selected.name}/>
          : <img src={thumbnails[selected.object_path]} alt={selected.name}/>) : <p>Media preview unavailable.</p>}
        <p>{selected.approved_at?'Approved':'Needs review'}</p>
        {error&&<p className="notice error" role="alert">{error}</p>}
        <div className="form-actions">
          <Button variant="outline" onClick={()=>modal.current?.close()}>Close</Button>
          {!selected.approved_at&&<Button disabled={busy||!writable} onClick={()=>void perform(async()=>{
            const result=await supabase!.from('media_assets').update({approved_at:new Date().toISOString()})
              .eq('id',selected.id).select('*').single();
            if(result.error)throw new Error('Could not approve this image.');
            setSelected(result.data);reloadMedia();setMessage('Image approved.');
          })}><Check size={16}/> Approve media</Button>}
        </div></>}
    </dialog>
  </>;
}

function PosterEditor({client,assets,busy,perform,saved}:{
  client:string;assets:Asset[];busy:boolean;perform:(fn:()=>Promise<void>)=>Promise<void>;saved:()=>void;
}) {
  const [ratio,setRatio]=useState<PosterRatio>('1:1');
  const [backdrop,setBackdrop]=useState('');
  const [brief,setBrief]=useState('');
  const [preview,setPreview]=useState<{file:Blob;name:string;source:string;metadata:Record<string,unknown>}>();
  const [ai,setAi]=useState<ImageOutput>();
  const canvas=useRef<HTMLCanvasElement>(null);
  function clearPreview() {setPreview(undefined);}
  async function compose(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields=new FormData(event.currentTarget);
    const field=(key:string)=>String(fields.get(key)??'').trim();
    await perform(async()=>{
      if(!field('headline'))throw new Error('Enter a headline.');
      const photo=backdrop==='ai'&&ai ? await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${ai.image}`)).blob())
        : await loadBitmap(assets.find(asset=>asset.id===backdrop));
      let logo:ImageBitmap|undefined;
      try {
        logo=await loadBitmap(assets.find(asset=>asset.id===field('logo')));
        if(!canvas.current)throw new Error('Poster preview is unavailable.');
        const file=await renderPoster(canvas.current,ratio,{
          headline:field('headline'),offer:field('offer'),price:field('price'),cta:field('cta'),colour:field('colour'),accent:field('accent'),
        },photo,logo);
        const generated=backdrop==='ai'&&ai;
        setPreview({file,name:field('headline'),source:generated?'ai_poster':'poster',
          metadata:generated?{aspect_ratio:ratio,model:generated.model,usage:generated.usage}:{aspect_ratio:ratio}});
      } finally {photo?.close();logo?.close();}
    });
  }
  return <div className="poster-grid">
    <form className="panel form-section" onSubmit={compose} onChange={clearPreview}>
      <fieldset disabled={busy}>
        <h2>Poster details</h2>
        <div className="form-grid">
          <label className="form-wide">Headline<input name="headline" maxLength={100} required/></label>
          <label>Offer<input name="offer" maxLength={90}/></label><label>Price as displayed<input name="price" maxLength={45}/></label>
          <label className="form-wide">Call to action<input name="cta" maxLength={80}/></label>
          <label>Format<select value={ratio} onChange={event=>{setRatio(event.target.value as PosterRatio);setAi(undefined);if(backdrop==='ai')setBackdrop('');}}>
            {Object.entries(posterSizes).map(([key,size])=><option key={key} value={key}>{key} · {size.join(' × ')}</option>)}
          </select></label>
          <label>Logo<select name="logo"><option value="">No logo</option>{assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
          <label>Background colour<input type="color" name="colour" defaultValue="#10233f"/></label>
          <label>Accent colour<input type="color" name="accent" defaultValue="#45dec7"/></label>
          <label className="form-wide">Backdrop<select value={backdrop} onChange={event=>setBackdrop(event.target.value)}>
            <option value="">Solid colour</option>{ai&&<option value="ai">Generated image</option>}{assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select></label>
        </div>
        <details className="poster-ai"><summary>Generate an AI backdrop</summary>
          <p className="muted">Only the visual brief you enter is sent to OpenAI. Add your logo and exact text in the poster editor.</p>
          <label>Public visual brief<textarea maxLength={1000} rows={3} value={brief} onChange={event=>setBrief(event.target.value)}/></label>
          <Button type="button" variant="outline" disabled={!brief.trim()} onClick={()=>void perform(async()=>{
            const result=await supabase!.functions.invoke<ImageOutput>('generate-poster',{body:{client_id:client,ratio,brief:brief.trim()}});
            if(result.error){
              const detail=result.error instanceof FunctionsHttpError?await result.error.context.json().catch(()=>null):null;
              throw new Error(detail?.message??'Image generation is unavailable.');
            }
            if(!result.data?.image)throw new Error('No image was returned.');
            setAi(result.data);setBackdrop('ai');clearPreview();
          })}><Sparkles size={16}/> Send visual brief to OpenAI</Button>
        </details>
        <div className="form-actions"><Button type="submit" variant="outline">Preview poster</Button>
          <Button type="button" disabled={!preview} onClick={()=>void perform(async()=>{
            if(!preview)return;
            await saveMedia(client,preview.file,preview.name,preview.source,preview.metadata);saved();
          })}>Save poster</Button></div>
      </fieldset>
    </form>
    <section className="panel form-section poster-preview"><h2>Preview</h2>
      {!preview&&<p className="empty">Preview the poster before saving it for review.</p>}
      <canvas ref={canvas} hidden={!preview} aria-label="Poster preview"/>
    </section>
  </div>;
}
