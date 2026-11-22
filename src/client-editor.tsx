import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { PortalAccess } from './portal-access';
import { Button } from './components/ui/button';
import { statuses, supabase, type Brand, type ClientRecord, type Service } from './data';

type Field = { key: string; label: string; type?: string; required?: boolean; options?: string[] };
const industries = ['Digital Marketing and Technology Services', 'Salon and Beauty', 'Retail Shop', 'Restaurant', 'School', 'Real Estate', 'Church', 'Healthcare', 'Professional Services', 'Hospitality', 'Other'];
const locations = ['Kiserian', 'Ngong', 'Rongai', 'Karen', 'Nairobi', 'Kitengela', 'Kajiado'];
const groups: { title: string; fields: Field[] }[] = [
  { title: 'Business details', fields: [
    {key:'business_name',label:'Business name',required:true}, {key:'industry',label:'Industry',required:true,options:industries},
    {key:'location',label:'Location',required:true,options:locations}, {key:'address',label:'Physical address'},
    {key:'website',label:'Website',type:'url'}, {key:'status',label:'Status',type:'status',required:true},
    {key:'description',label:'Business description',type:'textarea'},
  ]},
  { title: 'Contact information', fields: [
    {key:'contact_person',label:'Contact person'}, {key:'contact_email',label:'Email',type:'email'},
    {key:'contact_phone',label:'Phone',type:'tel'}, {key:'whatsapp_number',label:'WhatsApp',type:'tel'},
  ]},
  { title: 'Agency details', fields: [
    {key:'package_name',label:'Package',options:['TSOLS Starter','TSOLS Growth','TSOLS Pro','Internal / Agency Account']},
    {key:'onboarding_date',label:'Onboarding date',type:'date'}, {key:'monthly_service_fee_kes',label:'Monthly service fee (KES)',type:'number'},
    {key:'monthly_ad_budget_kes',label:'Monthly ad budget (KES)',type:'number'}, {key:'internal_notes',label:'Internal notes',type:'textarea'},
  ]},
  { title: 'Account references', fields: [
    {key:'drive_folder_reference',label:'Google Drive folder'}, {key:'social_account_references',label:'Social account references'},
  ]},
];
const brandFields: Field[] = [
  {key:'brand_name',label:'Brand name'}, {key:'language',label:'Language',options:['Professional English','Kenyan English','English and Swahili','Sheng and English']},
  {key:'brand_colors',label:'Brand colours'}, {key:'logo_url',label:'Logo URL',type:'url'},
  {key:'tone',label:'Tone of voice',type:'textarea'}, {key:'target_audience',label:'Target audience',type:'textarea'},
];
const tabs = ['Overview','Brand Profile','Content','Calendar','Leads','Advertising','Reports','Integrations','Settings'];

function FormField({ field, data }: { field: Field; data: Record<string, string | number | null> }) {
  const { key, label, type, required, options } = field;
  const value = data[key] ?? (key === 'status' ? 'onboarding' : '');
  return <label className={type === 'textarea' ? 'form-wide' : undefined}>{label}{required && <span aria-hidden="true"> *</span>}
    {type === 'status' ? <select name={key} defaultValue={value} required>{statuses.map(status =>
       <option key={status} value={status} disabled={status === 'archived' && value !== 'archived'}>{status[0].toUpperCase() + status.slice(1)}</option>)}</select>
      : type === 'textarea' ? <textarea name={key} defaultValue={value} rows={3} maxLength={4000}/>
      : <input name={key} type={type ?? 'text'} defaultValue={value} list={options && `${key}-options`} required={required}
          min={type === 'number' ? 0 : undefined} step={type === 'number' ? '0.01' : undefined}
          max={type === 'number' ? '9999999999.99' : undefined} maxLength={key === 'business_name' ? 160 : key === 'industry' ? 120 : key === 'location' ? 180 : 600}/>}
    {options && <datalist id={`${key}-options`}>{options.map(option => <option key={option} value={option}/>)}</datalist>}
  </label>;
}

