// push: phone notifications for the owners (Ofek, 6 Oct 2026).
//
// The OPS app can be added to a phone's home screen; there each owner turns notifications on once per device and the
// app saves that device in public.push_subscriptions (each person can only see and remove his own devices). This
// function sends to them. POST with the signed-in person's token, { step, ... }:
//   key      → the public key a device subscribes with. The key pair is made here on first use and kept in
//              public.app_keys, which has no access rules, so only this function (service role) can read it — no key
//              is ever typed in by a person.
//   invoice  → { week, person, end? }: a technician's commission invoice for that pay week is in → every owner's devices
//              get "you can pay <person>". Only that technician or an owner/manager may ask, and only when the invoice is
//              really on the week's row. end = the week's last day (a short or long week after a week-start change).
//   test     → the caller's own devices get a test notification (owners and managers). { kind } (optional, 14 Oct): one
//              notification's real wording on sample data, titled "Test · …" (Settings → Notifications, "Send a test" on
//              a card); without it the original "Notifications are on" test. A test is never recorded in push_sent.
//   selftest → builds one encrypted, signed message for a made-up device without sending it, to prove the sending
//              code works here (owners and managers).
//   scan     → (every 10 minutes, from pg_cron; added 12 Oct) the news switched on in Settings → Notifications
//              (settings.catalog.notify), each sent once: a new lead, a new lead still untouched after 15 minutes, a missed
//              call, a job that has just turned 7 days unpaid, an employee document expiring within 30 days, and the
//              business's own workers compensation / public liability insurance (catalog.business.insurance, owners only,
//              added 14 Oct): always 30 days before, with its own switch (catalog.notify.bizInsurance); until that is
//              set it follows the employee-document switch. To the owners, and to the office (VA and managers) when
//              chosen, for a new lead, a waiting lead and a missed call only (money and private details: owners only).
//              Anyone may call it: it only ever sends what push_sent hasn't recorded yet, and does nothing while
//              everything is switched off.
// A device that the phone's push service says is gone (404 / 410) is removed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CONTACT = "mailto:info@theguyservicegroup.com";
const APP_URL = "https://theguysgroup.github.io/the-guys-ops-app/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// The outside world, swappable in tests.
export const io = {
  // deno-lint-ignore no-explicit-any
  send: (sub: any, payload: string, opts: any) => webpush.sendNotification(sub, payload, opts),
  // deno-lint-ignore no-explicit-any
  build: (sub: any, payload: string, opts: any) => webpush.generateRequestDetails(sub, payload, opts),
  generate: () => webpush.generateVAPIDKeys() as { publicKey: string; privateKey: string },
};

