import './analytics-oauth-response';
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const supabase = url && key ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null;

export const statuses = ['onboarding', 'active', 'paused', 'archived'] as const;
export type Status = typeof statuses[number];
export type ClientRecord = {
  id: string; business_name: string; industry: string; location: string; status: Status; updated_at: string;
  package_name: string | null;
} & Record<string, string | number | null>;
export type Brand = Record<string, string | null>;
export type Service = { id?: string; name: string; price_kes: number | null };
export type Activity = { id: string; client_id: string; action: string; created_at: string };
export type Agency = { id: string; name: string };
export type Assigned = Pick<ClientRecord, 'id' | 'business_name' | 'industry' | 'location'>;

export const displayDate = (value: string) => new Intl.DateTimeFormat('en-KE', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi',
}).format(new Date(value));
