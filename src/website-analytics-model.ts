export type GaReport={dimensionHeaders?:{name:string}[];metricHeaders?:{name:string}[];rows?:{dimensionValues?:{value:string}[];metricValues?:{value:string}[]}[];rowCount?:number;metadata?:{timeZone?:string;subjectToThresholding?:boolean;dataLossFromOtherRow?:boolean;samplingMetadatas?:unknown[]}};
export function gaRows(report:GaReport){return (report.rows??[]).map(row=>Object.fromEntries([...(report.dimensionHeaders??[]).map((h,i)=>[h.name,row.dimensionValues?.[i]?.value??'']),...(report.metricHeaders??[]).map((h,i)=>[h.name,row.metricValues?.[i]?.value??''])]));}
export function trackedLink(url:string,source:string,campaign:string,content:string){
 const link=new URL(url);if(link.protocol!=='https:'||link.username||link.password)throw new Error('Use a public HTTPS website URL.');
 if(!source||!campaign||!content)throw new Error('Choose a source, campaign and saved post.');
 link.searchParams.set('utm_source',source.toLowerCase());link.searchParams.set('utm_medium','organic_social');link.searchParams.set('utm_campaign',campaign);link.searchParams.set('utm_content',content);return link.href;
}