// deno-lint-ignore no-explicit-any
export async function vapidKeys(sb: any): Promise<{ publicKey: string; privateKey: string }> {
  const { data } = await sb.from("app_keys").select("value").eq("name", "vapid").limit(1);
  if (data && data[0]) return data[0].value;
  const k = io.generate();
  const { error } = await sb.from("app_keys").insert({ name: "vapid", value: { publicKey: k.publicKey, privateKey: k.privateKey } });
  if (error) {   // made by another call at the same moment: use that one
    const { data: again } = await sb.from("app_keys").select("value").eq("name", "vapid").limit(1);
    if (again && again[0]) return again[0].value;
    throw error;
  }
  return k;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// end = the week's last day when the week is not 7 days (the first week after a week-start change: 4 to 10 days). An end
// that is not a date, not after the start or more than 13 days on is ignored (a normal 7-day week).
export function weekText(week: string, end?: unknown): string {
  const [y, m, d] = week.split("-").map(Number);
  const e = typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end) && end > week && end <= shiftDay(week, 13) ? end.split("-").map(Number) : null;
  const a = new Date(Date.UTC(y, m - 1, d)), b = e ? new Date(Date.UTC(e[0], e[1] - 1, e[2])) : new Date(Date.UTC(y, m - 1, d + 6));
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`
    : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}

// Sends one message to every saved device of these people. Returns how many went, failed and were removed.
// deno-lint-ignore no-explicit-any
export async function sendTo(sb: any, userIds: string[], payload: Record<string, unknown>, keys: { publicKey: string; privateKey: string }) {
  const out = { devices: 0, sent: 0, failed: 0, removed: 0 };
  if (!userIds.length) return out;
  const { data: subs } = await sb.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", userIds);
  out.devices = (subs || []).length;
  for (const s of subs || []) {
    try {
      await io.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: CONTACT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 86400, urgency: "high",
      });
      out.sent++;
    } catch (e) {
      out.failed++;
      // deno-lint-ignore no-explicit-any
      const code = Number((e as any)?.statusCode);
      if (code === 404 || code === 410) { await sb.from("push_subscriptions").delete().eq("id", s.id); out.removed++; }
    }
  }
  return out;
}

const isOffice = (me: { role?: string } | null) => !!me && (me.role === "owner" || me.role === "manager");

// ── region (Settings → Business details → Region and format; the same rules as the app's bizTz/moneyText/holidayDaysOf). Copied into every function — keep the copies identical (tests/business-logic.test.js checks). ──
// Nothing saved = this business's values until 14 Oct: Sydney time, "$" amounts, GST, New South Wales (T1.2/T1.3).
export const REGION_DEFAULTS = { timeZone: "Australia/Sydney", currency: "AUD", country: "AU", state: "NSW" };
export const TAX_NAMES: Record<string, string> = { AU: "GST", NZ: "GST", CA: "GST", SG: "GST", IN: "GST", GB: "VAT", IE: "VAT", ZA: "VAT", AE: "VAT", US: "Sales tax" };
export const MONEY_FORMATS = [["1,234.56", ",", "."], ["1.234,56", ".", ","], ["1 234,56", " ", ","]];
const REGION_TZ_OK = new Map<string, boolean>();
const REGION_FMT = new Map<string, Intl.DateTimeFormat>();
export function tzValid(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz.trim()) return false;
  if (!REGION_TZ_OK.has(tz)) { let ok = true; try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); } catch { ok = false; } REGION_TZ_OK.set(tz, ok); }
  return REGION_TZ_OK.get(tz) === true;
}
// deno-lint-ignore no-explicit-any
export function regionOf(cat: any): Record<string, any> { const r = cat && typeof cat === "object" ? cat.region : null; return r && typeof r === "object" ? r : {}; }
// The business's time zone (settings.catalog.region.timeZone; a name the runtime doesn't know counts as not set).
// deno-lint-ignore no-explicit-any
export function bizTzOf(cat: any): string { const r = regionOf(cat); return tzValid(r.timeZone) ? r.timeZone : REGION_DEFAULTS.timeZone; }
// deno-lint-ignore no-explicit-any
export function bizTzSet(cat: any): boolean { return tzValid(regionOf(cat).timeZone); }
// 'AU-NSW', 'US-TX', 'SG': the place the stored public holidays were worked out for (nothing chosen = AU-NSW).
// deno-lint-ignore no-explicit-any
export function regionKeyOf(r: any): string {
  const x = r && typeof r === "object" ? r : {};
  const country = /^[A-Z]{2}$/.test(String(x.country || "")) ? x.country : REGION_DEFAULTS.country;
  const state = x.country ? String(x.state || "") : REGION_DEFAULTS.state;
  return state ? `${country}-${state}` : country;
}
// The wall clock in tz at an instant: { day 'YYYY-MM-DD', dow 0 = Sunday, hour, minute, minutes after midnight }.
export function bizParts(ms: number, tz: string) {
  let f = REGION_FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }); REGION_FMT.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24, minute = Number(p.minute);
  return { day: `${p.year}-${p.month}-${p.day}`, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)), hour, minute, minutes: hour * 60 + minute };
}
// The UTC instant of a wall-clock time in tz (two passes handle daylight saving).
export function bizToUtc(day: string, hh: number, mm: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mm);
  const want = Date.UTC(y, m - 1, d, hh, mm);
  const wall = (ms: number) => { const p = bizParts(ms, tz), [py, pm, pd] = p.day.split("-").map(Number); return Date.UTC(py, pm - 1, pd, p.hour, p.minute); };
  for (let i = 0; i < 2; i++) t -= wall(t) - want;
  // a wall time the clocks jump over (a daylight-saving gap, at midnight in some zones): the same time after the jump on
  // the same day, never the evening before
  const got = wall(t);
  if (got < want) t += want - got;
  return t;
}
// A business day for a timestamptz column that used to get the bare date ('2026-10-14' = midnight UTC): the same bare
// date where midnight UTC is still that day in the zone (Sydney: exactly as before), else noon that day in the zone, so
// zones west of UTC don't file the record under the day before.
export function bizDayStamp(day: string, tz: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return bizParts(Date.UTC(y, m - 1, d), tz).day === day ? day : new Date(bizToUtc(day, 12, 0, tz)).toISOString();
}
// A word the owner typed, kept free of HTML and quote characters.
export function regionWord(v: unknown, max: number): string { return String(v || "").replace(/[<>&"'`\\]/g, "").trim().slice(0, max); }
// What the sales tax is called (GST / VAT / Sales tax / the business's own word).
// deno-lint-ignore no-explicit-any
export function taxNameOf(cat: any): string {
  const r = regionOf(cat), country = /^[A-Z]{2}$/.test(String(r.country || "")) ? r.country : REGION_DEFAULTS.country;
  return regionWord(r.taxName, 20) || TAX_NAMES[country] || "Tax";
}
export function currencySymbolOf(code: string): string {
  try { const p = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((x) => x.type === "currency"); return p ? p.value : code; }
  catch { return code; }
}
// The currency's cents: 2 for AUD/USD, 0 for JPY/KRW, 3 for KWD/BHD (2 when the runtime doesn't know the code).
export function currencyDecimalsOf(code: string): number {
  try { const n = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits; return Number.isInteger(n) ? n : 2; }
  catch { return 2; }
}
// An amount as the business writes it. digits: "auto" = no cents on whole amounts, 2 = always cents, "plain" = as the
// number comes ("$1,234.5"), "raw" = no thousands separator ("$1234"). Nothing saved = exactly what the functions wrote
// before 14 Oct.
// deno-lint-ignore no-explicit-any
export function moneyText(n: number, cat: any, digits: "auto" | 2 | "plain" | "raw" = "plain"): string {
  const r = regionOf(cat), x = Number(n);
  const code = /^[A-Z]{3}$/.test(String(r.currency || "")) ? r.currency : REGION_DEFAULTS.currency;
  const sym = regionWord(r.currencySymbol, 4) || currencySymbolOf(code), dec = currencyDecimalsOf(code);
  const fmt = MONEY_FORMATS.find((f) => f[0] === r.moneyFormat) || MONEY_FORMATS[0];
  // "cents" = the currency's own: none for JPY, three for KWD
  const opts = digits === "auto" ? { minimumFractionDigits: Math.abs(x - Math.round(x)) < 1e-9 ? 0 : dec, maximumFractionDigits: dec }
    : digits === 2 ? { minimumFractionDigits: dec, maximumFractionDigits: dec } : undefined;
  let s = digits === "raw" ? String(x) : x.toLocaleString("en-US", opts);
  if (fmt !== MONEY_FORMATS[0]) s = s.replace(/[,.]/g, (ch) => ch === "," ? fmt[1] : fmt[2]);
  return r.symbolAfter === true ? `${s} ${sym}` : sym + s;
}
// One key per public holiday, its moved ("additional"/"substitute") day included.
export function holidayKey(name: unknown): string { return String(name || "").replace(/\s*\((?:additional|substitute) day\)\s*$/i, "").trim().toLowerCase(); }
// The public holidays that are days off: none while the switch is off (hours.publicOn, or the old hours.nsw), none when the
// stored list (catalog.holidays, worked out by the app) is for another region, minus the ones switched off (hours.holidayOff).
// deno-lint-ignore no-explicit-any
export function holidayDaysOf(cat: any): Record<string, string> {
  const c = cat && typeof cat === "object" ? cat : {}, h = c.hours && typeof c.hours === "object" ? c.hours : {};
  if (!(h.publicOn ?? h.nsw)) return {};
  const ph = c.holidays;
  if (!ph || !ph.days || typeof ph.days !== "object" || ph.region !== regionKeyOf(c.region || {})) return {};
  const off = new Set(Array.isArray(h.holidayOff) ? h.holidayOff : []), out: Record<string, string> = {};
  for (const [d, name] of Object.entries(ph.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !off.has(holidayKey(name))) out[d] = String(name);
  return out;
}
// ── end region ──

// ── scan: news for the phones (Settings → Notifications) ──
export const NOTIFY_KINDS = ["newLead", "leadWaiting", "missedCall", "unpaid", "docExpiry", "bizInsurance"];
// Only these may also go to the office (VA and managers); the rest are money and private details, for the owners only.
export const OFFICE_KINDS = ["newLead", "leadWaiting", "missedCall"];
export const BIZ_INSURANCE_DAYS = 30;   // the business insurance is always flagged 30 days before (Ofek 14 Oct)
const DOC_LABEL: Record<string, string> = { license: "driver licence", passport: "passport", visa: "visa", heights: "working-at-heights ticket", arc: "refrigerant licence", insurance: "public liability insurance" };
const BIZ_INSURANCE_LABEL: Record<string, string> = { workers: "workers compensation", liability: "public liability" };
export function shiftDay(day: string, n: number) { const [y, m, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const TEST_TAG = (tags: unknown) => Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === "test");
// deno-lint-ignore no-explicit-any
const arrivedAt = (c: any) => c.reopened_at || (Array.isArray(c.messages) && c.messages[0] && c.messages[0].at) || null;
// The numbers behind the notifications, set in Settings → Notifications (catalog.notify.rules, Ofek 13 Oct); "unpaid"
// follows the business's own "Flag a job as unpaid after" (settings.unpaid_reminder_days). Nothing set = the originals.
// deno-lint-ignore no-explicit-any
export function notifyRules(N: any, unpaidDays: unknown) {
  const r = (N && N.rules && typeof N.rules === "object") ? N.rules : {};
  const int = (v: unknown, lo: number, hi: number, def: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : def; };
  let from = int(r.from, 0, 23, 8), until = int(r.until, 1, 24, 20);
  if (until <= from) { from = 8; until = 20; }
  return { waitMinutes: int(r.waitMinutes, 5, 240, 15), from, until, docDays: int(r.docDays, 1, 180, 30), unpaidDays: int(unpaidDays, 1, 365, 7) };
}
// Is a notification switched on? The same rule as the app's notifyOn: the invoice one is on unless turned off; the business
// insurance follows the document switch until it has its own (a true / false saved on it).
// deno-lint-ignore no-explicit-any
export function notifyOn(N: any, k: string): boolean {
  const x = N && N[k];
  if (k === "invoice") return !(x && x.on === false);
  if (k === "bizInsurance" && !(x && typeof x.on === "boolean")) return notifyOn(N, "docExpiry");
  return !!(x && x.on);
}

// What each notification says (title, body, where it opens, tag). scan, the invoice step and the test step share them.
// deno-lint-ignore no-explicit-any
export function leadPayload(c: any) {
  const what = [c.division, c.source].filter(Boolean).join(" · ");
  return { title: `New lead: ${c.full_name || "no name"}`, body: what || "A new enquiry came in.", url: `${APP_URL}?tab=crm`, tag: `lead-${c.id}` };
}
// deno-lint-ignore no-explicit-any
export function waitingPayload(c: any, R: { waitMinutes: number }) {
  return { title: `Waiting ${R.waitMinutes}+ minutes: ${c.full_name || "a new lead"}`, body: `Nobody has picked up this ${c.division || ""} lead yet.`.replace("  ", " "), url: `${APP_URL}?tab=crm`, tag: `waiting-${c.id}` };
}
// deno-lint-ignore no-explicit-any
export function callPayload(c: any) {
  return { title: "Missed call", body: `${c.from_number || "A caller"}${c.division ? " · " + c.division : ""}. Call them back.`, url: `${APP_URL}?tab=myDay`, tag: `call-${c.id}` };
}
// deno-lint-ignore no-explicit-any
// The amount as the business writes it (cat = settings.catalog: its currency; nothing saved = "$480").
// deno-lint-ignore no-explicit-any
export function unpaidPayload(j: any, R: { unpaidDays: number }, cat?: any) {
  return { title: `${R.unpaidDays === 7 ? "Unpaid for a week" : `Unpaid for ${R.unpaidDays} days`}: ${j.customer_name || "a job"}`, body: `${moneyText(Number(j.amount || 0), cat, "plain")} from ${j.date}. Time to chase it.`, url: `${APP_URL}?tab=outstanding`, tag: `unpaid-${j.id}` };
}
// deno-lint-ignore no-explicit-any
export function docPayload(e: any, kind: string, exp: string) {
  return { title: `${e.name}'s ${DOC_LABEL[kind] || kind} expires soon`, body: `On ${exp}. Ask for the new one.`, url: `${APP_URL}?tab=reference`, tag: `doc-${e.id}-${kind}` };
}
export function bizInsurancePayload(kind: string, exp: string) {
  return { title: `Business insurance: ${BIZ_INSURANCE_LABEL[kind]} expires soon`, body: `On ${exp}. Renew it and upload the new certificate in Settings → Business details.`, url: `${APP_URL}?tab=settings&page=profile`, tag: `bizins-${kind}` };
}
export function invoicePayload(person: string, week: string, end?: unknown) {
  return { title: `Invoice in: ${person}`, body: `${person} sent his commission invoice for ${weekText(week, end)}. You can pay him.`, url: `${APP_URL}?tab=payroll&week=${week}`, tag: `invoice-${week}-${person}` };
}
// "Send a test" on one card in Settings → Notifications: the real wording on made-up data, titled "Test · …" so nobody
// takes it for a real lead or call. null for a kind that has no notification yet (a Google review) or does not exist.
// deno-lint-ignore no-explicit-any
export function testPayload(kind: string, R: { waitMinutes: number; unpaidDays: number; docDays: number }, today: string, cat?: any) {
  const p = kind === "newLead" ? leadPayload({ id: "test", full_name: "Sarah Mitchell", division: "Aircon", source: "Google Ads" })
    : kind === "leadWaiting" ? waitingPayload({ id: "test", full_name: "James Nguyen", division: "Chimney" }, R)
    : kind === "missedCall" ? callPayload({ id: "test", from_number: "0491 570 156", division: "Aircon" })
    : kind === "unpaid" ? unpaidPayload({ id: "test", customer_name: "Daniel Russo", amount: 480, date: shiftDay(today, -R.unpaidDays) }, R, cat)
    : kind === "invoice" ? invoicePayload("Sample Technician", shiftDay(today, -7))
    : kind === "docExpiry" ? docPayload({ id: "test", name: "Sample Employee" }, "arc", shiftDay(today, R.docDays))
    : kind === "bizInsurance" ? bizInsurancePayload("liability", shiftDay(today, BIZ_INSURANCE_DAYS))
    : null;
  return p ? { ...p, title: `Test · ${p.title}`, tag: `test-${kind}` } : null;
}

// deno-lint-ignore no-explicit-any
export async function scan(sb: any, nowMs: number) {
  const { data: st } = await sb.from("settings").select("catalog, unpaid_reminder_days").eq("id", 1).single();
  const N = (st && st.catalog && st.catalog.notify) || {};
  const R = notifyRules(N, st && st.unpaid_reminder_days);
  const on = (k: string) => notifyOn(N, k);
  if (!NOTIFY_KINDS.some(on)) return { ok: true, off: true, sent: 0 };
  // one scan at a time: the first call in each 8-minute window claims it
  const { error: busy } = await sb.from("push_sent").insert({ key: `scan:${Math.floor(nowMs / (8 * 60000))}` });
  if (busy) return { ok: true, busy: true, sent: 0 };
  const now = bizParts(nowMs, bizTzOf(st && st.catalog)), today = now.day;   // the business's day and hour (Region and format)
  // deno-lint-ignore no-explicit-any
  const events: { key: string; kind: string; payload: any }[] = [];
  if (on("newLead") || on("leadWaiting")) {
    const { data: leads } = await sb.from("contacts").select("id, full_name, division, source, status, created_at, contacted_at, last_read_at, tags, messages, reopened_at").gte("created_at", shiftDay(today, -1));
    for (const c of leads || []) {
      const at = arrivedAt(c); if (!at || TEST_TAG(c.tags)) continue;
      const atMs = Date.parse(at), age = nowMs - atMs;
      if (!(age >= 0 && age < 6 * 3600e3)) continue;   // only what came in in the last 6 hours, never a backlog
      if (on("newLead")) events.push({ key: `lead:${c.id}:${at}`, kind: "newLead", payload: leadPayload(c) });
      const touched = (c.status && c.status !== "New") || (c.contacted_at && Date.parse(c.contacted_at) >= atMs) || (c.last_read_at && Date.parse(c.last_read_at) >= atMs);
      if (on("leadWaiting") && !touched && age >= R.waitMinutes * 60000 && now.hour >= R.from && now.hour < R.until) events.push({ key: `waiting:${c.id}:${at}`, kind: "leadWaiting", payload: waitingPayload(c, R) });
    }
  }
  if (on("missedCall")) {
    const { data: calls } = await sb.from("calls").select("id, from_number, missed, started_at, division").eq("missed", true).gte("started_at", new Date(nowMs - 6 * 3600e3).toISOString());
    for (const c of calls || []) events.push({ key: `call:${c.id}`, kind: "missedCall", payload: callPayload(c) });
  }
  if (on("unpaid")) {
    const { data: jobs } = await sb.from("jobs").select("id, customer_name, amount, date, payment_status").eq("payment_status", "Unpaid").eq("date", shiftDay(today, -R.unpaidDays));
    for (const j of jobs || []) events.push({ key: `unpaid:${j.id}`, kind: "unpaid", payload: unpaidPayload(j, R, st && st.catalog) });
  }
  if (on("docExpiry")) {
    const { data: emps } = await sb.from("employees").select("id, name, status, documents");
    for (const e of emps || []) {
      if (e.status !== "Active") continue;
      for (const [kind, d] of Object.entries(e.documents || {})) {
        // deno-lint-ignore no-explicit-any
        const exp = (d as any) && (d as any).expiry; if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) continue;
        if (exp < today || exp > shiftDay(today, R.docDays)) continue;
        events.push({ key: `doc:${e.id}:${kind}:${exp}`, kind: "docExpiry", payload: docPayload(e, kind, exp) });
      }
    }
  }
  if (on("bizInsurance")) {
    // The business's own insurance (Settings → Business details), always 30 days before.
    const ins = (st && st.catalog && st.catalog.business && st.catalog.business.insurance) || {};
    for (const kind of Object.keys(BIZ_INSURANCE_LABEL)) {
      const exp = ins[kind] && ins[kind].expiry;
      if (typeof exp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) continue;
      if (exp < today || exp > shiftDay(today, BIZ_INSURANCE_DAYS)) continue;
      events.push({ key: `bizins:${kind}:${exp}`, kind: "bizInsurance", payload: bizInsurancePayload(kind, exp) });
    }
  }
  if (!events.length) return { ok: true, sent: 0 };
  const { data: people } = await sb.from("profiles").select("id, role");
  // deno-lint-ignore no-explicit-any
  const owners = (people || []).filter((p: any) => p.role === "owner").map((p: any) => p.id);
  // deno-lint-ignore no-explicit-any
  const office = (people || []).filter((p: any) => p.role === "va" || p.role === "manager").map((p: any) => p.id);
  const keys = await vapidKeys(sb);
  let sent = 0, skipped = 0;
  for (const ev of events.slice(0, 30)) {
    const { error: dup } = await sb.from("push_sent").insert({ key: ev.key });   // claimed once, ever
    if (dup) { skipped++; continue; }
    // the office only for a new lead, a waiting lead and a missed call, when chosen; the rest to the owners only
    const to = [...owners, ...(OFFICE_KINDS.includes(ev.kind) && N[ev.kind] && N[ev.kind].office ? office : [])];
    const r = await sendTo(sb, to, ev.payload, keys);
    sent += r.sent;
  }
  return { ok: true, events: events.length, skipped, sent };
}
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, me: any) {
  const step = String(body?.step || "");
  if (step === "key") { const k = await vapidKeys(sb); return { status: 200, body: { ok: true, publicKey: k.publicKey } }; }
  if (step === "scan") return { status: 200, body: await scan(sb, Date.now()) };
  if (!me) return { status: 401, body: { ok: false, reason: "unauthorized" } };

  if (step === "test") {
    if (!isOffice(me)) return { status: 403, body: { ok: false, reason: "owners only" } };
    const kind = body?.kind == null || body.kind === "" ? "" : String(body.kind);
    let payload: Record<string, unknown> = { title: "Notifications are on", body: "This phone will get the notifications that are switched on in Settings → Notifications.", url: APP_URL + "?tab=payroll", tag: "test" };
    if (kind) {
      // One card's test: its real wording with the saved numbers (Settings → Notifications).
      const { data: st } = await sb.from("settings").select("catalog, unpaid_reminder_days").eq("id", 1).single();
      const p = testPayload(kind, notifyRules(st?.catalog?.notify, st?.unpaid_reminder_days), bizParts(Date.now(), bizTzOf(st?.catalog)).day, st?.catalog);
      if (!p) return { status: 400, body: { ok: false, reason: "unknown notification" } };
      payload = p;
    }
    const r = await sendTo(sb, [me.id], payload, await vapidKeys(sb));
    return { status: 200, body: { ok: r.sent > 0, ...r } };
  }

  if (step === "selftest") {
    if (!isOffice(me)) return { status: 403, body: { ok: false, reason: "owners only" } };
    const keys = await vapidKeys(sb);
    const device = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", device.publicKey));
    const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const details = io.build({ endpoint: "https://example.invalid/push/selftest", keys: { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } },
      JSON.stringify({ title: "selftest" }), { vapidDetails: { subject: CONTACT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 60 });
    return { status: 200, body: { ok: !!details && !!details.headers && !!details.headers.Authorization, method: details?.method, bytes: details?.body?.length || 0 } };
  }

  if (step === "invoice") {
    const week = body?.week, person = String(body?.person || "").trim();
    if (!isDay(week) || !person) return { status: 400, body: { ok: false, reason: "week and person needed" } };
    const self = me.role === "technician" && me.technician_name && me.technician_name === person;
    if (!isOffice(me) && !self) return { status: 403, body: { ok: false, reason: "not your invoice" } };
    const { data: rows } = await sb.from("payroll_weeks").select("salary_invoice_file").eq("week_start", week).eq("person", person).limit(1);
    if (!rows || !rows[0] || !rows[0].salary_invoice_file) return { status: 409, body: { ok: false, reason: "no commission invoice on that week" } };
    // Switched off in Settings → Notifications (on unless someone turned it off, as before 13 Oct).
    const { data: st } = await sb.from("settings").select("catalog").eq("id", 1).single();
    const inv = st && st.catalog && st.catalog.notify && st.catalog.notify.invoice;
    if (inv && inv.on === false) return { status: 200, body: { ok: true, off: true, sent: 0 } };
    const { data: owners } = await sb.from("profiles").select("id").eq("role", "owner");
    // deno-lint-ignore no-explicit-any
    const r = await sendTo(sb, (owners || []).map((o: any) => o.id), invoicePayload(person, week, body?.end), await vapidKeys(sb));
    return { status: 200, body: { ok: true, ...r } };
  }
  return { status: 400, body: { ok: false, reason: "unknown step" } };
}

// The signed-in person (profile), or null.
// deno-lint-ignore no-explicit-any
async function caller(sb: any, req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role, technician_name").eq("id", u.user.id).single();
  return p || null;
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__PUSH_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "Could not parse request body" }, 400); }
    try {
      const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
      const me = body.step === "key" || body.step === "scan" ? null : await caller(sb, req);
      const r = await handle(sb, body, me);
      return json(r.body, r.status);
    } catch (e) {
      console.error("push failed:", e);
      return json({ ok: false, reason: String((e as Error).message || e) }, 500);
    }
  });
}
