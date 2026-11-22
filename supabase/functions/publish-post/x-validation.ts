export type XParser={parseTweet:(text:string,options?:Record<string,unknown>)=>{weightedLength:number;valid:boolean};configs:{defaults:Record<string,unknown>}};
export const isX=(platform:string)=>['x','twitter'].includes(platform.toLowerCase());
export function xCaptionCheck(text:string,parse:XParser,limit=280,hasMedia=false){
 const allowed=limit===25000?25000:280;
 const result=parse.parseTweet(text,{...parse.configs.defaults,maxWeightedTweetLength:allowed});
 const valid=result.valid||(!text.trim()&&hasMedia);
 const over=Math.max(0,result.weightedLength-allowed);
 return {length:result.weightedLength,limit:allowed,valid,over,message:over
  ?'X text uses '+result.weightedLength+' of '+allowed+' weighted characters. Shorten the caption, hashtags and call to action by at least '+over+' characters, or create a separate short X draft.'
  :!valid?'X text is empty or contains unsupported characters. Edit and save it before publishing.':''};
}
export const isExplicitRejection=(outcome:unknown)=>Boolean(outcome&&typeof outcome==='object'&&'message' in outcome&&typeof outcome.message==='string');