export function ClientEditor({ agencyId, clientId, goBack, saved }: {
  agencyId: string; clientId?: string; goBack: () => void; saved: () => void;
}) {
  const [record, setRecord] = useState<ClientRecord>();
  const [brand, setBrand] = useState<Brand>({});
  const [services, setServices] = useState<(Service & { formKey: string })[]>([]);
  const [tab, setTab] = useState('Overview');
  const [loading, setLoading] = useState(Boolean(clientId));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const archiveDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!supabase || !clientId) return;
    let active = true;
    const db = supabase;
    void Promise.all([
      db.from('clients').select('*').eq('agency_id', agencyId).eq('id', clientId).single(),
      db.from('client_brand_profiles').select('brand_name, language, tone, target_audience, brand_colors, logo_url').eq('client_id', clientId).maybeSingle(),
      db.from('client_services').select('id, name, price_kes').eq('client_id', clientId).order('created_at'),
    ]).then(([client, profile, list]) => {
      if (!active) return;
      setLoading(false);
      if (client.error || profile.error || list.error) { setError('This client could not be loaded.'); return; }
      setRecord(client.data as ClientRecord);
      setBrand(profile.data ?? {});
      setServices(list.data.map(service => ({ ...service, formKey: service.id })));
    });
    return () => { active = false; };
  }, [agencyId, clientId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || pending) return;
    const form = new FormData(event.currentTarget);
    const read = (fields: Field[]) => Object.fromEntries(fields.map(({key}) => [key, String(form.get(key) ?? '').trim() || null]));
    const details = read(groups.flatMap(group => group.fields));
    if (!details.business_name || !details.industry || !details.location) {
      setError('Enter a business name, industry and location.');
      setTab('Overview');
      return;
    }
    setPending(true);
    setError('');
    const result = await supabase.rpc('save_client', {
      target_agency: agencyId, target_client: clientId ?? null, expected_updated_at: record?.updated_at ?? null,
      details, brand: read(brandFields),
      services: services.map(({formKey, id}) => ({
        id: id ?? null, name: String(form.get(`service-${formKey}`) ?? '').trim(),
        price_kes: form.get(`price-${formKey}`) || null,
      })),
    });
    setPending(false);
    if (result.error) {
      setError(result.error.code === 'P0001' ? result.error.message : 'Could not save the client. Check the fields and try again.');
      return;
    }
    saved();
  }

  async function archive() {
    if (!supabase || !record || pending) return;
    setPending(true);
    setError('');
    const result = await supabase.from('clients').update({status:'archived'}).eq('agency_id',agencyId)
      .eq('id',record.id).eq('updated_at',record.updated_at).select('id').maybeSingle();
    setPending(false);
    archiveDialog.current?.close();
    if (result.error || !result.data) { setError('Client could not be archived. Reopen the record before retrying.'); return; }
    saved();
  }

  return <>
    <button className="text-link back-link" onClick={goBack}><ArrowLeft size={16}/> All clients</button>
    <header className="page-heading"><div><h1>{record?.business_name ?? (clientId ? 'Client profile' : 'Add client')}</h1>
      <p>{record ? `${record.industry} · ${record.location}` : 'Manage business details, contacts and brand information.'}</p></div>
      {record && record.status !== 'archived' && <Button variant="outline" onClick={() => archiveDialog.current?.showModal()}><Archive size={17}/> Archive client</Button>}
    </header>
    {error && <div className="error notice" role="alert">{error}</div>}
    {loading ? <p role="status">Loading client…</p> : (!clientId || record) && <>
      <nav className="tabs" aria-label="Client profile">{tabs.filter(item => clientId || item === 'Overview' || item === 'Brand Profile').map(item =>
        <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</nav>
      <form onSubmit={save} onInvalidCapture={event => {
        const invalid = event.target as HTMLInputElement;
        const section = invalid.closest<HTMLElement>('section[hidden]');
        if (!section) return;
        event.preventDefault();
        setTab(section.dataset.tab ?? 'Overview');
        setError('Review the required fields and check the values before saving.');
        requestAnimationFrame(() => invalid.focus());
      }}>
        <fieldset disabled={pending}>
          {groups.map((group,index) => <section key={group.title} className="panel form-section" data-tab={index < 3 ? 'Overview' : 'Integrations'} hidden={index < 3 ? tab !== 'Overview' : tab !== 'Integrations'}>
            <h2>{group.title}</h2>
            <div className="form-grid">{group.fields.map(field => <FormField key={field.key} field={field} data={record ?? {}}/>)}</div>
          </section>)}
          <section className="panel form-section" data-tab="Brand Profile" hidden={tab !== 'Brand Profile'}>
            <h2>Brand guidelines</h2><div className="form-grid">{brandFields.map(field => <FormField key={field.key} field={field} data={brand}/>)}</div>
            <div className="service-heading"><h2>Services and prices</h2><Button variant="outline" type="button" disabled={services.length >= 100} onClick={() =>
              setServices(previous => [...previous, { formKey:crypto.randomUUID(), name:'', price_kes:null }])}><Plus size={16}/> Add service</Button></div>
            {services.map(service => <div className="service-row" key={service.formKey}>
              <label>Service name<input name={`service-${service.formKey}`} defaultValue={service.name} maxLength={160} required/></label>
              <label>Price (KES)<input name={`price-${service.formKey}`} defaultValue={service.price_kes ?? ''} type="number" min="0" max="9999999999.99" step="0.01"/></label>
              <Button variant="ghost" type="button" aria-label="Remove service" onClick={() => setServices(previous => previous.filter(item => item.formKey !== service.formKey))}><Trash2 size={17}/></Button>
            </div>)}
          </section>
          {tab === 'Content' && record && <section className="panel form-section"><h2>Client content</h2>
            <Button variant="outline" asChild><a href={`#/studio/${record.id}`}>Open in Content Studio</a></Button>
          </section>}
          {tab === 'Calendar' && record && <section className="panel form-section"><h2>Client calendar</h2>
            <Button variant="outline" asChild><a href={`#/calendar/${record.id}`}>Open client calendar</a></Button>
          </section>}
          {tab === 'Leads' && record && <section className="panel form-section"><h2>Client leads</h2>
            <Button variant="outline" asChild><a href={`#/leads/${record.id}`}>Open lead inbox</a></Button>
          </section>}
          {tab === 'Advertising' && record && <section className="panel form-section"><h2>Client advertising</h2>
            <Button variant="outline" asChild><a href={`#/ads/${record.id}`}>Open Ads Manager</a></Button>
          </section>}
          {tab === 'Reports' && record && <section className="panel form-section"><h2>Client reports</h2>
            <Button variant="outline" asChild><a href={`#/reports/${record.id}`}>Open reports</a></Button>
          </section>}
          {tab !== 'Settings' && tab !== 'Content' && tab !== 'Calendar' && tab !== 'Leads' && tab !== 'Advertising' && tab !== 'Reports' && <div className="form-actions"><Button variant="outline" type="button" onClick={goBack}>Cancel</Button><Button type="submit">{pending ? 'Saving…' : 'Save client'}</Button></div>}
        </fieldset>
      </form>
      {tab === 'Settings' && record && <PortalAccess clientId={record.id} archived={record.status==='archived'}/>}
    </>}
    <dialog ref={archiveDialog} className="panel confirmation">
      <h2>Archive {record?.business_name}?</h2><p>The client will move to the Archived list. Its history will be retained.</p>
      <div className="form-actions"><Button variant="outline" onClick={() => archiveDialog.current?.close()}>Cancel</Button><Button disabled={pending} onClick={archive}>Archive client</Button></div>
    </dialog>
  </>;
}
