declare module 'twitter-text' {
 const twitterText:{parseTweet(text:string,options?:Record<string,unknown>):{weightedLength:number;valid:boolean};configs:{defaults:Record<string,unknown>}};
 export default twitterText;
}
