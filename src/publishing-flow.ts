import {nairobiInstant} from './calendar-dates.ts';
export type SchedulingPost={id:string;revision:number;status:string;scheduled_at:string|null;schedule_cancelled_at:string|null;updated_at:string;media_asset_id:string|null};
export function scheduleIssue(date:string,time:string,hasMedia:boolean,now=Date.now()){
 let due:string;try{due=nairobiInstant(date,time);}catch{return 'Choose a publishing date and time in Nairobi time (EAT).';}
 if(Date.parse(due)<=now+120000)return 'That publishing time has passed or is too close. Choose an EAT time at least two minutes in the future.';
 if(hasMedia&&Date.parse(due)>now+7*86400000)return 'Posts with attached media can be scheduled up to seven days ahead.';
 return '';
}
export async function saveAndSubmit<T extends SchedulingPost,D>({mode,date,time,ids,hasMedia,saveContent,ensureReady,savePlan,submit,now=Date.now()}:{
 mode:'publish'|'schedule';date:string;time:string;ids:string[];hasMedia:boolean;saveContent:()=>Promise<T|null>;ensureReady:(post:T)=>Promise<void>;savePlan:(post:T,due:string)=>Promise<T>;submit:(post:T,mode:'publish'|'schedule',ids:string[],due?:string)=>Promise<D>;now?:number;
}){
 if(!ids.length)throw new Error('Select at least one destination account above.');
 if(mode==='schedule'){const issue=scheduleIssue(date,time,hasMedia,now);if(issue)throw new Error(issue);}
 let target=await saveContent();if(!target)throw new Error('The post was not saved. Fix the form error above and try again.');
 if(mode==='schedule'){const issue=scheduleIssue(date,time,Boolean(target.media_asset_id),now);if(issue)throw new Error('Post saved. '+issue);}
 if(target.status!=='approved')throw new Error('Draft saved. Approve the main post before sending it to Buffer.');
 await ensureReady(target);
 const due=mode==='schedule'?nairobiInstant(date,time):undefined;
 if(due&&(!target.scheduled_at||target.schedule_cancelled_at||Date.parse(target.scheduled_at)!==Date.parse(due)))target=await savePlan(target,due);
 return submit(target,mode,ids,due);
}
