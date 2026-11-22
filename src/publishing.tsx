import { useEffect,useRef,useState } from 'react';
import { CalendarClock, Copy, Download, Link2, RefreshCw, Send } from 'lucide-react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Button } from './components/ui/button';
import { displayDate, supabase } from './data';
import type {XVariant} from './x-caption-version';
import {saveAndSubmit,scheduleIssue} from './publishing-flow';
import {xCaptionStatus,isX} from './x-caption';
import {channelTracking} from '../supabase/functions/publish-post/tracking';
import { TrackedLinkBuilder } from './tracked-link-builder';
import { mediaBucket } from './media-data';
import { nairobiDay, nairobiInstant, nairobiTime } from './calendar-dates';

type Account={id:string;buffer_channel_id:string;name:string;platform:string};
type Channel={id:string;name:string;platform:string};
export type Delivery={content_id:string;client_id:string;revision:number;account_id:string;status:'sending'|'submitted'|'rejected'|'unknown';external_post_id:string|null;provider_status:string|null;due_at:string|null;attempt_count:number;failure_code:string|null;status_checked_at:string|null;provider_sent_at:string|null};
export const deliveryFields='content_id,client_id,revision,account_id,status,external_post_id,provider_status,due_at,attempt_count,failure_code,status_checked_at,provider_sent_at';
type ScheduleFields={scheduled_at:string|null;schedule_cancelled_at:string|null;updated_at:string};
type Post=ScheduleFields&{id:string;client_id:string;revision:number;status:string;caption:string;hashtags:string;call_to_action:string;media_asset_id:string|null;suggested_date:string|null;suggested_time:string|null};
const statusLabels={sending:'Awaiting confirmation',submitted:'Accepted by Buffer',rejected:'Rejected by Buffer',unknown:'Check Buffer before retrying'} as const;

const providerLabels:Record<string,string>={scheduled:'Scheduled in Buffer',sending:'Sending',sent:'Published',error:'Failed in Buffer',draft:'Draft in Buffer',needs_approval:'Needs approval in Buffer',cancelled:'Cancelled in Buffer'};
export const deliveryLabel=(delivery:Pick<Delivery,'status'|'provider_status'>)=>delivery.provider_status
  ? providerLabels[delivery.provider_status]??statusLabels[delivery.status] : statusLabels[delivery.status];
export const failureLabels:Record<string,string>={connection:'Check the Buffer key or channel connection.',rate_limited:'Buffer rate limit. Wait before retrying.',request_rejected:'Check channel requirements and media in Buffer.',unconfirmed:'Check Buffer before creating another post.',provider_error:'Open the post in Buffer for the channel error.'};
export const needsAttention=(delivery:Pick<Delivery,'status'|'provider_status'>)=>delivery.status==='unknown'||delivery.status==='rejected'||delivery.provider_status==='error';

export async function publishingAction(action:'publish'|'schedule'|'retry'|'sync'|'cancel',post:Pick<Post,'id'|'client_id'|'revision'>,ids:string[],scheduled=false,expectedDueAt?:string,xCharacterLimit=280){
  const result=await supabase!.functions.invoke<{deliveries:Delivery[]}>('publish-post',{body:{
    action,client_id:post.client_id,post_id:post.id,revision:post.revision,account_ids:ids,scheduled,expected_due_at:expectedDueAt,x_character_limit:xCharacterLimit,
  }});
  if(result.error)throw new Error(await edgeMessage(result.error,'Could not confirm the request. Check Buffer before retrying.'));
  return result.data?.deliveries??[];
}

export async function edgeMessage(error:unknown,fallback:string) {
  if(error instanceof FunctionsHttpError) {
    const data=await error.context.json().catch(()=>null);
    if(typeof data?.message==='string')return data.message;
  }
  return fallback;
}

