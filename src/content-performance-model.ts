export type Metric={type:string;name:string;value:number;unit:string};
export type PerformancePost={id:string;text:string;channelId:string;sentAt:string|null;externalLink:string|null;metrics:Metric[]|null;metricsUpdatedAt:string|null};
export const metricValue=(post:PerformancePost,type:string):number|null=>{
  if(!post.metricsUpdatedAt)return null;
  const metric=post.metrics?.find(item=>item.type===type);
  return metric&&Number.isFinite(metric.value)?metric.value:null;
};
export function totalMetric(posts:PerformancePost[],type:string){
  const values=posts.map(post=>metricValue(post,type)).filter((value):value is number=>value!==null);
  return {value:values.length?values.reduce((sum,value)=>sum+value,0):null,covered:values.length};
}
export function engagement(post:PerformancePost){
  const values=['reactions','comments','shares','reposts','saves'].map(type=>metricValue(post,type)).filter((v):v is number=>v!==null);
  return values.length?values.reduce((a,b)=>a+b,0):null;
}
export function safePostLink(value:string|null){
  try{const url=new URL(value??'');return url.protocol==='https:'?url.href:null;}catch{return null;}
}
