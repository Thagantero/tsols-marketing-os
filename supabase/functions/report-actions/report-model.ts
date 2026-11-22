export type Metrics={
  posts_published:number|null;confirmed_deliveries:number|null;failed_deliveries:number|null;unresolved_deliveries:number;
  undated_deliveries:number;success_rate:number|null;new_leads:number;qualified_leads:number;ad_snapshots:number;
  missing_fx_rows:number;ad_spend_kes:number|null;ad_impressions:number|null;ad_clicks:number|null;ad_leads:number|null;
  cost_per_ad_lead:number|null;ad_native_spend:{currency:string;amount:number}[];
  top_campaigns:{name:string;account_label:string;platform:string;currency:string;native_spend:number;clicks:number;impressions:number;external_campaign_id:string}[];
  organic_reach:null;organic_impressions:null;organic_engagement:null;audience_growth:null;best_post:null;
};

export type Report={
  id:string;client_id:string;client_name:string;recipient_email:string|null;cadence:'weekly'|'monthly';
  period_start:string;period_end:string;partial_period:boolean;version:number;
  metrics:Metrics;observations:string;action_plan:string;status:'draft'|'approved'|'archived';
  created_at:string;updated_at:string;approved_at:string|null;
};
export const formatCount=(value:number|null)=>value===null?'Unavailable':new Intl.NumberFormat('en-KE',{maximumFractionDigits:2}).format(value);
export const formatMoney=(value:number|null,currency='KES')=>value===null?'Unavailable':new Intl.NumberFormat('en-KE',{
  style:'currency',currency,currencyDisplay:'code',maximumFractionDigits:2,
}).format(value);
export const labelCadence=(cadence:Report['cadence'])=>cadence==='weekly'?'Weekly':'Monthly';
export const periodLabel=(report:Pick<Report,'period_start'|'period_end'>)=>report.period_start+' to '+report.period_end;
export const reportMetrics=(m:Metrics)=>[
  ['Confirmed published posts',formatCount(m.posts_published)],
  ['Confirmed channel deliveries',formatCount(m.confirmed_deliveries)],
  ['Failed deliveries',formatCount(m.failed_deliveries)],
  ['Resolved delivery success rate',m.success_rate===null?'Unavailable':formatCount(m.success_rate)+'%'],
  ['New CRM leads',formatCount(m.new_leads)],
  ['Leads moved to Qualified',formatCount(m.qualified_leads)],
  ['Imported ad spend (KES)',formatMoney(m.ad_spend_kes)],
  ['Paid impressions',formatCount(m.ad_impressions)],
  ['Ad clicks',formatCount(m.ad_clicks)],
  ['Reported ad leads',formatCount(m.ad_leads)],
  ['Cost per reported ad lead',formatMoney(m.cost_per_ad_lead)],
];
export const unavailableOrganic='Organic reach, impressions, engagement, audience growth and best-performing post are unavailable without connected organic analytics.';
export function coverage(report:Report){
  const metrics=report.metrics;
  const notes=[
    'Publishing counts use Buffer-confirmed send times. The success rate uses resolved deliveries. CRM qualifications count recorded transitions.',
    'Advertising rows use each ad account’s reporting dates. Campaigns are ranked by recorded clicks.',
  ];
  if(report.partial_period)notes.unshift('This report includes the current, incomplete reporting period.');
  if(metrics.unresolved_deliveries||metrics.undated_deliveries)notes.push(
    formatCount(metrics.unresolved_deliveries)+' unresolved deliveries and '+formatCount(metrics.undated_deliveries)+' deliveries without verified send times were excluded from published totals.',
  );
  if(metrics.missing_fx_rows)notes.push('A KES spend total requires conversion rates on every imported row.');
  if(!metrics.ad_snapshots)notes.push('No advertising data was imported for this period.');
  return [...notes,unavailableOrganic];
}