export function PublishingPanel({post,disabled,contentDirty=false,onSaveContent,onPlanSaved,xVariant,onXSelectionChange,date,time,onDateChange,onTimeChange}:{post:Post;disabled:boolean;contentDirty?:boolean;onSaveContent:()=>Promise<Post|null>;onPlanSaved:(plan:ScheduleFields,revision?:number)=>void;xVariant:XVariant|null;onXSelectionChange:(selected:boolean)=>void;date:string;time:string;onDateChange:(value:string)=>void;onTimeChange:(value:string)=>void}) {
  const [xLimit,setXLimit]=useState(280);
  const [accountsLoaded,setAccountsLoaded]=useState(false);
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),30000);return()=>window.clearInterval(timer);},[]);
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [channels,setChannels]=useState<Channel[]>();
  const [deliveries,setDeliveries]=useState<Delivery[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [sendMode,setSendMode]=useState<'publish'|'schedule'>('publish');
  const activePlan=post.schedule_cancelled_at?null:post.scheduled_at;
  const [channelId,setChannelId]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const confirm=useRef<HTMLDialogElement>(null);
  const ready=post.status==='approved'&&!disabled;
  const canSync=deliveries.some(item=>item.external_post_id&&item.provider_status!=='cancelled'&&(item.provider_status!=='sent'||!item.provider_sent_at));
  const plannedDeliveries=activePlan?deliveries.filter(item=>item.due_at&&Date.parse(item.due_at)===Date.parse(activePlan)):[];
  const hasBufferSchedule=plannedDeliveries.some(item=>item.provider_status==='scheduled');
  const awaitingBuffer=plannedDeliveries.some(item=>item.status==='sending'||item.status==='unknown'||(item.status==='submitted'&&!item.provider_status));
  const available=channels?.filter(channel=>!accounts.some(account=>account.buffer_channel_id===channel.id))??[];
  const caption=[post.caption,post.hashtags,post.call_to_action].map(field=>field.trim()).filter(Boolean).join('\n\n');

  const selectedX=accounts.filter(a=>selected.includes(a.id)&&isX(a.platform));
  const currentVariant=xVariant?.content_id===post.id&&xVariant.revision===post.revision?xVariant:null;
  const xText=currentVariant?.status==='approved'?currentVariant.caption:caption;
  const xCheck=xCaptionStatus(xText,xLimit,Boolean(post.media_asset_id));
  const xBlocked=selectedX.length>0&&!xCheck.valid;
  useEffect(()=>onXSelectionChange(selectedX.length>0),[selected.join(','),accounts.length,onXSelectionChange]);
  const actionIssue=!accountsLoaded?'Loading destination accounts…':!accounts.length?'Link a destination account to this client.':!selected.length?'Select at least one destination account above.':post.status!=='approved'&&!contentDirty?'Approve the main post before sending it to Buffer.':xBlocked&&!contentDirty?'Review and approve the short X caption above.':'';
  const scheduleProblem=scheduleIssue(date,time,Boolean(post.media_asset_id),clock);

  useEffect(()=>{
    if(!supabase)return;
    let active=true;
    const db=supabase;
    void Promise.all([
      db.from('publishing_accounts').select('id,buffer_channel_id,name,platform').eq('client_id',post.client_id).eq('active',true).order('name'),
      db.from('publishing_deliveries') .select(deliveryFields).eq('content_id',post.id).eq('revision',post.revision),
    ]).then(([accountRows,deliveryRows])=>{
      if(!active)return;
      setAccountsLoaded(true);
      if(accountRows.error||deliveryRows.error){setError('Could not load posting accounts or delivery results.');return;}
      setAccounts(accountRows.data);
      setDeliveries(deliveryRows.data as Delivery[]);
    });
    return ()=>{active=false;};
  },[post.client_id,post.id,post.revision,refresh]);

  async function perform(fn:()=>Promise<unknown>) {
    if(busy||disabled)return;
    setBusy(true);setError('');setMessage('');
    try{await fn();}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not complete that action.');}
    finally{setBusy(false);}
  }

  async function discover(){
    const r=await supabase!.functions.invoke<{channels:Channel[]}>('publish-post',{body:{action:'channels',client_id:post.client_id}});
    if(r.error)throw new Error(await edgeMessage(r.error,'Could not load Buffer accounts.'));
    setChannels(r.data?.channels??[]);
    setChannelId('');
  }

  async function connect(){
    const channel=available.find(item=>item.id===channelId);
    if(!channel)return;
    const r=await supabase!.from('publishing_accounts').insert({
      client_id:post.client_id,buffer_channel_id:channel.id,name:channel.name,platform:channel.platform,
    });
    if(r.error)throw new Error(r.error.code==='23505'?'This account is already linked to a client.':'Could not link this account.');
    setRefresh(value=>value+1);setChannelId('');setMessage(`Linked ${channel.name}.`);
  }

  async function runDelivery(action:'publish'|'schedule'|'retry'|'sync'|'cancel',ids:string[],scheduled=false,expectedDue?:string,target:Post=post){
    try {
      if(action==='retry'&&contentDirty)throw new Error('Save the caption changes before retrying a delivery.');
      const result=await publishingAction(action,target,ids,scheduled,expectedDue,xLimit);
      setDeliveries(old=>[...old.filter(delivery=>!result.some(row=>row.account_id===delivery.account_id)),...result]);
      if(action==='sync')setMessage('Delivery status refreshed.');
      else if(action==='cancel')setMessage('Buffer confirmed cancellation for this destination.');
      else if(action==='schedule'){
        const queued=result.filter(item=>item.provider_status==='scheduled').length;
        if(queued===ids.length)setMessage('Saved and scheduled in Buffer for all '+queued+' selected accounts.');
        else {setMessage('Post saved. Buffer confirmed '+queued+' of '+ids.length+' schedules.');setError('Scheduling is not confirmed for every destination. Check the delivery status beside each account.');}
      } else {
        const accepted=result.filter(delivery=>delivery.status==='submitted'&&delivery.provider_status!=='error').length;
        setMessage(accepted ? 'Buffer accepted '+accepted+' of '+result.length+' destinations. See each delivery below.' : 'Check the delivery result for each selected account.');
      }
      return result;
    } finally {setRefresh(value=>value+1);}
  }

  async function send(mode:'publish'|'schedule'){
    confirm.current?.close();
    const result=await saveAndSubmit({mode,date,time,ids:selected,hasMedia:Boolean(post.media_asset_id),saveContent:onSaveContent,
      ensureReady:async target=>{
        if(!accounts.some(a=>selected.includes(a.id)&&isX(a.platform)))return;
        const variant=await supabase!.from('content_x_captions').select('caption,status').eq('content_id',target.id).eq('revision',target.revision).maybeSingle();
        if(variant.error)throw new Error('Post saved, but the X caption could not be checked. Try again.');
        const full=[target.caption,target.hashtags,target.call_to_action].map(v=>v.trim()).filter(Boolean).join('\n\n');
        const check=xCaptionStatus(variant.data?.status==='approved'?variant.data.caption:full,xLimit,Boolean(target.media_asset_id));
        if(!check.valid)throw new Error('Post saved. Review and approve the X caption for this revision, then click Save & schedule again.');
      },
      savePlan:async(target,due)=>{
        const r=await supabase!.from('content_calendar').update({scheduled_at:due,schedule_cancelled_at:null}).eq('id',target.id).eq('revision',target.revision).eq('updated_at',target.updated_at).select('scheduled_at,schedule_cancelled_at,updated_at').maybeSingle();
        if(r.error||!r.data)throw new Error(r.error?.code==='P0001'?r.error.message:'The schedule was not saved. Reopen the post if it changed elsewhere.');
        onPlanSaved(r.data,target.revision);return {...target,...r.data};
      },
      submit:(target,action,ids,due)=>runDelivery(action,ids,false,due,target),
    });
    setSelected(old=>old.filter(id=>!result.some(row=>row.account_id===id)));
  }
  async function saveOnly(){const saved=await onSaveContent();if(!saved)throw new Error('Fix the form error above before saving.');setMessage('Post saved. No new Buffer submission was made.');}

  async function download(){
    if(!post.media_asset_id)return;
    const asset=await supabase!.from('media_assets').select('name,object_path').eq('id',post.media_asset_id).single();
    if(asset.error)throw new Error('Could not read the saved attachment.');
    const result=await supabase!.storage.from(mediaBucket).createSignedUrl(asset.data.object_path,120,{download:asset.data.name});
    if(result.error)throw new Error('Could not prepare the media download.');
    const link=document.createElement('a');link.href=result.data.signedUrl;link.rel='noopener';link.click();
  }

  return <section className="panel form-section publish-panel">
    <h2>Scheduling & destinations</h2>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {message&&<p className="notice" role="status">{message}</p>}
    <p className="muted">{accounts.length?'Select the accounts that should receive this saved post.':'Link accounts from Buffer to publish from this workspace.'}</p>
    {accounts.map(account=>{
      const receipt=deliveries.find(item=>item.account_id===account.id);
      const count=isX(account.platform)?xCaptionStatus(channelTracking(xText,post.id,account.platform),xLimit,Boolean(post.media_asset_id)):null;
      return <div className="account-destination" key={account.id}>
        <label>
          <input type="checkbox" checked={selected.includes(account.id)} disabled={disabled||busy||Boolean(receipt)||selected.length>=8&&!selected.includes(account.id)}
            onChange={event=>setSelected(old=>event.target.checked?[...old,account.id]:old.filter(id=>id!==account.id))}/>
          <span>{account.name} <small>· {account.platform}</small>{count&&<small className={!count.valid?'notice error':''}>{currentVariant?.status==='approved'?'Approved X version':'Saved X text'}: {count.length} / {count.limit}{count.over?' · '+count.over+' over':''}</small>}</span>
        </label>
        {receipt&&<div className="delivery-actions">
          <small className={`status-pill ${needsAttention(receipt)?'paused':receipt.provider_status==='sent'?'active':''}`}>{deliveryLabel(receipt)}</small>
          {receipt.failure_code&&<small>{failureLabels[receipt.failure_code]}</small>}
          {receipt.status==='rejected'&&receipt.attempt_count===1&&<Button variant="outline" disabled={!ready||busy||contentDirty||Boolean(count&&!count.valid)} onClick={()=>void perform(()=>runDelivery('retry',[account.id],Boolean(receipt.due_at)))}>Retry once</Button>}
          {receipt.due_at&&receipt.provider_status==='scheduled'&&<Button variant="outline" disabled={busy||disabled} onClick={()=>{
            if(window.confirm('Cancel this scheduled post for '+account.name+' in Buffer?'))void perform(()=>runDelivery('cancel',[account.id]));
          }}>Cancel in Buffer</Button>}
        </div>}
      </div>;
    })}
    {accounts.some(a=>isX(a.platform))&&<><label>X account text limit<select value={xLimit} onChange={event=>setXLimit(Number(event.target.value))}><option value={280}>Standard X account · 280</option><option value={25000}>Eligible paid X account · 25,000</option></select></label></>}
    {activePlan&&<p className="muted">{hasBufferSchedule?'Buffer schedule confirmed for at least one account':awaitingBuffer?'Buffer confirmation pending':'Calendar only'} · {displayDate(activePlan)} EAT</p>}
    <fieldset disabled={disabled||busy} className="publishing-schedule">
      <legend>Calendar planning · Nairobi time (EAT)</legend>
      <div className="form-grid">
        <label>Publishing date<input type="date" min={nairobiDay()} value={date} onChange={event=>onDateChange(event.target.value)}/></label>
        <label>Publishing time (EAT)<input type="time" value={time} onChange={event=>onTimeChange(event.target.value)}/></label>
      </div>
      {scheduleProblem&&<p className="notice error" role="status">{scheduleProblem}</p>}
    </fieldset>
    {actionIssue&&<p className="notice" role="status">{actionIssue}</p>}
    {contentDirty&&<p className="notice" role="status">The save action will apply your caption edits first. A changed caption needs a new X review before it can be scheduled to X.</p>}
    <div className="studio-actions publish-actions">
      <Button disabled={disabled||busy||Boolean(actionIssue)||Boolean(scheduleProblem)} onClick={()=>void perform(()=>send('schedule'))}><CalendarClock size={16}/>{busy?'Saving & submitting…':'Save & schedule in Buffer'}</Button>
      <Button variant="outline" disabled={disabled||busy||Boolean(actionIssue)} onClick={()=>{setSendMode('publish');confirm.current?.showModal();}}><Send size={16}/> Save & publish now</Button>
      <Button variant="outline" disabled={disabled||busy} onClick={()=>void perform(saveOnly)}>Save draft only</Button>
      <Button variant="outline" disabled={busy||disabled} onClick={()=>void perform(discover)}><Link2 size={16}/> Load Buffer accounts</Button>
      {canSync&&<Button variant="outline" disabled={busy||disabled} onClick={()=>void perform(()=>runDelivery('sync',deliveries.filter(row=>row.external_post_id&&row.provider_status!=='cancelled'&&(row.provider_status!=='sent'||!row.provider_sent_at)).slice(0,8).map(row=>row.account_id)).then(()=>undefined))}><RefreshCw size={16}/> Refresh delivery status</Button>}
    </div>
    {channels&&<div className="account-linker">
      {available.length?<><label>Buffer account<select value={channelId} onChange={event=>setChannelId(event.target.value)}>
        <option value="">Choose an account</option>{available.map(channel=><option key={channel.id} value={channel.id}>{channel.name} · {channel.platform}</option>)}
      </select></label><Button variant="outline" disabled={!channelId||busy||disabled} onClick={()=>void perform(connect)}>Link to this client</Button></>
      : <p className="muted">No additional connected accounts were found in Buffer.</p>}
    </div>}
    <div className="studio-actions publish-actions">
      <Button variant="outline" disabled={!ready||busy||!caption} onClick={()=>void perform(async()=>{
        await navigator.clipboard.writeText(caption);setMessage('Caption copied for manual posting.');
      })}><Copy size={16}/> Copy caption</Button>
      <Button variant="outline" disabled={!ready||busy||!post.media_asset_id} onClick={()=>void perform(download)}><Download size={16}/> Download media</Button>
    </div>
    <TrackedLinkBuilder clientId={post.client_id} postId={post.id}/>
    <dialog ref={confirm} className="panel confirmation">
      <h2>{sendMode==='schedule'?'Schedule for':'Publish now to'} {selected.length} {selected.length===1?'account':'accounts'}?</h2>
      <p>Buffer will receive the saved caption and a temporary link to any attached media. Saved organic tracking links use the source platform of each selected account.</p>
      {currentVariant?.status==='approved'&&selectedX.length>0&&<p>X will use the approved short caption shown above. Other platforms use the full saved caption.</p>}
      <ul className="publish-confirm-list">{accounts.filter(account=>selected.includes(account.id)).map(account=><li key={account.id}>{account.name} · {account.platform}</li>)}</ul>
      <div className="form-actions"><Button variant="outline" onClick={()=>confirm.current?.close()}>Cancel</Button>
        <Button disabled={!ready||busy} onClick={()=>void perform(()=>send('publish'))}>Send to Buffer</Button></div>
    </dialog>
  </section>;
}
