import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const site = Deno.env.get('TSOLS_SITE_ORIGIN') ?? 'https://tsols-marketing-os.partedmars4.chatgpt.site';
const productionSite='https://os.tsols.co.ke';
const responseHeaders = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Cache-Control': 'no-store',
  Vary: 'Origin',
};
const env = (name: string) => Deno.env.get(name)?.trim() ?? '';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

Deno.serve(async request => {
  const origin = request.headers.get('Origin');
  const allowedOrigin=origin===site||origin===productionSite;
  const cors={...responseHeaders,...(origin&&allowedOrigin?{'Access-Control-Allow-Origin':origin}:{})};
  const reply = (status: number, message: string) => Response.json({ message }, { status, headers: cors });
  if (origin && !allowedOrigin) return reply(403, 'Origin unavailable.');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, 'Use POST.');
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return reply(401, 'Sign in again.');

  try {
    const project = env('SUPABASE_URL'), key = env('SUPABASE_ANON_KEY');
    const auth = { persistSession: false, autoRefreshToken: false };
    const db = createClient(project, key, { auth, global: { headers: { Authorization: authorization } } });
    const identity = await db.auth.getUser(authorization.slice(7));
    if (identity.error || !identity.data.user) return reply(401, 'Sign in again.');

    const raw = await request.text();
    if (raw.length > 1000) return reply(413, 'Invitation request is too large.');
    let input;
    try { input = JSON.parse(raw); } catch { return reply(400, 'Invalid invitation request.'); }
    if (typeof input?.invitation_id !== 'string' || !uuid.test(input.invitation_id) || input.confirmed !== true) {
      return reply(400, 'Choose an invitation and confirm sending.');
    }
    const invite = await db.from('client_portal_invitations').select('id,client_id,email,expires_at,accepted_at,revoked_at')
      .eq('id', input.invitation_id).maybeSingle();
    if (invite.error || !invite.data) return reply(403, 'This invitation is unavailable.');
    const row = invite.data;
    const client = await db.from('clients').select('id').eq('id', row.client_id).neq('status', 'archived').maybeSingle();
    if (client.error || !client.data || row.revoked_at || row.accepted_at || Date.parse(row.expires_at) <= Date.now()) {
      return reply(409, 'Create or renew a pending invitation before sending.');
    }

    const service = env('SUPABASE_SERVICE_ROLE_KEY'), resend = env('RESEND_API_KEY');
    const sender = env('CLIENT_PORTAL_FROM_EMAIL') || env('REPORT_FROM_EMAIL');
    if (!service || !resend || !sender) return reply(503, 'Set RESEND_API_KEY and a verified CLIENT_PORTAL_FROM_EMAIL in Supabase Edge Function Secrets.');
    const admin = createClient(project, service, { auth });
    const generated = await admin.auth.admin.generateLink({ type: 'magiclink', email: row.email });
    const token = generated.data.properties?.hashed_token;
    if (generated.error || !token) return reply(502, 'Could not create the secure sign-in link. Try again later.');

    const link = new URL('/?client=1', site);
    link.hash = new URLSearchParams({ portal_token: token }).toString();
    const sent = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer '+resend, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: sender, to: [row.email], subject: 'Your TSOLS Client Portal invitation',
        text: 'You have been invited to the TSOLS Client Portal. Open the secure link and choose Accept invitation.\n\n'+link.href+
          '\n\nUse the latest invitation link. If the site asks for access, sign in to ChatGPT with the email your administrator invited.',
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (sent.status === 429) return reply(429, 'The email service is rate-limiting requests. Wait before trying again.');
    if (!sent.ok) return reply(502, 'The email service rejected the invitation. Check the verified sender in Resend.');
    return reply(200, 'Invitation email accepted for delivery.');
  } catch {
    return reply(502, 'Invitation delivery could not be confirmed. Check Resend before sending again.');
  }
});
