import twitterText from 'twitter-text';
import {xCaptionCheck} from '../supabase/functions/publish-post/x-validation';
export {isX} from '../supabase/functions/publish-post/x-validation';
export const xCaptionStatus=(text:string,limit=280,hasMedia=false)=>xCaptionCheck(text,twitterText,limit,hasMedia);
export const combinedCaption=(caption:string,hashtags:string,cta:string)=>[caption,hashtags,cta].map(field=>field.trim()).filter(Boolean).join('\n\n');
