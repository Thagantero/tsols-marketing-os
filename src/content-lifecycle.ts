export type ContentDelivery={revision:number;status:string;provider_status:string|null};
export type LifecyclePost={revision:number;scheduled_at?:string|null;schedule_cancelled_at?:string|null;publishing_deliveries?:ContentDelivery[]};
export type Lifecycle='draft'|'scheduled'|'published';
export function contentLifecycle(post:LifecyclePost):{key:Lifecycle;label:string;detail:string}{
 const rows=(post.publishing_deliveries??[]).filter(r=>r.revision===post.revision);
 const sent=rows.filter(r=>r.provider_status==='sent').length;
 const scheduled=rows.filter(r=>r.provider_status==='scheduled').length;
 const attention=rows.some(r=>r.status==='rejected'||r.status==='unknown'||r.provider_status==='error');
 const key:Lifecycle=scheduled?'scheduled':sent?'published':'draft';
 const parts:string[]=[];
 if(rows.length&&(sent||scheduled)){parts.push(`${sent} published · ${scheduled} scheduled`);const other=rows.length-sent-scheduled;if(other)parts.push(`${other} unconfirmed`);}
 if(attention)parts.push('Delivery needs attention');
 else if(rows.some(r=>r.status==='sending'||(r.status==='submitted'&&!r.provider_status)))parts.push('Awaiting Buffer confirmation');
 else if(!sent&&!scheduled&&post.scheduled_at&&!post.schedule_cancelled_at)parts.push('Calendar only · not queued in Buffer');
 return {key,label:{draft:'Draft',scheduled:'Scheduled',published:'Published'}[key],detail:parts.join(' · ')};
}
