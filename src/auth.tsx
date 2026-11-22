import { useState, type FormEvent } from 'react';
import { ArrowRight, ArrowLeft, Eye, EyeOff, LockKeyhole, Orbit } from 'lucide-react';
import { Button } from './components/ui/button';
import { supabase } from './data';

export function BrandMark() {
  return <div className="wordmark"><span className="mark"><Orbit size={22} strokeWidth={2.2}/></span><span>TSOLS <small>MARKETING OS</small></span></div>;
}

export function AuthScreen({ recovery, canUpdatePassword, finish, clientMode }: {
  recovery: boolean; canUpdatePassword: boolean; finish: () => void; clientMode: boolean;
}) {
  const [emailLink, setEmailLink] = useState(false);
  const [reset, setReset] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [success, setSuccess] = useState(false);
  const title = recovery ? 'Set a new password' : reset ? 'Reset your password' : emailLink ? 'Email me a sign-in link' : 'Sign in to TSOLS Marketing OS';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || pending) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    setPending(true);
    setFeedback('');
    setSuccess(false);
    try {
      if (recovery) {
        const result = await supabase.auth.updateUser({ password });
        if (result.error) throw result.error;
        await supabase.auth.signOut();
        finish();
        setSuccess(true);
        setFeedback('Password updated. Sign in with your new password.');
      } else if (reset) {
        const result = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: new URL(clientMode?'/?client=1&reset=1':'/?reset=1', window.location.origin).href,
        });
        if (result.error) throw result.error;
        setSuccess(true);
        setFeedback('If this email has access, you’ll receive a reset link. Open it in this browser.');
      } else if (emailLink) {
        const result = await supabase.auth.signInWithOtp({email,options:{
          shouldCreateUser:false,emailRedirectTo:new URL('/?client=1',location.origin).href,
        }});
        if (result.error && ![400,422].includes(result.error.status??0)) throw result.error;
        setSuccess(true);
        setFeedback('If this email has access, you’ll receive a sign-in link. Open it in this browser.');
      } else {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      setFeedback(status === 429 ? 'Too many attempts. Wait a moment and try again.'
        : recovery ? 'Could not update your password. Request a new link or try a stronger password.'
        : reset ? 'Could not request a reset. Please try again.'
        : emailLink ? 'Could not request a sign-in link. Please try again.'
        : 'Sign-in failed. Check your email and password, then try again.');
    } finally {
      setPending(false);
    }
  }

  function changeMode() {
    if (recovery) finish();
    setReset(recovery || (!reset && !emailLink));
    setEmailLink(false);
    setFeedback('');
    setSuccess(false);
  }

  return <main className="auth-layout">
    <section className="auth-story">
      <a className="auth-home" href="/" aria-label="TSOLS Marketing OS home"><BrandMark /></a>
      <div className="line-art" aria-hidden="true"><i/><i/><i/><i/><i/><i/><b/><b/><b/></div>
      <div className="story-content">
        <p className="eyebrow"><span/> THAGANA SOLUTIONS</p>
        <h1>Your marketing<br/> workspace<span>.</span></h1>
        <p>Access your agency workspace or client portal with your TSOLS account.</p>
      </div>
      <div className="story-bottom"><span>Kiserian, Kenya</span><span>EAT <span className="story-dot">·</span> UTC+3</span></div>
    </section>
    <section className="auth-main">
      <div className="auth-meta"><LockKeyhole size={14}/> Private workspace</div>
      <div className="auth-card">
        <div className="auth-icon"><LockKeyhole size={22}/></div>
        <h2>{title}</h2>
        <p>{recovery ? 'Choose a password with at least 12 characters.' : reset ? 'We’ll send a recovery link to your workspace email.' : 'Use the email assigned to your TSOLS account.'}</p>
        {!supabase && <div className="setup-note" role="status"><strong>Workspace setup required</strong><span>Connect the agency’s Supabase project to enable sign-in.</span></div>}
        {recovery && !canUpdatePassword && <p role="status">If this link has expired, request a new one.</p>}
        <form onSubmit={submit} key={title}>
          <fieldset disabled={!supabase || pending || (recovery && !canUpdatePassword)}>
            {!recovery && <label>Email address<input name="email" type="email" autoComplete="username" placeholder="you@company.com" required/></label>}
            {(!reset && !emailLink || recovery) && <label>{recovery ? 'New password' : 'Password'}
              <div className="password-field"><input name="password" type={visible ? 'text' : 'password'} autoComplete={recovery ? 'new-password' : 'current-password'} placeholder="Enter your password" minLength={recovery ? 12 : undefined} required/>
              <button type="button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div>
            </label>}
            <Button className="auth-submit" disabled={pending}>{pending ? 'Please wait…' : recovery ? 'Update password' : reset ? 'Send reset link' : emailLink ? 'Send sign-in link' : 'Sign in'}<ArrowRight size={17}/></Button>
          </fieldset>
        </form>
        {feedback && <p className={success ? 'notice' : 'error'} role={success ? 'status' : 'alert'}>{feedback}</p>}
        <div className="auth-options">
          <button className="text-link" type="button" onClick={changeMode}>{recovery || reset || emailLink ? <><ArrowLeft size={15}/>{recovery ? 'Request a new link' : 'Back to sign in'}</> : 'Forgot your password?'}</button>
          {!recovery && !reset && !emailLink && <button className="text-link" type="button" onClick={()=>{setEmailLink(true);setFeedback('');setSuccess(false);}}>Email me a sign-in link</button>}
        </div>
      </div>
      <footer>Developed By <a href="https://tsols.co.ke/?utm_source=tsols_marketing_os&amp;utm_medium=referral&amp;utm_content=sign_in_footer">Thagana Solutions</a></footer>
    </section>
  </main>;
}
