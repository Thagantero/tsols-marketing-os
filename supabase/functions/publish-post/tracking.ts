// Only TSOLS links explicitly tagged for this saved post are adjusted per destination.
export function channelTracking(text:string,postId:string,platform:string){
 return text.replace(/https:\/\/[^\s<>"']+/g,value=>{
  try{const url=new URL(value);if(url.searchParams.get('utm_medium')!=='organic_social'||url.searchParams.get('utm_content')!==postId)return value;
   url.searchParams.set('utm_source',platform.toLowerCase());return url.href;
  }catch{return value;}
 });
}
