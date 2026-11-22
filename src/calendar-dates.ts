const calendarDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'});
const calendarTime = new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function nairobiDay(date:Date|string=new Date()) {
  const parts = Object.fromEntries(calendarDate.formatToParts(new Date(date)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const nairobiTime = (date:Date|string) => calendarTime.format(new Date(date));
export const toCalendarDate = (day:string) => new Date(`${day}T12:00:00Z`);
export const asDay = (date:Date) => date.toISOString().slice(0,10);

export function shiftDay(day:string,amount:number) {
  const date=toCalendarDate(day);
  date.setUTCDate(date.getUTCDate()+amount);
  return asDay(date);
}
export function monday(day:string) {return shiftDay(day,-((toCalendarDate(day).getUTCDay()+6)%7));}
export function monthStart(day:string) {return `${day.slice(0,7)}-01`;}
export function shiftMonth(day:string,amount:number) {
  const date=toCalendarDate(monthStart(day));
  date.setUTCMonth(date.getUTCMonth()+amount);
  return asDay(date);
}
export const nairobiInstant = (day:string,time:string) => new Date(`${day}T${time}:00+03:00`).toISOString();
