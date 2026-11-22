# TSOLS Marketing OS

An agency workspace for planning content, publishing social posts and measuring results across client accounts.

**Live application:** [os.tsols.co.ke](https://os.tsols.co.ke)

## Features

- **Content Studio:** manual and AI drafts, caption editing, media uploads and library selection, revision history and approvals.
- **X captions:** Gemini-assisted shortening, weighted character counting and a separate approved caption for X.
- **Calendar and publishing:** Nairobi-time scheduling, Buffer account selection, publish-now actions and delivery records.
- **Content performance:** real metrics from accessible Buffer channels, with individual channel errors and clear unavailable states.
- **Website analytics:** independent Google Analytics 4, Google Search Console and Bing Webmaster connections, verification and property discovery.
- **Agency operations:** client workspaces, media library, leads and WhatsApp workflows, ads reporting, PDF reports, client portal, automations and billing modules.
- **Access control:** Supabase authentication and PostgreSQL row-level security for agency and client access.

Analytics depend on provider access and data availability. Missing metrics are not replaced with demo figures or zeroes. Scheduling success does not itself confirm publication; check the recorded delivery status.

## Technology

React, TypeScript and Vite power the frontend. Supabase provides authentication, PostgreSQL, private media storage and Edge Functions. Integrations run on the server so provider credentials stay out of the browser.

```text
src/                    Frontend application
supabase/migrations/    Database schema and access policies
supabase/functions/     Server-side integrations
supabase/tests/         Database and integration logic tests
```

## Local development

Use Node.js 24 and npm.

```bash
npm ci
cp .env.example .env.local
```

Set these values in `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Then start the development server:

```bash
npm run dev
```

The optional `VITE_GOOGLE_*` variables in `.env.example` enable the Google Drive picker. They are separate from website analytics OAuth configuration.

## Supabase setup

1. Create a Supabase project and apply the SQL migrations in `supabase/migrations` in filename order. Use the Supabase CLI migration workflow for managed deployments.
2. Configure email/password authentication, the deployed Site URL, allowed password-reset redirects and email delivery. Disable open signup for an invitation-managed workspace.
3. Create the first administrator in Supabase Auth. Provision their profile, agency and agency membership using the database schema. Auth user creation alone does not grant workspace access.
4. Deploy the required Edge Functions from `supabase/functions` and configure their server-side secrets.
5. Verify authentication, client isolation, storage access and integration callbacks in a staging project before onboarding clients.

## Integrations

Configure only the providers you use. Credentials belong in Supabase Edge Function secrets or the application's encrypted connection storage, never in frontend environment variables.

| Service | Configuration |
| --- | --- |
| Buffer | Set `BUFFER_API_KEY`. For another deployment, explicitly set `BUFFER_ORGANIZATION_ID` and `BUFFER_AGENCY_ID` to the intended organization and agency. Connect social accounts in Buffer, then verify account access in Publishing. |
| Gemini | Set `GEMINI_API_KEY`. If using `GEMINI_MODEL`, choose a model available to that API project. Used for X caption rewriting. |
| OpenAI | Set `OPENAI_API_KEY` for AI content and image generation. Optional model overrides must refer to models your project can access. |
| Google Analytics and Search Console | Register the agency OAuth app once, enable Analytics Admin API, Analytics Data API and Search Console API, then configure the app in the workspace and connect a Google account. |
| Bing Webmaster | Register and configure the agency OAuth app, then authorize a Bing account with access to the required verified sites. |
| Report and invitation email | Set `RESEND_API_KEY` and a verified sender using `REPORT_FROM_EMAIL` and, where needed, `CLIENT_PORTAL_FROM_EMAIL`. |

### Analytics authorization

Agency OAuth app configuration is reusable across clients. Users still grant provider consent, and the selected provider account must have permission to access each client's properties or verified sites. The application can reuse authorized accounts and match a client's website to an accessible property; ambiguous matches require selection.

For Google, the authorized JavaScript origin is the origin alone, for example `https://os.tsols.co.ke`. The analytics redirect URI includes the callback path and query:

```text
https://YOUR_DEPLOYED_ORIGIN/app/?analytics_oauth=1
```

Use the exact redirect URI shown by the application's connection setup. Configure consent-screen test users during testing, or complete the provider's production requirements before wider client use. Verify each service independently. Connected services hide their setup instructions; connection management remains available.

## Validation and deployment

```bash
npm run build
npm test
```

The build type-checks TypeScript and creates `dist/`. The default test script checks the database foundation using PGlite. Additional suites live in `supabase/tests`; external provider authorization and delivery also require live verification.

Deploy `dist/` to a static host with the application's routes available. Deploy database migrations and Edge Functions separately. Frontend environment values are compiled into the bundle, so changing them requires a rebuild.

## Source and credentials

This repository contains a source snapshot, database migrations and server functions. It excludes production environment files, API tokens, OAuth secrets and database contents. Copying this repository does not copy live client accounts, stored media or provider authorizations. GitHub publication does not automatically configure deployment or continuous synchronization.
