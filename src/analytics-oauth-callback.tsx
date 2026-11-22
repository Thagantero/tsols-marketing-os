import {AnalyticsPropertyPicker,type AccountConnectionResult} from './analytics-account-connect';
import {useEffect,useRef,useState} from 'react';
import {supabase} from './data';
import {edgeMessage} from './publishing';
import {analyticsOAuthResponse} from './analytics-oauth-response';
import {Button} from './components/ui/button';
export function AnalyticsOAuthCallback(){
 const started=useRef(false);const [error,setError]=useState('');const [client,setClient]=useState('');const [selection,setSelection]=useState<AccountConnectionResult>();
 useEffect(()=>{if(started.current)return;started.current=true;
  void(async()=>{
   const response=analyticsOAuthResponse;
   if(!response?.state)throw new Error('The provider did not return a connection state. Start the connection again.');
   let pending;try{pending=JSON.parse(sessionStorage.getItem('tsols-analytics-oauth:'+response.state)??'null');sessionStorage.removeItem('tsols-analytics-oauth:'+response.state);}catch{throw new Error('This browser could not recover the connection request. Start again.');}
   if(!pending?.clientId||!pending?.createdAt||Date.now()-pending.createdAt>10*60000)throw new Error('This connection request expired or was started in another browser. Start again.');
   setClient(pending.clientId);
   if(response.error)throw new Error('Authorization was declined or cancelled. Your existing connection has not changed.');
   if(!response.code)throw new Error('The authorization code is missing. Start the connection again.');
   const r=await supabase!.functions.invoke<AccountConnectionResult>('website-analytics',{body:{action:'oauth_finish',client_id:pending.clientId,state:response.state,code:response.code}});
   if(r.error)throw new Error(await edgeMessage(r.error,'Could not complete provider authorization. Start the connection again.'));
   if(r.data?.needs_selection){setSelection(r.data);return;}
   window.location.replace('/app/#/reports/'+pending.clientId+'/website');
  })().catch(e=>setError(e instanceof Error?e.message:'Connection failed.'));
 },[]);
 if(selection)return <main className="assigned analytics-selection-page"><AnalyticsPropertyPicker result={selection} request={async<T,>(body:Record<string,unknown>)=>{const r=await supabase!.functions.invoke<T>('website-analytics',{body:{client_id:client,...body}});if(r.error)throw new Error(await edgeMessage(r.error,'Could not connect selected websites.'));return r.data!;}} onComplete={()=>window.location.replace('/app/#/reports/'+client+'/website')}/><Button variant="outline" onClick={()=>window.location.replace('/app/#/reports/'+client+'/website')}>Return to analytics</Button></main>;
 return <main className="assigned"><section className="panel form-section"><span className="studio-eyebrow">ANALYTICS CONNECTION</span><h1>{error?'Connection needs attention':'Finishing your connection…'}</h1>{error?<><p className="notice error" role="alert">{error}</p><Button onClick={()=>window.location.replace('/app/#/reports/'+(client?client+'/':'')+'website')}>Return to analytics</Button></>:<p role="status">Verifying property access and saving authorization securely.</p>}</section></main>;
}
