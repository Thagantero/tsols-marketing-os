import { supabase } from './data';

export const mediaBucket = 'tsols-media';
export const imageTypes = ['image/jpeg','image/png','image/webp'] as const;
const extensions: Record<string,string> = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'};
export type Asset = {id:string;client_id:string;name:string;object_path:string;mime_type:string;size?:number;bytes:number;source:string;approved_at:string|null;created_at:string};
export type MediaClient = {id:string;business_name:string;status:string};
export const mediaAccept = [...imageTypes,'video/mp4'].join(',');

export async function saveMedia(clientId:string,blob:Blob,name:string,source:string,metadata:Record<string,unknown> = {}) {
  if (!supabase) throw new Error('The workspace is unavailable.');
  const extension = extensions[blob.type];
  const video = blob.type==='video/mp4';
  if (!extension || blob.size === 0 || blob.size > (video ? 52428800 : 8388608)) {
    throw new Error('Choose a JPG, PNG or WebP image up to 8 MB, or an MP4 video up to 50 MB.');
  }
  try {
    if(video)await readVideo(blob);
    else {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
    }
  } catch {throw new Error('The file could not be opened. Try a supported image or an MP4 video.');}
  const id = crypto.randomUUID();
  const path = `${clientId}/${id}.${extension}`;
  const bucket = supabase.storage.from(mediaBucket);
  const uploaded = await bucket.upload(path,blob,{contentType:blob.type,upsert:false});
  if (uploaded.error) throw new Error('Media upload failed. Check workspace access and try again.');
  const registered = await supabase.from('media_assets').insert({
    id,client_id:clientId,name:name.trim().slice(0,180) || 'Untitled image',object_path:path,
    bytes:blob.size,mime_type:blob.type,source,generation_metadata:metadata,
  }).select('id').single();
  if (registered.error) {
    await bucket.remove([path]);
    throw new Error('The file could not be added to the media library.');
  }
  return id;
}

function readVideo(file:Blob) {
  return new Promise<void>((resolve,reject) => {
    const video=document.createElement('video');
    const url=URL.createObjectURL(file);
    const finish=(ok:boolean)=>{
      clearTimeout(timer);
      video.onloadedmetadata=null;video.onerror=null;
      video.removeAttribute('src');video.load();
      URL.revokeObjectURL(url);
      if(ok)resolve();else reject(new Error('Invalid video.'));
    };
    const timer=window.setTimeout(()=>finish(false),10000);
    video.preload='metadata';
    video.onloadedmetadata=()=>finish(video.videoWidth>0&&video.videoHeight>0&&Number.isFinite(video.duration)&&video.duration>0);
    video.onerror=()=>finish(false);
    video.src=url;
  });
}

export async function signedMedia(paths:string[]) {
  if (!supabase || !paths.length) return {};
  const result = await supabase.storage.from(mediaBucket).createSignedUrls(paths,600);
  if (result.error) throw new Error('Could not load image previews.');
  return Object.fromEntries(result.data.flatMap(item => item.path && item.signedUrl ? [[item.path,item.signedUrl]] : [])) as Record<string,string>;
}

export async function loadBitmap(asset?:Asset) {
  if (!supabase || !asset) return undefined;
  const result = await supabase.storage.from(mediaBucket).download(asset.object_path);
  if (result.error) throw new Error('Could not open the selected image.');
  return createImageBitmap(result.data);
}
