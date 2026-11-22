import twitterText from 'npm:twitter-text@3.1.0';
export function protectedSource(text:string){
 const entities=twitterText.extractUrlsWithIndices(text) as {url:string;indices:[number,number]}[];
 const links=entities.map(e=>e.url);
 let source=text;for(let i=entities.length-1;i>=0;i--)source=source.slice(0,entities[i].indices[0])+'TSOLS_LINK_'+i+source.slice(entities[i].indices[1]);
 return {source,links};
}
export function restoreAndValidate(raw:string,links:string[]){
 let text=raw.trim();
 for(let i=0;i<links.length;i++){
  const marker='TSOLS_LINK_'+i;
  if(!new RegExp('\\b'+marker+'\\b').test(text))return {error:'The rewrite omitted a required link.'};
  text=text.replace(new RegExp('\\b'+marker+'\\b','g'),()=>links[i]);
 }
 if(/TSOLS_LINK_\d+/.test(text))return {error:'The rewrite contains an invalid link placeholder.'};
 const outputLinks=twitterText.extractUrlsWithIndices(text) as {url:string}[];
 if(outputLinks.some(item=>!links.includes(item.url)))return {error:'The rewrite added a link that was not in the source.'};
 const parsed=twitterText.parseTweet(text);
 if(!parsed.valid)return {error:'The rewrite does not fit X’s 280-character weighted limit.'};
 return {caption:text,length:parsed.weightedLength};
}
