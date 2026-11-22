import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Mail, UserPlus } from 'lucide-react';
import { Button } from './components/ui/button';
import { displayDate, supabase } from './data';

type Invitation = { id: string; email: string; expires_at: string; accepted_at: string | null; revoked_at: string | null };
const stateOf = (invite: Invitation) => invite.revoked_at ? 'Revoked' : invite.accepted_at ? 'Active' :
  Date.parse(invite.expires_at) <= Date.now() ? 'Expired' : 'Pending';

export function PortalAccess({clientId, archived}: {clientId:string; archived:boolean}) {
  const [invitations,setInvitations] = useState<Invitation[]>([]);
  const [refresh,setRefresh] = useState(0);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const [confirm,setConfirm] = useState<{id:string; email:string; action:'send'|'revoke'}>();

  useEffect(() => {
    let active = true;
    void supabase?.from('client_portal_invitations').select('id,email,expires_at,accepted_at,revoked_at')
      .eq('client_id',clientId).order('created_at',{ascending:false}).then(result => {
        if (!active) return;
        setLoading(false);
        if (result.error) {setError('Could not load portal invitations.');return;}
        setInvitations(result.data);
      });
    return () => {active=false;};
  },[clientId,refresh]);

  async function createInvitation(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form=event.currentTarget;
    const email=String(new FormData(form).get('email')??'').trim().toLowerCase();
    setBusy(true);setError('');setNotice('');
    const result=await supabase.rpc('manage_client_portal_access',{target_client:clientId,invite_email:email,revoke_id:null});
    setBusy(false);
    if(result.error){setError('Could not create the invitation. Check the email and try again.');return;}
    form.reset();setRefresh(value=>value+1);
    setNotice('Invitation saved. Send it from the list below.');
  }

  async function confirmAction() {
    if (!confirm || !supabase || busy) return;
    setBusy(true);setError('');setNotice('');
    try {
      if (confirm.action==='revoke') {
        const result=await supabase.rpc('manage_client_portal_access',{target_client:clientId,invite_email:null,revoke_id:confirm.id});
        if(result.error){setError('Could not revoke this invitation.');return;}
        setNotice('Portal access revoked.');setRefresh(value=>value+1);
      } else {
        const result=await supabase.functions.invoke('client-portal-invite',{body:{invitation_id:confirm.id,confirmed:true}});
        if(result.error){
          const body = await (result.error.context as Response | undefined)?.json?.().catch(()=>null);
          setError(typeof body?.message==='string'?body.message:'Invitation delivery could not be confirmed. Check Resend before retrying.');
          return;
        }
        setNotice('Invitation email accepted for delivery.');
      }
    } finally {
      setBusy(false);setConfirm(undefined);
    }
  }

  async function copyPortalLink() {
    try {
      await navigator.clipboard.writeText(new URL('/app/',location.origin).href);
      setNotice('Portal sign-in link copied.');setError('');
    } catch {setError('Copy the address from the Open portal link.');}
  }

  return <section className="panel form-section">
    <h2>Client portal access</h2>
    <p className="muted">Add each authorized user by email so they can sign in to the client portal.</p>
    <div className="portal-actions">
      <Button variant="outline" type="button" onClick={copyPortalLink}><Copy size={16}/> Copy sign-in link</Button>
      <a className="text-link" href="/app/#/portal/overview" target="_blank" rel="noreferrer">Open portal</a>
    </div>
    {!archived && <form onSubmit={createInvitation} className="portal-invite-form">
      <label htmlFor="portal-invite-email">Client user’s email</label>
      <div className="portal-actions"><input id="portal-invite-email" name="email" type="email" maxLength={254} required placeholder="name@business.com"/>
        <Button disabled={busy}><UserPlus size={17}/> Create invitation</Button></div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {loading ? <p role="status">Loading invitations…</p> : invitations.length===0 ? <p className="muted">No invitations yet.</p> :
      <div className="portal-list">{invitations.map(invite=>{
        const status=stateOf(invite);
        return <article className="portal-list-item" key={invite.id}>
          <div><strong>{invite.email}</strong><p className="muted">{status}{status==='Pending'?' · Expires '+displayDate(invite.expires_at):''}</p></div>
          <div className="portal-actions">
            {!archived && status==='Pending' && <Button variant="outline" disabled={busy} onClick={()=>setConfirm({...invite,action:'send'})}><Mail size={16}/> Email link</Button>}
            {status!=='Revoked' && <Button variant="ghost" disabled={busy} onClick={()=>setConfirm({...invite,action:'revoke'})}>Revoke</Button>}
          </div>
        </article>;
      })}</div>}
    {confirm && <div className="portal-confirm" role="group" aria-label="Confirm portal action">
      <p>{confirm.action==='send'?'Email an invitation to':'Remove this business’s portal access for'} <strong>{confirm.email}</strong>?</p>
      <div className="portal-actions"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(undefined)}>Cancel</Button>
        <Button disabled={busy} onClick={confirmAction}>{busy?'Working…':confirm.action==='send'?'Send invitation':'Revoke access'}</Button></div>
    </div>}
  </section>;
}
