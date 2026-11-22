// Strip analytics authorization codes before Supabase handles its own sign-in callback.
export function captureAnalyticsOAuth(){
 if(typeof window==='undefined')return null;
 const url=new URL(window.location.href);if(url.searchParams.get('analytics_oauth')!=='1')return null;
 const response={code:url.searchParams.get('code'),state:url.searchParams.get('state'),error:url.searchParams.get('error')};
 for(const key of ['analytics_oauth','code','state','error','error_description','scope','authuser','prompt'])url.searchParams.delete(key);
 window.history.replaceState(null,'',url.pathname+url.search+url.hash);
 return response;
}
export const analyticsOAuthResponse=captureAnalyticsOAuth();
