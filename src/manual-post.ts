export function captionWithHashtags(caption='',hashtags=''){
 const tags=hashtags.trim();return tags&&!caption.includes(tags)?[caption.trim(),tags].filter(Boolean).join('\n\n'):caption;
}
export function inferredFormat(hasMedia:boolean,mime?:string,previous?:string){
 if(!hasMedia)return 'Text Post';if(mime)return mime.startsWith('video/')?'Video Post':'Image Post';return previous==='Video Post'?'Video Post':'Image Post';
}
export function editorCaption(caption='',hashtags='',closingLine=''){
 const text=captionWithHashtags(caption,hashtags),line=closingLine.trim();
 return line&&!text.includes(line)?[text.trim(),line].filter(Boolean).join('\n\n'):text;
}
