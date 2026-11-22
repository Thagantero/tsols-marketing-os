begin;

alter table public.clients add column drive_folder_reference text;
alter table public.clients add column social_account_references text;
grant insert (drive_folder_reference,social_account_references),
  update (drive_folder_reference,social_account_references) on public.clients to authenticated;

create function public.save_client(
  target_agency uuid, target_client uuid, expected_updated_at timestamptz,
  details jsonb, brand jsonb, services jsonb
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  d public.clients;
  b public.client_brand_profiles;
  saved_id uuid;
begin
  select * into d from jsonb_populate_record(null::public.clients, details);
  select * into b from jsonb_populate_record(null::public.client_brand_profiles, brand);
  if target_client is null then
    insert into public.clients (agency_id,business_name,industry,location,description,address,contact_person,contact_phone,
      whatsapp_number,contact_email,website,package_name,monthly_service_fee_kes,monthly_ad_budget_kes,onboarding_date,
      internal_notes,status,drive_folder_reference,social_account_references)
    values (target_agency,d.business_name,d.industry,d.location,d.description,d.address,d.contact_person,d.contact_phone,
      d.whatsapp_number,d.contact_email,d.website,d.package_name,d.monthly_service_fee_kes,d.monthly_ad_budget_kes,d.onboarding_date,
      d.internal_notes,d.status,d.drive_folder_reference,d.social_account_references)
    returning id into saved_id;
  else
    update public.clients
      set (business_name,industry,location,description,address,contact_person,contact_phone,whatsapp_number,contact_email,
        website,package_name,monthly_service_fee_kes,monthly_ad_budget_kes,onboarding_date,internal_notes,status,
        drive_folder_reference,social_account_references)
      = (d.business_name,d.industry,d.location,d.description,d.address,d.contact_person,d.contact_phone,d.whatsapp_number,d.contact_email,
        d.website,d.package_name,d.monthly_service_fee_kes,d.monthly_ad_budget_kes,d.onboarding_date,d.internal_notes,d.status,
        d.drive_folder_reference,d.social_account_references)
      where id = target_client and agency_id = target_agency and updated_at = expected_updated_at
      returning id into saved_id;
    if saved_id is null then
      raise exception 'Client changed or is no longer accessible. Reload before editing.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.client_brand_profiles (client_id,brand_name,language,tone,target_audience,brand_colors,logo_url)
    values (saved_id,b.brand_name,b.language,b.tone,b.target_audience,b.brand_colors,b.logo_url)
    on conflict (client_id) do update
      set (brand_name,language,tone,target_audience,brand_colors,logo_url)
      = (excluded.brand_name,excluded.language,excluded.tone,excluded.target_audience,excluded.brand_colors,excluded.logo_url)
      where (client_brand_profiles.brand_name,client_brand_profiles.language,client_brand_profiles.tone,
        client_brand_profiles.target_audience,client_brand_profiles.brand_colors,client_brand_profiles.logo_url)
      is distinct from (excluded.brand_name,excluded.language,excluded.tone,excluded.target_audience,excluded.brand_colors,excluded.logo_url);

  if services is not null then
    if jsonb_typeof(services) is distinct from 'array' or jsonb_array_length(services) > 100 then
      raise exception 'Provide up to 100 services.';
    end if;
    delete from public.client_services s where s.client_id = saved_id and not exists
      (select 1 from jsonb_to_recordset(services) x(id uuid) where x.id = s.id);
    update public.client_services s set name = x.name, price_kes = x.price_kes
      from jsonb_to_recordset(services) x(id uuid, name text, price_kes numeric)
      where s.client_id = saved_id and s.id = x.id
        and (s.name,s.price_kes) is distinct from (x.name,x.price_kes);
    insert into public.client_services (client_id,name,price_kes)
      select saved_id,x.name,x.price_kes from jsonb_to_recordset(services) x(id uuid, name text, price_kes numeric)
      where x.id is null;
  end if;
  return saved_id;
end;
$$;

revoke all on function public.save_client(uuid,uuid,timestamptz,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.save_client(uuid,uuid,timestamptz,jsonb,jsonb,jsonb) to authenticated;

commit;
