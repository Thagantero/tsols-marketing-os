import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const admin = '10000000-0000-4000-8000-000000000001';
const userA = '10000000-0000-4000-8000-000000000002';
const userB = '10000000-0000-4000-8000-000000000003';
const otherAdmin = '10000000-0000-4000-8000-000000000004';
const agency = '20000000-0000-4000-8000-000000000001';
const otherAgency = '20000000-0000-4000-8000-000000000002';
const clientA = '30000000-0000-4000-8000-000000000001';
const clientB = '30000000-0000-4000-8000-000000000002';
const otherClient = '30000000-0000-4000-8000-000000000003';

async function as(user, operation, role = 'authenticated') {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  try { return await operation(); }
  finally { await db.exec('reset role'); }
}

before(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (bucket_id text, name text, owner_id text, primary key (bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, anon;
    grant select, insert, delete on storage.objects to authenticated, anon;
  `);
  for (const migration of ['202611150001_foundation.sql', '202611150002_client_save.sql', '20261115171325_content_studio.sql', '20261115190800_media_and_calendar.sql', '20261115192550_manual_multi_account_publishing.sql', '20261115193734_buffer_delivery_tracking.sql', '20261115211544_leads_and_whatsapp.sql', '20261115211902_simplify_studio_approval.sql', '20261115214706_ads_manager.sql', '20261116162058_ads_budget_periods_and_locations.sql', '20261116165528_client_reporting.sql', '20261116173001_client_portal.sql', '20261116173041_agent_operations.sql', '20261116182243_direct_facebook.sql', '20261116193311_internal_billing.sql','20261120055408_x_caption_variants.sql']) {
    await db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  for (const user of [admin, userA, userB, otherAdmin]) {
    await db.query('insert into auth.users values ($1)', [user]);
    await db.query('insert into public.profiles (id) values ($1)', [user]);
  }
  await db.query("insert into public.agencies (id,name) values ($1,'Thagana Solutions'),($2,'Fictional Test Agency')", [agency, otherAgency]);
  await db.query('insert into public.agency_memberships (agency_id,user_id) values ($1,$2),($3,$4)', [agency,admin,otherAgency,otherAdmin]);
  await db.query(`
    insert into public.clients (id,agency_id,business_name,industry,location,status,internal_notes)
    values ($1,$4,'Thagana Solutions','Digital Marketing and Technology Services','Kiserian','active','Private A'),
      ($2,$4,'Fictional Test Client','Retail Shop','Ngong','active','Private B'),
      ($3,$5,'Fictional External Client','Other','Nairobi','active','Private C')
  `, [clientA, clientB, otherClient, agency, otherAgency]);
  await db.query('insert into public.client_memberships (client_id,user_id) values ($1,$2),($3,$4)', [clientA,userA,clientB,userB]);
});
after(() => db.close());

test('two client identities only see their assigned safe projections', async () => {
  for (const [user, client] of [[userA,clientA],[userB,clientB]]) {
    await as(user, async () => {
      const { rows } = await db.query('select * from public.assigned_businesses()');
      assert.deepEqual(rows.map(row => row.id), [client]);
      assert.deepEqual(Object.keys(rows[0]), ['id','business_name','location','industry']);
      for (const table of ['clients','agencies','agency_memberships','audit_logs']) {
        assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
      }
      await assert.rejects(db.query("update public.client_memberships set role = 'administrator'"), /permission denied/);
      assert.equal((await db.query("update public.clients set business_name = 'Forbidden' where id = $1 returning id", [client])).rows.length, 0);
    });
  }
});

test('anonymous access and cross-agency administrator writes are denied', async () => {
  await as(null, async () => {
    await assert.rejects(db.query('select * from public.clients'), /permission denied/);
    await assert.rejects(db.query('select * from public.assigned_businesses()'), /permission denied/);
  }, 'anon');
  await as(admin, async () => {
    assert.deepEqual((await db.query('select id from public.clients order by id')).rows.map(row => row.id), [clientA,clientB]);
    assert.equal((await db.query("update public.clients set business_name = 'Forbidden' where id = $1 returning id", [otherClient])).rows.length, 0);
    await assert.rejects(db.query("insert into public.clients (agency_id,business_name,industry,location) values ($1,'Forbidden','Retail','Nairobi')", [otherAgency]), /row-level security/);
  });
});

test('create, edit, audit and archive persisted records atomically', async () => {
  await as(admin, async () => {
    const call = (id, updated, details, brand, services) => db.query(
      'select public.save_client($1,$2,$3,$4,$5,$6) as id',
      [agency,id,updated,JSON.stringify(details),JSON.stringify(brand),JSON.stringify(services)]
    );
    const details = {business_name:'Fictional CRUD Test',industry:'Retail Shop',location:'Kiserian',status:'onboarding'};
    const { rows: [{id}] } = await call(null,null,details,{brand_name:'Fictional Brand'},[{name:'Example Service',price_kes:100}]);
    const { rows: [{ updated_at }] } = await db.query('select updated_at::text from public.clients where id=$1', [id]);
    const { rows: [{ id: service }] } = await db.query('select id from public.client_services where client_id=$1', [id]);
    await assert.rejects(call(id,updated_at,{...details,status:'active'},{brand_name:'Failed write'},[{name:'Broken',price_kes:-1}]), /check constraint/);
    assert.equal((await db.query('select brand_name from public.client_brand_profiles where client_id=$1', [id])).rows[0].brand_name, 'Fictional Brand');
    await call(id,updated_at,{...details,status:'active'},{brand_name:'Updated Brand'},[{id:service,name:'Example Service',price_kes:120}]);
    await assert.rejects(call(id,updated_at,details,{brand_name:'Stale write'},[]), /Client changed/);
    assert.equal(Number((await db.query('select price_kes from public.client_services where id=$1',[service])).rows[0].price_kes), 120);
    await db.query("update public.clients set status='archived' where id=$1", [id]);
    const { rows: [archived] } = await db.query('select status,archived_at from public.clients where id=$1', [id]);
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archived_at);
    const { rows: audit } = await db.query('select action,actor_id from public.audit_logs where client_id=$1', [id]);
    assert.ok(audit.some(row => row.action === 'Client archived' && row.actor_id === admin));
    await assert.rejects(db.query('delete from public.clients where id=$1', [id]), /permission denied/);
  });
});

test('Studio revisions, approval and quota are enforced by the database', async () => {
  let draftId;
  await as(admin, async () => {
    const { rows } = await db.query(`
      insert into public.content_calendar (client_id,title,caption,platform,format)
      values ($1,'Draft A','Initial caption','Instagram','Image Post') returning id,status,revision
    `, [clientA]);
    const [{id,status,revision}] = rows;
    draftId = id;
    assert.equal(status,'draft');
    assert.equal(revision,1);
    await db.query("update public.content_calendar set status='approved' where id=$1",[id]);
    assert.deepEqual((await db.query('select revision,approved_by from public.content_approvals where content_id=$1',[id])).rows,
      [{revision:1,approved_by:admin}]);
    const revised = await db.query("update public.content_calendar set caption='Edited caption' where id=$1 returning revision,status",[id]);
    assert.deepEqual(revised.rows,[{revision:2,status:'draft'}]);
    const history = await db.query("select snapshot->>'caption' as caption from public.content_revisions where content_id=$1 order by revision",[id]);
    assert.deepEqual(history.rows.map(row => row.caption),['Initial caption','Edited caption']);
    for (let i = 0; i < 7; i++) {
      const { rows: [reservation] } = await db.query('select public.reserve_content_generation($1) as ok',[clientA]);
      assert.equal(reservation.ok,i < 6);
    }
    await assert.rejects(db.query(`
      insert into public.content_calendar (client_id,title,platform,format)
      values ($1,'Other agency','Instagram','Image Post')
    `,[otherClient]), /row-level security/);
  });
  for (const user of [userA, userB, otherAdmin]) await as(user,async () => {
    assert.equal((await db.query('select id from public.content_calendar where id=$1',[draftId])).rows.length,0);
    assert.equal((await db.query('select revision from public.content_approvals where content_id=$1',[draftId])).rows.length,0);
    assert.equal((await db.query('select public.reserve_content_generation($1) as ok',[clientA])).rows[0].ok,false);
  });
});

test('media access and the schedule stay scoped to the approved revision', async () => {
  const assetId='40000000-0000-4000-8000-000000000001';
  const path=`${clientA}/${assetId}.png`;
  let itemId;
  await as(admin,async () => {
    await assert.rejects(db.query(
      "insert into storage.objects (bucket_id,name,owner_id) values ('tsols-media',$1,$2)",[`${otherClient}/${assetId}.png`,admin]
    ), /row-level security/);
    await db.query("insert into storage.objects (bucket_id,name,owner_id) values ('tsols-media',$1,$2)",[path,admin]);
    await db.query(`insert into public.media_assets (id,client_id,name,object_path,mime_type,bytes,source)
      values ($1,$2,'Photo',$3,'image/png',10,'upload')`,[assetId,clientA,path]);
    await assert.rejects(db.query(`insert into public.content_calendar (client_id,title,caption,platform,format,media_asset_id)
      values ($1,'Different tenant','Copy','Instagram','Image Post',$2)`,[clientB,assetId]), /foreign key constraint/);
    const draft = await db.query(`insert into public.content_calendar (client_id,title,caption,platform,format,media_asset_id)
      values ($1,'Scheduled test','Copy','Instagram','Image Post',$2) returning id`,[clientA,assetId]);
    itemId=draft.rows[0].id;
    const plan=() => db.query("update public.content_calendar set scheduled_at=now()+interval '1 day' where id=$1 returning scheduled_at",[itemId]);
    await assert.rejects(plan(), /Approve the saved revision/);
    await db.query("update public.content_calendar set status='pending_approval' where id=$1",[itemId]);
    await assert.rejects(db.query("update public.content_calendar set status='approved' where id=$1",[itemId]), /Approve the attached image/);
    await db.query('update public.media_assets set approved_at=now() where id=$1',[assetId]);
    await db.query("update public.content_calendar set status='approved' where id=$1",[itemId]);
    assert.ok((await plan()).rows[0].scheduled_at);
    await db.query('update public.content_calendar set schedule_cancelled_at=now() where id=$1',[itemId]);
    await db.query("update public.content_calendar set scheduled_at=now()+interval '2 days',schedule_cancelled_at=null where id=$1",[itemId]);
    const revised=await db.query("update public.content_calendar set title='Edited' where id=$1 returning status,scheduled_at,revision",[itemId]);
    assert.deepEqual(revised.rows,[{status:'draft',scheduled_at:null,revision:2}]);
  });
  for (const user of [userA,userB,otherAdmin]) await as(user,async () => {
    assert.equal((await db.query('select name from storage.objects')).rows.length,0);
    assert.equal((await db.query('select id from public.media_assets where id=$1',[assetId])).rows.length,0);
    assert.equal((await db.query('select id from public.content_calendar where id=$1',[itemId])).rows.length,0);
  });
});

test('manual video posts are immediately ready, AI stays in review, and receipts cannot be forged', async () => {
  const assetId='40000000-0000-4000-8000-000000000010';
  const path=`${clientA}/${assetId}.mp4`;
  let postId;
  let accountId;
  await as(admin,async () => {
    await db.query("insert into storage.objects (bucket_id,name,owner_id) values ('tsols-media',$1,$2)",[path,admin]);
    await db.query(`insert into public.media_assets(id,client_id,name,object_path,mime_type,bytes,source)
      values ($1,$2,'Video',$3,'video/mp4',20000000,'upload')`,[assetId,clientA,path]);
    const manual=await db.query(`insert into public.content_calendar(client_id,title,caption,platform,format,content_origin,media_asset_id)
      values($1,'Manual test','','Other','Reel Idea','manual',$2) returning id,status`,[clientA,assetId]);
    postId=manual.rows[0].id;
    assert.equal(manual.rows[0].status,'approved');
    assert.equal((await db.query('select approval_kind from public.content_approvals where content_id=$1',[postId])).rows[0].approval_kind,'manual');
    const ai=await db.query(`insert into public.content_calendar(client_id,title,caption,platform,format)
      values($1,'AI test','Copy','Instagram','Image Post') returning id,status,content_origin`,[clientA]);
    assert.equal(ai.rows[0].status,'draft');
    assert.equal(ai.rows[0].content_origin,'ai');
    await assert.rejects(db.query("update public.content_calendar set content_origin='manual' where id=$1",[ai.rows[0].id]),/Only older drafts/);
    accountId=(await db.query(`insert into public.publishing_accounts(client_id,buffer_channel_id,name,platform)
      values($1,'test-channel-001','Test account','instagram') returning id`,[clientA])).rows[0].id;
    await assert.rejects(db.query(`insert into public.publishing_deliveries(content_id,client_id,revision,account_id,status,external_post_id)
      values($1,$2,1,$3,'submitted','fake')`,[postId,clientA,accountId]),/permission denied/);
  });
  await db.query(`insert into public.publishing_deliveries(content_id,client_id,revision,account_id)
    values($1,$2,1,$3)`,[postId,clientA,accountId]);
  const duplicate=await db.query(`insert into public.publishing_deliveries(content_id,client_id,revision,account_id)
    values($1,$2,1,$3) on conflict do nothing returning account_id`,[postId,clientA,accountId]);
  assert.equal(duplicate.rows.length,0);
  await as(otherAdmin,async () => {
    assert.equal((await db.query('select id from public.publishing_accounts where id=$1',[accountId])).rows.length,0);
    assert.equal((await db.query('select account_id from public.publishing_deliveries where content_id=$1',[postId])).rows.length,0);
  });
});

test('delegated Buffer schedules lock the revision and allow one safe retry', async () => {
  let postId; let accountId;
  const future='2099-01-02T04:00:00Z';
  await as(admin,async () => {
    const post=await db.query("insert into public.content_calendar(client_id,title,caption,platform,format,content_origin) values($1,'Buffer plan','Copy','Facebook','Text Post','manual') returning id",[clientA]);
    postId=post.rows[0].id;
    await db.query('update public.content_calendar set scheduled_at=$1 where id=$2',[future,postId]);
    const account=await db.query("insert into public.publishing_accounts(client_id,buffer_channel_id,name,platform) values($1,'buffer-test-scheduled','Test channel','facebook') returning id",[clientA]);
    accountId=account.rows[0].id;
  });
  const reserve=()=>db.query('insert into public.publishing_deliveries(content_id,client_id,revision,account_id,due_at) values($1,$2,1,$3,$4)',[postId,clientA,accountId,future]);
  await as(null,reserve,'service_role');
  await as(admin,async () => {
    await assert.rejects(db.query("update public.content_calendar set title='Unsafe edit' where id=$1",[postId]),/live Buffer schedule/);
    await assert.rejects(db.query('update public.content_calendar set schedule_cancelled_at=now() where id=$1',[postId]),/live Buffer schedule/);
  });
  await as(null,async () => {
    await db.query("update public.publishing_deliveries set status='rejected',failure_code='rate_limited' where content_id=$1",[postId]);
    await db.query("update public.publishing_deliveries set status='sending',attempt_count=2,failure_code=null where content_id=$1",[postId]);
    await db.query("update public.publishing_deliveries set status='submitted',external_post_id='buffer-post-test',provider_status='scheduled' where content_id=$1",[postId]);
    await assert.rejects(db.query("update public.publishing_deliveries set status='sending',external_post_id=null where content_id=$1",[postId]),/cannot be retried/);
    await db.query("update public.publishing_deliveries set provider_status='cancelled' where content_id=$1",[postId]);
  },'service_role');
  await as(admin,async () => {
    await db.query('update public.content_calendar set schedule_cancelled_at=now() where id=$1',[postId]);
    const events=await db.query('select status,provider_status,attempt_count from public.publishing_events where content_id=$1 order by created_at',[postId]);
    assert.equal(events.rows.length,5);
    assert.equal(events.rows.at(-1).provider_status,'cancelled');
  });
  await as(otherAdmin,async () => {
    assert.equal((await db.query('select id from public.publishing_events where content_id=$1',[postId])).rows.length,0);
  });
});

test('the administrator approves directly and can classify an older draft as manual',async()=>{
  await as(admin,async()=>{
    const legacy=await db.query(`insert into public.content_calendar(client_id,title,caption,platform,format,content_origin)
      values($1,'Older manual','Caption','Facebook','Text Post','unclassified') returning id`,[clientA]);
    const id=legacy.rows[0].id;
    const result=await db.query("update public.content_calendar set content_origin='manual' where id=$1 returning content_origin,status,revision",[id]);
    assert.deepEqual(result.rows,[{content_origin:'manual',status:'approved',revision:2}]);
    const receipt=await db.query('select approval_kind from public.content_approvals where content_id=$1 and revision=2',[id]);
    assert.equal(receipt.rows[0].approval_kind,'manual');
    const other=await db.query(`insert into public.content_calendar(client_id,title,platform,format)
      values($1,'Blank AI draft','Facebook','Text Post') returning id`,[clientA]);
    await assert.rejects(db.query("update public.content_calendar set status='approved' where id=$1",[other.rows[0].id]),/Add a caption/);
  });
});

test('website capture stays tenant-bound and WhatsApp requires consent and a 24-hour delay',async()=>{
  const digest='a'.repeat(64);
  const opted={name:'Fictional lead',phone:'0712 345 678',whatsapp_number:'0712345678',email:'fixture@example.invalid',intent:'quotation',whatsapp_opt_in:true};
  let leadId;
  await as(admin,async()=>{
    await db.query("insert into public.lead_intake_links(client_id,label,token_hash) values($1,'Test form',$2)",[clientA,digest]);
    await db.query("insert into public.whatsapp_settings(client_id,welcome_enabled,follow_up_enabled,welcome_delay_minutes) values($1,true,true,0)",[clientA]);
    await assert.rejects(db.query("select public.capture_website_lead($1,$2)",[digest,JSON.stringify(opted)]),/permission denied/);
  });
  await as(null,async()=>{
    assert.equal((await db.query("select public.capture_website_lead($1,$2) as result",['b'.repeat(64),JSON.stringify(opted)])).rows[0].result,'invalid_token');
    await db.query("select public.capture_website_lead($1,$2)",[digest,JSON.stringify(opted)]);
    await db.query("select public.capture_website_lead($1,$2)",[digest,JSON.stringify({...opted,phone:'+254712345678'})]);
    const records=await db.query("select id,client_id,priority,phone,consent_status from public.leads where email='fixture@example.invalid'");
    assert.equal(records.rows.length,1);
    ({id:leadId}=records.rows[0]);
    assert.deepEqual(records.rows[0],{id:leadId,client_id:clientA,priority:'hot',phone:'+254712345678',consent_status:'opted_in'});
    assert.equal((await db.query('select * from public.claim_whatsapp_jobs($1)',[otherClient])).rows.length,0);
    const {rows:[job]}=await db.query('select * from public.claim_whatsapp_jobs($1)',[clientA]);
    assert.equal(job.message_kind,'welcome');
    assert.equal((await db.query('select * from public.claim_whatsapp_jobs($1)',[clientA])).rows.length,0);
    await db.query("update public.whatsapp_messages set status='accepted',provider_id='fixture-welcome' where id=$1",[job.message_id]);
    const follow=await db.query("select status,scheduled_at>now()+interval '23 hours' as delayed from public.whatsapp_messages where lead_id=$1 and kind='follow_up'",[leadId]);
    assert.deepEqual(follow.rows,[{status:'queued',delayed:true}]);
    await db.query("select public.record_whatsapp_reply($1,'fixture-opt-out','+254712345678',true)",[clientA]);
    await db.query("select public.record_whatsapp_reply($1,'fixture-opt-out','+254712345678',true)",[clientA]);
    assert.equal((await db.query("select consent_status from public.leads where id=$1",[leadId])).rows[0].consent_status,'opted_out');
    assert.equal((await db.query("select status from public.whatsapp_messages where lead_id=$1 and kind='follow_up'",[leadId])).rows[0].status,'skipped');
  },'service_role');
  for(const visitor of [userA,userB,otherAdmin])await as(visitor,async()=>{
    assert.equal((await db.query('select id from public.leads where id=$1',[leadId])).rows.length,0);
    assert.equal((await db.query('select id from public.lead_activities where lead_id=$1',[leadId])).rows.length,0);
  });
});

test('ad plans enforce monthly caps and imported reports remain client scoped',async()=>{
  let planId;
  let accountId;
  await as(admin,async()=>{
    await db.query('update public.clients set monthly_ad_budget_kes=10000 where id=$1',[clientA]);
    const make=(name,amount,start,end)=>db.query(`insert into public.ad_campaigns
      (client_id,platform,name,objective,monthly_budget_kes,start_date,end_date,target_location)
      values($1,'meta',$2,'Leads',$3,$4,$5,'Kiserian') returning id`,[clientA,name,amount,start,end]);
    planId=(await make('First campaign',6000,'2099-01-05','2099-02-03')).rows[0].id;
    const second=(await make('Overlapping campaign',5000,'2099-02-28','2099-03-05')).rows[0].id;
    await db.query("update public.ad_campaigns set plan_status='approved' where id=$1",[planId]);
    await assert.rejects(db.query("update public.ad_campaigns set plan_status='approved' where id=$1",[second]),/exceed the client’s monthly/);
    await assert.rejects(db.query('update public.clients set monthly_ad_budget_kes=3000 where id=$1',[clientA]),/below an approved/);
    const current=await db.query("select * from public.ad_budget_for_month($1,'2099-02-01')",[clientA]);
    assert.equal(Number(current.rows[0].approved_amount),6000);
    await db.query("update public.ad_campaigns set creative='Amended' where id=$1",[planId]);
    assert.deepEqual((await db.query('select plan_status,revision from public.ad_campaigns where id=$1',[planId])).rows,[{plan_status:'draft',revision:2}]);
    assert.equal((await db.query('select revision from public.ad_plan_approvals where campaign_id=$1',[planId])).rows.length,1);
    accountId=(await db.query(`insert into public.ad_accounts(client_id,platform,external_account_id,label)
      values($1,'meta','12345001','Test account') returning id`,[clientA])).rows[0].id;
    await assert.rejects(db.query("update public.ad_accounts set currency='USD' where id=$1",[accountId]),/permission denied/);
  });
  await as(null,async()=>{
    const row={external_campaign_id:'1234',campaign_name:'A campaign',report_date:'2026-10-01',spend:20,impressions:200,reach:120,clicks:6,leads:2,conversions:null,conversion_label:null};
    const sync=(spend,rate)=>db.query("select public.ingest_ad_performance($1,$2,'USD','Africa/Nairobi','2026-10-01','2026-10-01',$3,$4,$5,$6)",
      [accountId,admin,rate,rate?'Agency recorded rate':null,rate?'2026-10-01':null,JSON.stringify([{...row,spend}])]);
    await sync(20,125);
    await sync(21,null);
  },'service_role');
  await as(admin,async()=>{
    assert.equal((await db.query("select currency from public.ad_accounts where id=$1",[accountId])).rows[0].currency,'USD');
    const report=await db.query("select * from public.ad_performance_summary($1,'2026-10-01','2026-10-01')",[accountId]);
    assert.equal(Number(report.rows[0].row_count),1);
    assert.equal(Number(report.rows[0].native_spend),21);
    assert.equal(Number(report.rows[0].reported_spend_kes),2625);
    assert.equal(Number(report.rows[0].leads),2);
  });
  for(const identity of [userA,userB,otherAdmin])await as(identity,async()=>{
    assert.equal((await db.query('select id from public.ad_campaigns where id=$1',[planId])).rows.length,0);
    assert.equal((await db.query('select account_id from public.ad_performance_snapshots where account_id=$1',[accountId])).rows.length,0);
  });
});

test('daily ad budgets use active days, and ongoing plans include future long months',async()=>{
  await as(admin,async()=>{
    await db.query('update public.clients set monthly_ad_budget_kes=3000 where id=$1',[clientB]);
    const targets=[{scope:'country',name:'Kenya'},{scope:'country',name:'Uganda'},{scope:'local',name:'Nairobi'}];
    const {rows:[plan]}=await db.query(`insert into public.ad_campaigns
      (client_id,platform,name,objective,budget_mode,daily_budget_kes,start_date,end_date,target_locations)
      values($1,'google','Ongoing campaign','Traffic','daily',100,'2099-02-01',null,$2)
      returning id,end_time,target_locations,target_location`,[clientB,JSON.stringify(targets)]);
    assert.equal(plan.end_time,null);
    assert.equal(plan.target_location,'Kenya');
    assert.deepEqual(plan.target_locations,targets);
    await assert.rejects(db.query("update public.ad_campaigns set plan_status='approved' where id=$1",[plan.id]),/exceed the client’s monthly/);
    await db.query('update public.ad_campaigns set monthly_budget_kes=2900 where id=$1',[plan.id]);
    await db.query("update public.ad_campaigns set plan_status='approved' where id=$1",[plan.id]);
    const budget=day=>db.query('select approved_amount from public.ad_budget_for_month($1,$2)',[clientB,day]);
    assert.equal(Number((await budget('2099-02-01')).rows[0].approved_amount),2800);
    assert.equal(Number((await budget('2099-03-01')).rows[0].approved_amount),2900);
    await db.query("update public.ad_campaigns set plan_status='archived' where id=$1",[plan.id]);
    const {rows:[fixed]}=await db.query(`insert into public.ad_campaigns
      (client_id,platform,name,objective,budget_mode,daily_budget_kes,start_date,start_time,end_date,end_time,target_locations)
      values($1,'meta','Fixed campaign','Traffic','daily',100,'2099-02-20','15:00','2099-02-28','10:00',$2)
      returning id`,[clientB,JSON.stringify(targets)]);
    await db.query("update public.ad_campaigns set plan_status='approved' where id=$1",[fixed.id]);
    assert.equal(Number((await budget('2099-02-01')).rows[0].approved_amount),900);
    await assert.rejects(db.query('update public.ad_campaigns set target_locations=$1 where id=$2',
      [JSON.stringify([...targets,{scope:'country',name:'kenya'}]),fixed.id]),/distinct city, region, or whole-country/);
  });
});

test('reports snapshot verified metrics, enforce review, and isolate tenants',async()=>{
  let reportId;
  let draftId;
  let accountId;
  await as(admin,async()=>{
    await db.query("update public.clients set contact_email='reports@example.invalid' where id=$1",[clientA]);
    draftId=(await db.query(`insert into public.content_calendar(client_id,title,caption,platform,format,content_origin)
      values($1,'Sent report fixture','Caption','Facebook','Text Post','manual') returning id`,[clientA])).rows[0].id;
    accountId=(await db.query(`insert into public.publishing_accounts(client_id,buffer_channel_id,name,platform)
      values($1,'report-fixture-channel','Report account','facebook') returning id`,[clientA])).rows[0].id;
  });
  await db.query(`insert into public.publishing_deliveries(content_id,client_id,revision,account_id,status,external_post_id,provider_status,provider_sent_at)
    values($1,$2,1,$3,'submitted','report-fixture-provider','sent',now())`,[draftId,clientA,accountId]);
  await as(admin,async()=>{
    const {rows:[newReport]}=await db.query(`select public.create_client_report($1,'weekly',
      (now() at time zone 'Africa/Nairobi')::date) as id`,[clientA]);
    reportId=newReport.id;
    const {rows:[snapshot]}=await db.query('select metrics,recipient_email,version,partial_period from public.reports where id=$1',[reportId]);
    assert.equal(snapshot.metrics.posts_published,1);
    assert.equal(snapshot.metrics.confirmed_deliveries,1);
    assert.equal(snapshot.metrics.organic_reach,null);
    assert.equal(snapshot.recipient_email,'reports@example.invalid');
    assert.equal(snapshot.version,1);
    assert.equal(snapshot.partial_period,true);
    await assert.rejects(db.query("update public.reports set metrics='{}' where id=$1",[reportId]),/permission denied/);
    await db.query("update public.reports set observations='Reviewed notes' where id=$1",[reportId]);
    await db.query("update public.reports set status='approved' where id=$1",[reportId]);
    await assert.rejects(db.query("update public.reports set observations='Changed' where id=$1",[reportId]),/new report version/);
    await assert.rejects(db.query("select public.create_client_report($1,'weekly',(now() at time zone 'Africa/Nairobi')::date)",[otherClient]),/unavailable/);
  });
  await as(null,async()=>{
    const claim=(recipient)=>db.query('insert into public.report_deliveries(report_id,client_id,recipient_email) values($1,$2,$3)',
      [reportId,clientA,recipient]);
    await assert.rejects(claim('wrong@example.invalid'),/client’s current email/);
    await claim('reports@example.invalid');
    await db.query("update public.report_deliveries set status='accepted',provider_id='resend-fixture' where report_id=$1",[reportId]);
  },'service_role');
  await as(otherAdmin,async()=>{
    assert.equal((await db.query('select id from public.reports where id=$1',[reportId])).rows.length,0);
    assert.equal((await db.query('select report_id from public.report_deliveries where report_id=$1',[reportId])).rows.length,0);
  });
});

test('portal invitations require verified matching email and support independent revocation', async () => {
  const verified = '10000000-0000-4000-8000-000000000030';
  const unverified = '10000000-0000-4000-8000-000000000031';
  const second = '10000000-0000-4000-8000-000000000032';
  await db.query("insert into auth.users values ($1,'client.one@example.test',now()),($2,'client.pending@example.test',null),($3,'client.two@example.test',now())", [verified,unverified,second]);
  const invite = (client,email) => db.query("select public.manage_client_portal_access($1,$2,null) as id",[client,email]);
  const invitation = await as(admin,async()=>{
    const result=await invite(clientA,'Client.One@Example.Test');
    await invite(clientA,'client.pending@example.test');
    await invite(clientA,'client.two@example.test');
    assert.equal((await invite(clientA,'client.one@example.test')).rows[0].id,result.rows[0].id);
    await assert.rejects(invite(otherClient,'client.one@example.test'),/unavailable/);
    return result.rows[0].id;
  });
  await as(userB,async()=>{
    assert.equal((await db.query('select * from public.claim_client_portal_access()')).rows[0].claim_client_portal_access,0);
    assert.equal((await db.query('select * from public.client_portal_invitations')).rows.length,0);
    await assert.rejects(invite(clientB,'client.one@example.test'),/unavailable/);
  });
  await as(unverified,async()=>{
    assert.equal((await db.query('select * from public.claim_client_portal_access()')).rows[0].claim_client_portal_access,0);
    assert.deepEqual((await db.query('select id from public.assigned_businesses()')).rows,[]);
  });
  for(const clientUser of [verified,second]){
    await as(clientUser,async()=>{
      assert.equal((await db.query('select * from public.claim_client_portal_access()')).rows[0].claim_client_portal_access,1);
      assert.deepEqual((await db.query('select id from public.assigned_businesses()')).rows,[{id:clientA}]);
      assert.equal((await db.query('select * from public.claim_client_portal_access()')).rows[0].claim_client_portal_access,0);
    });
  }
  await as(admin,()=>db.query('select public.manage_client_portal_access($1,null,$2)',[clientA,invitation]));
  await as(verified,async()=>{
    assert.deepEqual((await db.query('select id from public.assigned_businesses()')).rows,[]);
    await assert.rejects(db.query("select public.client_portal_page($1,'overview')",[clientA]),/unavailable/);
  });
  await as(second,async()=>{
    assert.deepEqual((await db.query('select id from public.assigned_businesses()')).rows,[{id:clientA}]);
  });
});

test('each client can open all eight portal pages for its business and raw records stay private', async () => {
  await db.query("insert into public.leads(client_id,name,email,source,notes) values ($1,'Portal Lead A','portal-a@example.test','Manual Entry','Agency-only note'),($2,'Portal Lead B','portal-b@example.test','Manual Entry','Other agency-only note')",[clientA,clientB]);
  await as(admin,async()=>{
    await db.query("insert into public.content_calendar(client_id,title,platform,format,content_origin) values ($1,'Hidden portal draft','Instagram','Image Post','manual')",[clientA]);
    await db.query("select public.create_client_report($1,'weekly','2025-01-15')",[clientA]);
  });
  const read = (client,section) => db.query('select public.client_portal_page($1,$2) as data',[client,section]).then(result=>result.rows[0].data);
  const sections=['overview','content','calendar','leads','advertising','reports','profile','package'];
  for(const [user,own,other,label] of [[userA,clientA,clientB,'A'],[userB,clientB,clientA,'B']]){
    await as(user,async()=>{
      for(const section of sections){
        assert.ok(await read(own,section));
        await assert.rejects(read(other,section),/unavailable/);
      }
      const leads=await read(own,'leads');
      assert.ok(leads.some(lead=>lead.name==='Portal Lead '+label));
      assert.ok(leads.every(lead=>!Object.hasOwn(lead,'notes')));
      assert.equal((await read(own,'content')).some(item=>item.title==='Hidden portal draft'),false);
      assert.equal((await read(own,'reports')).some(report=>report.period_start==='2025-01-13'),false);
      assert.equal(Object.hasOwn(await read(own,'profile'),'internal_notes'),false);
      for(const table of ['clients','leads','ad_campaigns','ad_accounts','reports','audit_logs','publishing_accounts','lead_activities']){
        assert.deepEqual((await db.query('select * from public.'+table)).rows,[]);
      }
    });
  }
  await as(null,async()=>{
    await assert.rejects(read(clientA,'profile'),/permission denied/);
  },'anon');
});

test('agent standard workflows require assignment and approval, log one execution and isolate clients', async () => {
  const configure=(client,kind,enabled,cadence=null)=>db.query('select public.configure_agent($1,$2,$3,$4)',[client,kind,enabled,cadence]);
  const request=(client,kind,mode,brief)=>db.query('select public.request_agent_task($1,$2,$3,$4) as id',[client,kind,mode,brief]).then(x=>x.rows[0].id);
  const transition=(id,action)=>db.query('select public.transition_agent_task($1,$2)',[id,action]);
  const run=id=>db.query('select public.run_manual_agent($1) as ran',[id]).then(x=>x.rows[0].ran);
  const engagementId=await as(admin,async()=>{
    await assert.rejects(request(clientA,'engagement','standard','hello'),/Enable this agent/);
    await configure(clientA,'engagement',true);
    const id=await request(clientA,'engagement','standard','My refund never arrived');
    assert.equal(await request(clientA,'engagement','standard','My refund never arrived'),id);
    assert.equal(await run(id),false);
    await transition(id,'approve');
    await configure(clientA,'engagement',false);
    assert.equal(await run(id),false);
    await configure(clientA,'engagement',true);
    assert.equal(await run(id),true);
    assert.equal(await run(id),false);
    const {rows:[task]}=await db.query('select status,recommendation,attempts from public.agent_tasks where id=$1',[id]);
    assert.equal(task.status,'completed');assert.equal(task.attempts,1);
    assert.match(task.recommendation,/Complaint/);
    assert.deepEqual((await db.query('select event from public.agent_events where task_id=$1 order by id',[id])).rows.map(row=>row.event),
      ['requested','approved','started','completed']);
    assert.equal((await db.query('select completed from public.agent_dashboard($1)',[clientA])).rows[0].completed,1);
    return id;
  });
  for(const actor of [userA,userB,otherAdmin]){
    await as(actor,async()=>{
      assert.equal((await db.query('select * from public.agent_tasks')).rows.length,0);
      assert.equal((await db.query('select * from public.agent_dashboard($1)',[clientA])).rows.length,0);
      assert.equal(await run(engagementId),false);
      await assert.rejects(configure(clientA,'engagement',true),/unavailable/);
    });
  }
});

test('AI attempts are single-claim, scoped, capped at one retry and finalized only by the worker', async () => {
  const id=await as(admin,async()=>{
    await db.query("select public.configure_agent($1,'design',true,null)",[clientA]);
    const {rows:[task]}=await db.query("select public.request_agent_task($1,'design','ai','') as id",[clientA]);
    await db.query("select public.transition_agent_task($1,'approve')",[task.id]);
    await assert.rejects(db.query('select public.start_ai_agent($1,$2)',[task.id,admin]),/permission denied/);
    return task.id;
  });
  const start=actor=>db.query('select public.start_ai_agent($1,$2) as job',[id,actor]).then(result=>result.rows[0].job);
  const finish=(attempt,error)=>db.query("select public.finish_ai_agent($1,$2,null,$3,'test-model',null,null,null) as ok",[id,attempt,error]).then(x=>x.rows[0].ok);
  await as(null,async()=>{
    assert.equal((await start(otherAdmin))?.id??null,null);
    assert.equal((await start(admin)).attempts,1);
    assert.equal((await start(admin))?.id??null,null);
    assert.equal(await finish(1,'Simulated provider error'),true);
  },'service_role');
  await as(admin,()=>db.query("select public.transition_agent_task($1,'retry')",[id]));
  await as(null,async()=>{
    assert.equal((await start(admin)).attempts,2);
    assert.equal(await finish(1,'Stale finish attempt'),false);
    assert.equal(await finish(2,'Simulated retry failure'),true);
  },'service_role');
  await as(admin,async()=>{
    await assert.rejects(db.query("select public.transition_agent_task($1,'retry')",[id]),/cannot make/);
    await assert.rejects(db.query("select public.finish_ai_agent($1,2,'Forged',null,null,null,null,null)",[id]),/permission denied/);
  });
});

test('scheduler processes approved standard work, records heartbeats, and deduplicates recurring tasks', async () => {
  const id=await as(admin,async()=>{
    await db.query("select public.configure_agent($1,'content',true,'daily')",[clientA]);
    const {rows:[task]}=await db.query("select public.request_agent_task($1,'content','standard','') as id",[clientA]);
    await db.query("select public.transition_agent_task($1,'approve')",[task.id]);
    return task.id;
  });
  await db.query('select tsols_private.agent_tick()');
  await db.query('select tsols_private.agent_tick()');
  await as(admin,async()=>{
    assert.equal((await db.query('select status from public.agent_tasks where id=$1',[id])).rows[0].status,'completed');
    const {rows:[row]}=await db.query("select count(*)::int as count from public.agent_tasks where client_id=$1 and agent='content' and recurring_period is not null",[clientA]);
    assert.ok(row.count<=1);
    assert.ok((await db.query('select public.agent_worker_last_tick($1) as tick',[clientA])).rows[0].tick);
  });
  await as(userA,async()=>{
    assert.equal((await db.query('select public.agent_worker_last_tick($1) as tick',[clientA])).rows[0].tick,null);
  });
});

test('billing snapshots client terms, separates ad budgets, and limits manual payment and records to agency admins', async () => {
  const makeTerms=(plan,fee)=>db.query("select public.save_billing_terms($1,$2,$3,20000,'2027-01-01','active','Test internal note')",[clientA,plan,fee]);
  const issue=()=>db.query("select public.issue_billing_invoice($1,'2025-01-15','2025-01-03','2025-01-31','Test invoice') as id",[clientA]);
  const pay=id=>db.query("select public.complete_billing_invoice($1,'pay','Receipt 001','2025-01-10')",[id]);
  const id=await as(admin,async()=>{
    const {rows:[starter]}=await db.query("insert into public.billing_packages(agency_id,name,monthly_fee_kes) values ($1,'TSOLS Starter',15000) returning id",[agency]);
    await makeTerms(starter.id,null);
    const {rows:[invoice]}=await issue();
    await assert.rejects(issue(),/already has an invoice/);
    await makeTerms(starter.id,17000);
    const {rows:[row]}=await db.query("select service_fee_kes,ad_budget_kes from public.billing_invoices where id=$1",[invoice.id]);
    assert.equal(Number(row.service_fee_kes),15000);assert.equal(Number(row.ad_budget_kes),20000);
    await db.query("insert into public.billing_costs(agency_id,incurred_on,description,category,amount_kes) values($1,'2025-01-15','Test cost','Software',3000)",[agency]);
    const read=()=>db.query("select public.billing_month_summary($1,'2025-01-17') as data",[agency]).then(x=>x.rows[0].data);
    const open=await read();assert.equal(open.unpaid,15000);assert.equal(open.margin,12000);assert.equal(open.margin_pct,80);
    await pay(invoice.id);
    await assert.rejects(pay(invoice.id),/Only an unpaid invoice/);
    assert.equal((await read()).paid,15000);
    assert.equal((await read()).unpaid,0);
    assert.ok((await db.query('select public.billing_launch_exceptions($1) as stats',[agency])).rows[0].stats);
    return invoice.id;
  });
  for(const actor of [userA,userB,otherAdmin]){
    await as(actor,async()=>{
      assert.deepEqual((await db.query('select * from public.billing_invoices')).rows,[]);
      assert.deepEqual((await db.query('select * from public.billing_costs where agency_id=$1',[agency])).rows,[]);
      assert.deepEqual((await db.query('select * from public.billing_subscriptions')).rows,[]);
      await assert.rejects(pay(id),/unavailable/);
    });
  }
  await as(null,()=>assert.rejects(db.query('select * from public.billing_invoices'),/permission denied/),'anon');
});


test('X variants require review, lock after approval, and expire with source revisions',async()=>{
 const content=await as(admin,async()=>{
  const {rows:[client]}=await db.query("insert into public.clients(agency_id,business_name,industry,location,status) values($1,'Fictional X variant test','Other','Nairobi','active') returning id",[agency]);
  const {rows:[post]}=await db.query("insert into public.content_calendar(client_id,title,caption,content_origin,platform,format) values($1,'X test','Long source message','ai','Other','Image Post') returning id,revision",[client.id]);
  await db.query("insert into public.content_x_captions(content_id,revision,caption) values($1,$2,'Short review copy')",[post.id,post.revision]);
  await assert.rejects(db.query("update public.content_x_captions set status='approved' where content_id=$1",[post.id]),/Approve the main post/);
  await db.query("update public.content_calendar set status='approved' where id=$1",[post.id]);
  await db.query("update public.content_x_captions set caption='Edited copy',status='approved' where content_id=$1",[post.id]);
  assert.equal((await db.query('select status from public.content_x_captions where content_id=$1',[post.id])).rows[0].status,'draft');
  await db.query("update public.content_x_captions set status='approved' where content_id=$1",[post.id]);
  assert.equal((await db.query('select approved_by from public.content_x_captions where content_id=$1',[post.id])).rows[0].approved_by,admin);
  await assert.rejects(db.query("update public.content_x_captions set caption='Unreviewed change' where content_id=$1",[post.id]),/approved X version is locked/);
  await db.query("update public.content_calendar set caption='Changed source' where id=$1",[post.id]);
  assert.equal((await db.query('select revision from public.content_calendar where id=$1',[post.id])).rows[0].revision,2);
  assert.equal((await db.query("update public.content_x_captions set status='draft' where content_id=$1 returning content_id",[post.id])).rows.length,0);
  return post.id;
 });
 for(const actor of [userA,otherAdmin])await as(actor,async()=>{
  assert.equal((await db.query('select * from public.content_x_captions where content_id=$1',[content])).rows.length,0);
  await assert.rejects(db.query("insert into public.content_x_captions(content_id,revision,caption) values($1,2,'Forbidden')",[content]),/row-level security/);
 });
 await as(null,()=>assert.rejects(db.query('select * from public.content_x_captions'),/permission denied/),'anon');
});
