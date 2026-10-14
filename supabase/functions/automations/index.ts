// automations: the ONE automation engine (settings round 2, phase 4; plan items 11a/11b/11c, 8b, P2, P3; Ofek 13–14 Oct).
//
// OPS is becoming a product many businesses use, each with its own automations (Ofek 14 Oct), so NOTHING here is fixed:
// every trigger, wait, time window, condition, action, recipient, message and number is a row the business edits
// (public.automations), and the kinds of trigger, condition, action and merge field come from the REGISTRIES below
// (TRIGGERS, CONDITIONS, ACTIONS, MERGE_FIELDS): adding a kind = adding an entry; the engine loop never changes. The
// business's own services, stages, sources and tags are read from its settings (settings.catalog), never typed in here.
//
// An automation = { trigger: { type, params }, steps: [ wait | window | if | action ] } (the form editor and the flow view
// of the builder edit the same array). One run per automation per event (automation_runs, unique automation_id +
// event_key), one log row per action (automation_log, unique run_id + step_id): the same event never fires the same
// automation twice, and an action never goes twice, even after a crash.
//
// Steps (POST { step, ... }):
//   tick      the timer (pg_cron 'automations-tick', every minute, header x-automations-secret = AUTOMATIONS_CRON_SECRET,
//             the same value as Vault 'automations_cron_secret'). Answers 202 at once and works in the background:
//             finds every event itself from the tables (new lead, stage change, job closed, missed call, website chat —
//             the tables are the source of truth, the app may be closed), starts the runs of the automations that are
//             ON, then moves every run that is due (delays, time windows, conditions, actions). Also follows up the
//             emails handed to the info@ mailbox and tidies old runs once a day.
//   event     { type, id } from the app right after it saved something (owners, managers, and the office with CRM / Jobs
//             access): "look now". The server re-reads the record itself (the app's data is never used) and starts
//             only what the tick would start; the same event later seen by the tick does nothing more.
//   preview   { automation | automation_id, record: { kind, id } } (owners and managers): what this automation would do
//             for that record — the filled messages, the guard verdicts, would-wait-until / would-skip-because. Writes
//             nothing and sends nothing.
//   registry  (owners and managers) the lists the builder shows: triggers, conditions, actions, merge fields.
//
// Guard rails (always on; their numbers are settings in public.automation_settings):
//   • NOTHING goes to a customer unless the automation is explicitly ON (checked when the run starts, before every
//     step, and again right before a customer action). New and duplicated customer automations are stored OFF (SQL).
//   • Texts to customers wait for the business phone: the engine has NO Twilio code; a text is only logged as
//     'waiting_phone'. Turning texts on later is a code change plus a test, not a switch.
//   • Customer messages only inside the customer days and hours (a later time is waited for, and the conditions and an
//     "Only on" window before it are checked again then), never to a test record, a 'do not contact' tag, a customer
//     marked don't ask, an opted-out card or address (customer_opt_outs, written from the lead card), and at most
//     customer_daily_cap automatic messages per customer per 24 hours on every channel: this engine's to any card with
//     the same email or phone (a duplicate card shares the cap), the other functions' automatic messages to the card and
//     review requests to the address. The cap is claimed in one locked database call (automation_claim_customer), so two
//     calls at the same moment never both pass. A message with a blank the engine cannot fill is not sent.
//   • An event before the automation was switched on, or before its start or steps last changed (armed_at; the SQL
//     guard moves it), never fires it, and a waiting run from before that stops; a run more than max_late_hours late
//     acts no more; a run whose automation was switched off, changed or deleted stops. A stage move younger than the
//     app's Undo (STAGE_SETTLE_MS) is not acted on, and a stage run stops when the move was undone.
// Emails go the existing way (P3: nothing live changes): a queued lead_messages row, sent by the info@ Apps Script
// through conversations' alerts step, which adds its own signature from the author's first word (signatureOf below
// shows it in the preview). The author is the business's signer or the automation maker's first name, never a phrase;
// every automatic email ends with the business's way out (email_footer). An email the mailbox has not sent by the end
// of the customer hours is withdrawn (reconcile).
//
// The review request, chat text, missed-call text and phone notifications keep running exactly as today in their own
// functions (P3): they are NOT engine rows yet; the builder shows them from their own settings.
//
// Owner steps: run the H-engine section of .claude/sql/settings-round2-phase4.sql; make a long random value and store it
// in Vault ('automations_cron_secret') and as the Edge Function secret AUTOMATIONS_CRON_SECRET; deploy this function with
// Verify JWT OFF (the timer has no user token; every app call is checked in code below).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : "") || "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CONTACT = env("PUSH_CONTACT") || "mailto:info@theguyservicegroup.com";   // only the VAPID subject of the phone notifications (as push; a business sets its own)
const APP_URL = env("APP_URL") || "https://theguysgroup.github.io/the-guys-ops-app/";
const BUSINESS_ID = env("BUSINESS_ID") || "default";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-automations-secret",
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
  now: () => Date.now(),
  // The public holiday library (the same version the app loads from jsdelivr), loaded only when the stored list needs it.
  // deno-lint-ignore no-explicit-any
  holidayLib: async (): Promise<any> => (await import("npm:date-holidays@3.37.0")).default,
  // The timer answers at once (pg_net gives up after 10 s) and keeps working in the background.
  waitUntil: (p: Promise<unknown>) => {
    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(p);
  },
  // The executor the timer and "look now" run a claimed run with once SQL Part 1 is in (the compat switch, engineMode):
  // advanceV2, a phase-4 row read through upgradeV1. Before Part 1 they run phase 4's advance instead (the tests run
  // the whole phase-4 suite through both).
  // deno-lint-ignore no-explicit-any
  advance: (sb: any, run: any, T: TickCtx, nowMs: number): Promise<Record<string, unknown>> => advanceV2(sb, run, T, nowMs),
};

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

// ── phone notifications: copied byte for byte from push/index.ts (a test fails if the two copies ever differ) ──
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

// The timer's secret, compared without an early exit. Both must be set. (Copied from backup/index.ts.)
const enc = new TextEncoder();
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// ── small helpers ──
// deno-lint-ignore no-explicit-any
const obj = (x: any) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const iso = (ms: number) => new Date(ms).toISOString();
const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
const clip = (x: unknown, n: number) => String(x ?? "").slice(0, n);
const HOUR = 3600e3, DAY = 24 * HOUR;
// An address with a quote, comma, bracket or backslash is refused: it would also break the opt-out lookup's filter text.
export const cleanEmail = (e: unknown) => { const s = String(e || "").trim().toLowerCase(); return /^[^\s@"',()\\]+@[^\s@"',()\\]+\.[^\s@"',()\\]+$/.test(s) ? s : ""; };
// Phones (copied from conversations): E.164 (+61…); the last 9 digits are the key of an opt-out.
export function toE164(v: unknown): string {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : "";
  d = d.replace(/\D/g, "");
  if (/^1[38]00\d{6}$/.test(d)) return "+61" + d;
  if (d.startsWith("61")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return /^\d{9}$/.test(d) ? "+61" + d : "";
}
export const phoneKey = (v: unknown) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(-9) : ""; };
export const isMobile = (e164: string) => /^\+614\d{8}$/.test(e164);
export function pretty(e164: string): string {
  const d = e164.startsWith("+61") ? "0" + e164.slice(3) : e164;
  if (/^04\d{8}$/.test(d)) return d.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  if (/^0\d{9}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3");
  return d;
}
// The words the apps put on a card that has no real name yet ("(no name)", "Caller 0412 …", "Text from …"): never a greeting.
const PLACEHOLDER_NAMES = new Set(["caller", "text", "unknown", "customer", "client", "lead", "new", "no", "name", "website", "test", "anonymous",
  "the", "our", "team", "office", "admin", "support", "info", "sales"]);
export function cleanFirstName(name: unknown): string {
  const n = String(name || "").trim();
  const first = (n.includes(",") ? (n.split(",")[1] || "").trim() : n).split(/\s+/)[0] || "";   // "Surname, First" too
  if (!/\p{L}/u.test(first) || first.length > 30 || /\d/.test(first)) return "";
  // Letters, an apostrophe or a hyphen only ("O'Brien", "Mary-Jane"); "(no", "Sam:" or "info@x" are not a name.
  if (!/^\p{L}[\p{L}\p{M}'’-]*$/u.test(first) || PLACEHOLDER_NAMES.has(first.toLowerCase())) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ── time in the business's own time zone ──
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FMT = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string) {
  let f = FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }); FMT.set(tz, f); }
  return f;
}
export function validTz(tz: unknown): boolean { try { return typeof tz === "string" && !!tz && !!fmtFor(tz); } catch { return false; } }
export function zoneParts(ms: number, tz: string) {
  const p = Object.fromEntries(fmtFor(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, dow: DOW.indexOf(String(p.weekday)), minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
export function shiftDay(day: string, n: number) { const [y, m, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const dowOf = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
// The UTC instant of a wall-clock time in tz (two passes handle daylight saving; review-requests' sydToUtc, with tz).
export function zoneToUtc(day: string, hh: number, mm: number, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(t, tz);
    const [py, pm, pd] = p.day.split("-").map(Number);
    t -= Date.UTC(py, pm - 1, pd, 0, p.minutes) - Date.UTC(y, m - 1, d, hh, mm);
  }
  return t;
}
// 'HH:MM' → minutes after midnight; '24:00' = the end of the day; anything else null.
export function hm(t: unknown): number | null {
  const s = String(t ?? "");
  if (s === "24:00") return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
// Office hours and days off (Settings → Office hours and holidays): the same rules and defaults as conversations'
// officeOpen (copied), in the business's time zone. Public holidays: the stored list of the region (holidayDaysOf).
const looseHm = (t: unknown) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// deno-lint-ignore no-explicit-any
function officeDays(cat: any): ({ from: number; to: number } | null)[] {
  const h = obj(cat && cat.hours), days: ({ from: number; to: number } | null)[] = [];
  for (let d = 0; d < 7; d++) {
    const x = { on: d >= 1 && d <= 5, from: "08:00", to: "17:00", ...((h.days || {})[d] || {}) };
    const f = looseHm(x.from), to = looseHm(x.to);
    days[d] = x.on && f !== null && to !== null && f < to ? { from: f, to } : null;
  }
  if (!days.some(Boolean)) for (let d = 1; d <= 5; d++) days[d] = { from: 480, to: 1020 };   // never no office day at all
  return days;
}
// deno-lint-ignore no-explicit-any
function officeClosedDay(cat: any, day: string): boolean {
  const h = obj(cat && cat.hours);
  if (holidayDaysOf(cat)[day]) return true;
  // deno-lint-ignore no-explicit-any
  return Array.isArray(h.extra) && h.extra.some((x: any) => x && x.date === day);
}
// ── The stored public holidays, kept up to date by the server too (T1.3) ──
// The app works catalog.holidays out in an owner's session; the timer does the same when nobody has opened the app, so
// the office's days off never depend on an owner's browser. Same rules as the app's holidaysFromLib / holidaysStale.
export const HOLIDAY_SOURCE = "date-holidays@3.37.0";
// How a country names a holiday moved to a weekday (the library says "substitute day"): AU says "additional day".
export const HOLIDAY_WORDING: Record<string, [RegExp, string][]> = { AU: [[/\s*\(substitute day\)$/i, " (additional day)"]] };
// deno-lint-ignore no-explicit-any
export function holidaysFromLib(H: any, country: string, state: string, fromYear: number, years: number, nowIso: string) {
  const hd = state ? new H(country, state, { types: ["public"] }) : new H(country, { types: ["public"] });
  const words = HOLIDAY_WORDING[country] || [], days: Record<string, string> = {};
  for (let y = fromYear; y < fromYear + years; y++) {
    for (const x of hd.getHolidays(y, "en") || []) {
      const d = String((x && x.date) || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || days[d]) continue;
      days[d] = words.reduce((t, [re, to]) => t.replace(re, to), String(x.name || "Public holiday"));
    }
  }
  const sorted: Record<string, string> = {}; Object.keys(days).sort().forEach((d) => { sorted[d] = days[d]; });
  return { region: state ? `${country}-${state}` : country, source: HOLIDAY_SOURCE, generatedAt: nowIso, from: `${fromYear}-01-01`, to: `${fromYear + years - 1}-12-31`, days: sorted };
}
// Why the stored list must be worked out again: 'missing', 'region' (made for another region), 'coverage' (under a year left), '' = fine.
// deno-lint-ignore no-explicit-any
export function holidaysStale(cat: any, today: string): string {
  const c = cat && typeof cat === "object" ? cat : {}, ph = c.holidays;
  if (!ph || !ph.days || typeof ph.days !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(String(ph.to || ""))) return "missing";
  if (ph.region !== regionKeyOf(c.region || {})) return "region";
  const ms = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); };
  return Math.round((ms(String(ph.to)) - ms(today)) / DAY) < 365 ? "coverage" : "";
}
let HOLIDAYS_TRIED = "";
// Once a day per region at most (a failure is not retried every minute): when the switch is on and the stored list is
// stale, work it out for this year and the next two and save ONLY catalog.holidays (set_catalog_holidays), so an owner's
// other settings are never overwritten. cat.holidays is updated for this run. Returns what it did.
// deno-lint-ignore no-explicit-any
export async function refreshHolidays(sb: any, cat: any, nowMs: number): Promise<string> {
  const h = obj(cat && cat.hours);
  if (!(h.publicOn ?? h.nsw)) return "off";
  const today = bizParts(nowMs, bizTzOf(cat)).day, why = holidaysStale(cat, today);
  if (!why) return "";
  const r = regionOf(cat), country = /^[A-Z]{2}$/.test(String(r.country || "")) ? r.country : REGION_DEFAULTS.country;
  const state = r.country ? String(r.state || "") : REGION_DEFAULTS.state, key = `${country}-${state}|${today}`;
  if (HOLIDAYS_TRIED === key) return "tried";
  HOLIDAYS_TRIED = key;
  const year = Number(today.slice(0, 4)), list = holidaysFromLib(await io.holidayLib(), country, state, year, 3, iso(nowMs));
  const { error } = await sb.rpc("set_catalog_holidays", { p_holidays: list });
  if (error) throw new Error(String(error.message || error));
  cat.holidays = list;
  return why;
}
// The allowed stretches of one local day, in minutes: [{ from, to }].
// deno-lint-ignore no-explicit-any
function dayRanges(day: string, win: any, cat: any): { from: number; to: number }[] {
  if (win.mode === "office" || win.mode === "outsideOffice") {
    const o = officeClosedDay(cat, day) ? null : officeDays(cat)[dowOf(day)];
    if (win.mode === "office") return o ? [o] : [];
    return (o ? [{ from: 0, to: o.from }, { from: o.to, to: 1440 }] : [{ from: 0, to: 1440 }]).filter((r) => r.to > r.from);
  }
  const f = hm(win.from), u = hm(win.until);
  return Array.isArray(win.days) && win.days.includes(dowOf(day)) && f !== null && u !== null && f < u ? [{ from: f, to: u }] : [];
}
// Is this moment inside the window? win = { days: [0..6], from: 'HH:MM', until: 'HH:MM' } or { mode: 'office' | 'outsideOffice' }.
// deno-lint-ignore no-explicit-any
export function inWindow(ms: number, win: any, tz: string, hoursCat: any): boolean {
  const p = zoneParts(ms, tz);
  return dayRanges(p.day, obj(win), hoursCat).some((r) => p.minutes >= r.from && p.minutes < r.to);
}
const atMinutes = (day: string, minutes: number, tz: string) => minutes >= 1440 ? zoneToUtc(shiftDay(day, 1), 0, 0, tz) : zoneToUtc(day, Math.floor(minutes / 60), minutes % 60, tz);
// The first moment at or after ms inside the window (up to 14 days ahead); null when the window never opens.
// deno-lint-ignore no-explicit-any
export function nextAllowed(ms: number, win: any, tz: string, hoursCat: any): number | null {
  if (inWindow(ms, win, tz, hoursCat)) return ms;
  const today = zoneParts(ms, tz).day;
  for (let d = 0; d <= 14; d++) {
    const day = shiftDay(today, d);
    for (const r of dayRanges(day, obj(win), hoursCat)) {
      const start = atMinutes(day, r.from, tz), end = atMinutes(day, r.to, tz);
      if (end <= ms) continue;
      return Math.max(start, ms);
    }
  }
  return null;
}
// The next allowed day at a set time ('at' = 'HH:MM'), strictly after ms; null when no day allows it. A day counts only when
// the time lies inside one of its allowed stretches (a 9–5 window never goes at 20:00, even "on the next allowed day").
// deno-lint-ignore no-explicit-any
export function nextAt(ms: number, win: any, at: string, tz: string, hoursCat: any): number | null {
  const m = hm(at); if (m === null || m >= 1440) return null;
  const today = zoneParts(ms, tz).day;
  for (let d = 0; d <= 14; d++) {
    const day = shiftDay(today, d);
    if (!dayRanges(day, obj(win), hoursCat).some((r) => m >= r.from && m < r.to)) continue;
    const t = atMinutes(day, m, tz);
    if (t > ms) return t;
  }
  return null;
}
// The first moment at or after ms inside BOTH the step's window and the customer hours (up to 14 days ahead), or null.
// deno-lint-ignore no-explicit-any
export function nextInBoth(ms: number, win: any, hours: any, tz: string, hoursCat: any): number | null {
  let t: number | null = ms;
  for (let k = 0; k < 60 && t !== null && t - ms <= 15 * DAY; k++) {
    const a = nextAllowed(t, win, tz, hoursCat); if (a === null) return null;
    const b = nextAllowed(a, hours, tz, hoursCat); if (b === null) return null;
    if (b === a) return a;
    t = b;
  }
  return null;
}
const WAIT_UNITS: Record<string, { ms: number; max: number }> = { minutes: { ms: 60e3, max: 1440 }, hours: { ms: HOUR, max: 168 }, days: { ms: DAY, max: 365 } };
// When a wait ends: minutes and hours by the clock; days = the same wall-clock time N days later (across daylight saving).
// deno-lint-ignore no-explicit-any
export function planWait(anchorMs: number, step: any, tz: string): number {
  const n = Number(step.n);
  if (step.unit === "days") { const p = zoneParts(anchorMs, tz); return zoneToUtc(shiftDay(p.day, n), Math.floor(p.minutes / 60), p.minutes % 60, tz) + (anchorMs % 60e3); }
  return anchorMs + n * (WAIT_UNITS[step.unit] || WAIT_UNITS.minutes).ms;
}

// ── the business's guard-rail numbers (automation_settings; nothing saved = these) ──
export const DEFAULT_SETTINGS = {
  timezone: "Australia/Sydney", customer_days: [0, 1, 2, 3, 4, 5, 6], customer_from: "08:00", customer_until: "20:00",
  customer_daily_cap: 1, respect_dont_ask: true, dont_contact_tags: [] as string[], ignore_test_records: true, test_tags: ["test"],
  max_late_hours: 24, lookback_hours: 6, email_signer: null as string | null,
  // The way out under every automatic email (Spam Act: a working unsubscribe). The office records the answer on the
  // card ("Stop automatic messages"); an empty value keeps this one.
  email_footer: "Rather not get these emails? Just reply \"stop\" and we'll take you off the list.",
};
export const LIMIT_FOOTER = 300;
export type Settings = typeof DEFAULT_SETTINGS;
// deno-lint-ignore no-explicit-any
export function normSettings(row: any): Settings {
  const r = obj(row), D = DEFAULT_SETTINGS;
  const int = (v: unknown, lo: number, hi: number, def: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : def; };
  const list = (v: unknown, def: string[]) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : def;
  let from = hm(r.customer_from) !== null ? String(r.customer_from) : D.customer_from, until = hm(r.customer_until) !== null ? String(r.customer_until) : D.customer_until;
  if ((hm(from) as number) >= (hm(until) as number)) { from = D.customer_from; until = D.customer_until; }
  const days = Array.isArray(r.customer_days) ? [...new Set(r.customer_days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))] as number[] : D.customer_days;
  return {
    timezone: validTz(r.timezone) ? r.timezone : D.timezone, customer_days: days, customer_from: from, customer_until: until,
    customer_daily_cap: int(r.customer_daily_cap, 1, 10, D.customer_daily_cap),
    respect_dont_ask: typeof r.respect_dont_ask === "boolean" ? r.respect_dont_ask : D.respect_dont_ask,
    dont_contact_tags: list(r.dont_contact_tags, D.dont_contact_tags),
    ignore_test_records: typeof r.ignore_test_records === "boolean" ? r.ignore_test_records : D.ignore_test_records,
    test_tags: list(r.test_tags, D.test_tags),
    max_late_hours: int(r.max_late_hours, 1, 720, D.max_late_hours), lookback_hours: int(r.lookback_hours, 1, 48, D.lookback_hours),
    email_signer: typeof r.email_signer === "string" && r.email_signer.trim() ? r.email_signer.trim().slice(0, 60) : null,
    email_footer: typeof r.email_footer === "string" && r.email_footer.trim() ? r.email_footer.trim().slice(0, LIMIT_FOOTER) : D.email_footer,
  };
}
const hasTag = (tags: unknown, list: string[]) => Array.isArray(tags) && tags.some((t) => list.some((x) => norm(x) === norm(t)));
const isTestRecord = (tags: unknown, S: Settings) => S.ignore_test_records && hasTag(tags, S.test_tags);

// ── the business's own lists (settings.catalog: services, sources, stages, tags) ──
// deno-lint-ignore no-explicit-any
function catList(cat: any, section: string): any[] { const l = obj(cat)[section]; return Array.isArray(l) ? l.filter((x) => x && typeof x === "object") : []; }
// deno-lint-ignore no-explicit-any
const catKey = (x: any) => String(x.key ?? x.tag ?? "");
// deno-lint-ignore no-explicit-any
export function catLabel(cat: any, section: string, key: unknown): string {
  const k = String(key ?? ""); if (!k) return "";
  const x = catList(cat, section).find((i) => catKey(i) === k);
  return (x && typeof x.label === "string" && x.label.trim()) ? x.label.trim() : k;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// REGISTRIES. Adding a kind of trigger, condition, action or merge field = adding an entry here.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type Ev = { key: string; type: string; recordKind: string; recordId: string; at: string; contactId: string | null; ctx: Record<string, unknown> };
const CONTACT_COLS = "id, full_name, phone, email, postcode, division, source, status, tags, created_at, contacted_at, last_read_at, reopened_at, messages, stage_changed_at, linked_job_id";
// What the minute scans read of a card: no thread (messages can be large and the scans run 1,440 times a day on the free
// plan's egress), only the time of its first entry.
const SCAN_CONTACT_COLS = "id, status, tags, created_at, reopened_at, stage_changed_at, linked_job_id, first_at:messages->0->>at";
const JOB_COLS = "id, customer_name, invoice_number, date, job_type, technician, amount, payment_status, review_do_not_ask, contact_id, created_at";
const CALL_COLS = "id, from_number, to_number, direction, missed, started_at, created_at, division, contact_id, status";
const CHAT_COLS = "id, contact_id, phone, first_name, full_name, service_key, brand, service_text, test, created_at";
const SCAN_MAX = 500;
const okTime = (at: unknown) => typeof at === "string" && !Number.isNaN(Date.parse(at));
// When a lead arrived: reopened, else its first message, else the moment it was made (a full timestamp only: a lead card
// made by hand stores only the day).
// deno-lint-ignore no-explicit-any
export const arrivedAt = (c: any): string | null => {
  const a = c.reopened_at || c.first_at || (Array.isArray(c.messages) && c.messages[0] && c.messages[0].at) || (typeof c.created_at === "string" && c.created_at.includes("T") ? c.created_at : null);
  return okTime(a) ? a : null;
};
// A stage set when the card was made (or reopened) is its arrival, not a move: the lead never moved.
const ARRIVAL_SLACK_MS = 30e3;   // the app sets the stage just before it saves the new card, and its first entry just after
// The app's Undo after a stage move runs 6.5 s; a move younger than this is not acted on yet (an undone misclick never fires).
export const STAGE_SETTLE_MS = 30e3;
// deno-lint-ignore no-explicit-any
type Trigger = { label: string; recordKind: string; table: string; cols: string; permission: string; params: Record<string, any>; implicit: { field: string; op: string }[]; settleMs?: number;
  // deno-lint-ignore no-explicit-any
  checkParams: (p: any) => string[]; match: (p: any, ev: Ev, nowMs: number, tz: string) => boolean;
  // deno-lint-ignore no-explicit-any
  fromRecord: (row: any, S: Settings) => Ev | null; scan: (sb: any, sinceMs: number, nowMs: number, S: Settings) => Promise<Ev[]> };
const ev = (type: string, recordKind: string, row: { id: unknown }, key: string, at: string, contactId: unknown, ctx: Record<string, unknown> = {}): Ev =>
  ({ key: clip(key, 200), type, recordKind, recordId: String(row.id), at: iso(Date.parse(at)), contactId: contactId ? String(contactId) : null, ctx });
const inScan = (e: Ev | null, sinceMs: number, nowMs: number) => !!e && Date.parse(e.at) >= sinceMs && Date.parse(e.at) <= nowMs + 5 * 60e3;
// deno-lint-ignore no-explicit-any
async function rows(q: any): Promise<any[]> { const { data, error } = await q; if (error) throw new Error(String(error.message || error)); return data || []; }

export const TRIGGERS: Record<string, Trigger> = {
  newLead: {
    label: "A new lead comes in", recordKind: "contact", table: "contacts", cols: SCAN_CONTACT_COLS, permission: "crm", params: {}, implicit: [],
    checkParams: () => [], match: () => true,
    // One run per arrival: a lead that is reopened later is a new arrival. A card the app makes for a job (it has its
    // job from the start) is a customer, not a new lead.
    fromRecord: (c, S) => {
      if (!c || isTestRecord(c.tags, S)) return null;
      if (c.linked_job_id && !c.reopened_at) return null;
      const at = arrivedAt(c); if (!at) return null;
      return ev("newLead", "contact", c, `${c.id}:${c.reopened_at || "new"}`, at, c.id);
    },
    scan: async (sb, sinceMs, nowMs, S) => {
      const sinceDay = shiftDay(zoneParts(sinceMs, S.timezone).day, -1);
      const list = await rows(sb.from("contacts").select(SCAN_CONTACT_COLS).or(`created_at.gte.${sinceDay},reopened_at.gte."${iso(sinceMs)}"`).order("created_at", { ascending: false }).limit(SCAN_MAX));
      return list.map((c) => TRIGGERS.newLead.fromRecord(c, S)).filter((e) => inScan(e, sinceMs, nowMs)) as Ev[];
    },
  },
  stage: {
    label: "A lead moves to a pipeline stage", recordKind: "contact", table: "contacts", cols: SCAN_CONTACT_COLS, permission: "crm",
    params: { stage: { label: "Stage", valueSource: "catalog.stages", optional: true } },
    // Before every condition and action: the move still stands (an Undo puts the old stage and its time back).
    implicit: [{ field: "stage_move_stands", op: "true" }], settleMs: STAGE_SETTLE_MS,
    checkParams: (p) => (p.stage == null || p.stage === "" || (typeof p.stage === "string" && p.stage.length <= 40)) ? [] : ["the stage is not valid"],
    match: (p, e) => !p.stage || String(p.stage) === String(e.ctx.stage),
    fromRecord: (c, S) => {
      if (!c || isTestRecord(c.tags, S) || !okTime(c.stage_changed_at) || !c.status) return null;
      const arrived = arrivedAt(c);
      if (arrived && Math.abs(Date.parse(c.stage_changed_at) - Date.parse(arrived)) <= ARRIVAL_SLACK_MS) return null;   // made in that stage
      return ev("stage", "contact", c, `${c.id}:${c.status}:${c.stage_changed_at}`, c.stage_changed_at, c.id, { stage: String(c.status) });
    },
    scan: async (sb, sinceMs, nowMs, S) => {
      const list = await rows(sb.from("contacts").select(SCAN_CONTACT_COLS).gte("stage_changed_at", iso(sinceMs)).order("stage_changed_at", { ascending: false }).limit(SCAN_MAX));
      return list.map((c) => TRIGGERS.stage.fromRecord(c, S)).filter((e) => inScan(e, sinceMs, nowMs)) as Ev[];
    },
  },
  jobClosed: {
    label: "A job is closed", recordKind: "job", table: "jobs", cols: JOB_COLS, permission: "jobs",
    params: { maxJobAgeDays: { label: "Only jobs done in the last … days", valueSource: "number", min: 1, max: 30, default: 7 } }, implicit: [],
    checkParams: (p) => (p.maxJobAgeDays == null || (Number.isInteger(p.maxJobAgeDays) && p.maxJobAgeDays >= 1 && p.maxJobAgeDays <= 30)) ? [] : ["the job age must be 1 to 30 days"],
    match: (p, e, nowMs, tz) => {
      const max = p.maxJobAgeDays == null ? 7 : Number(p.maxJobAgeDays), d = String(e.ctx.jobDate || "");
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= shiftDay(zoneParts(nowMs, tz).day, -max);
    },
    // Only jobs entered after the engine's SQL have created_at: an old job can never count as newly closed.
    fromRecord: (j) => (j && okTime(j.created_at)) ? ev("jobClosed", "job", j, String(j.id), j.created_at, j.contact_id, { jobDate: String(j.date || "").slice(0, 10) }) : null,
    scan: async (sb, sinceMs, nowMs, S) => {
      const list = await rows(sb.from("jobs").select(JOB_COLS).gte("created_at", iso(sinceMs)).order("created_at", { ascending: false }).limit(SCAN_MAX));
      return list.map((j) => TRIGGERS.jobClosed.fromRecord(j, S)).filter((e) => inScan(e, sinceMs, nowMs)) as Ev[];
    },
  },
  missedCall: {
    label: "A call is missed", recordKind: "call", table: "calls", cols: CALL_COLS, permission: "jobs", params: {}, implicit: [],
    checkParams: () => [], match: () => true,
    fromRecord: (c) => (c && c.missed === true && okTime(c.started_at)) ? ev("missedCall", "call", c, String(c.id), c.started_at, c.contact_id) : null,
    scan: async (sb, sinceMs, nowMs, S) => {
      const list = await rows(sb.from("calls").select(CALL_COLS).eq("missed", true).gte("started_at", iso(sinceMs)).order("started_at", { ascending: false }).limit(SCAN_MAX));
      return list.map((c) => TRIGGERS.missedCall.fromRecord(c, S)).filter((e) => inScan(e, sinceMs, nowMs)) as Ev[];
    },
  },
  chat: {
    label: "A website chat is not answered", recordKind: "chat", table: "chat_sessions", cols: CHAT_COLS, permission: "crm", params: {},
    implicit: [{ field: "chat_unanswered", op: "true" }],
    checkParams: () => [], match: () => true,
    fromRecord: (s, S) => (s && okTime(s.created_at) && !(S.ignore_test_records && s.test)) ? ev("chat", "chat", s, String(s.id), s.created_at, s.contact_id) : null,
    scan: async (sb, sinceMs, nowMs, S) => {
      const list = await rows(sb.from("chat_sessions").select(CHAT_COLS).gte("created_at", iso(sinceMs)).order("created_at", { ascending: false }).limit(SCAN_MAX));
      return list.map((s) => TRIGGERS.chat.fromRecord(s, S)).filter((e) => inScan(e, sinceMs, nowMs)) as Ev[];
    },
  },
};
const ALL_TRIGGERS = Object.keys(TRIGGERS);

// What the engine knows about one record when it checks conditions and fills messages (always read fresh).
// deno-lint-ignore no-explicit-any
// agent = the office person's first name ({agent}; TickCtx.agent).
export type Facts = { kind: string; type: string; contact: any; job: any; call: any; chat: any; ctx: Record<string, any>; eventAt: string; S: Settings; cat: any; company: string; nowMs: number; agent?: string };
const stageNow = (c: { status?: string; linked_job_id?: unknown }) => c.linked_job_id ? "Won" : String(c.status || "");
const customerPhone = (f: Facts) => (f.contact && f.contact.phone) || (f.call && f.call.from_number) || (f.chat && f.chat.phone) || "";

// deno-lint-ignore no-explicit-any
async function dontAskMarked(sb: any, f: Facts): Promise<boolean> {
  if (f.job && f.job.review_do_not_ask) return true;
  if (!f.contact) return false;
  const list = await rows(sb.from("jobs").select("id").eq("contact_id", f.contact.id).eq("review_do_not_ask", true).limit(1));
  return list.length > 0;
}
// Asked lately: by the review-requests function (review_requests), or by an automation of this engine that asks for
// reviews (one that uses this same condition): its customer messages to this card or address count too.
// deno-lint-ignore no-explicit-any
export const usesCond = (steps: any, field: string) => (Array.isArray(steps) ? steps : []).some((s: any) => s && s.kind === "if" && Array.isArray(s.conds) && s.conds.some((c: any) => c && c.field === field));
// deno-lint-ignore no-explicit-any
async function askedWithin(sb: any, f: Facts, months: number): Promise<boolean> {
  const phone = toE164(customerPhone(f)), email = cleanEmail(f.contact && f.contact.email);
  const ors = [phone ? `phone.eq."${phone}"` : "", email ? `email.eq."${email}"` : ""].filter(Boolean).join(",");
  const since = iso(f.nowMs - Math.round(months * 30.5) * DAY);
  if (ors) {
    const list = await rows(sb.from("review_requests").select("id").in("status", ["sent", "waiting"]).gte("created_at", since).or(ors).limit(1));
    if (list.length) return true;
  }
  const who = [f.contact ? `contact_id.eq.${f.contact.id}` : "", phone ? `recipient.eq."${phone}"` : "", email ? `recipient.eq."${email}"` : ""].filter(Boolean).join(",");
  if (!who) return false;
  const autos = await rows(sb.from("automations").select("id, steps").eq("business_id", BUSINESS_ID).range(0, 999));
  // deno-lint-ignore no-explicit-any
  const askers = autos.filter((x: any) => usesCond(x.steps, "asked_within_months")).map((x: any) => String(x.id));
  if (!askers.length) return false;
  const sent = await rows(sb.from("automation_log").select("id").eq("business_id", BUSINESS_ID).in("automation_id", askers).eq("audience", "customer")
    .in("status", ["sending", "sent", "queued"]).gte("at", since).or(who).limit(1));
  return sent.length > 0;
}
// The same rule as conversations' tick: any office reply (chat, text, email) that didn't fail, or a connected call to them.
// deno-lint-ignore no-explicit-any
async function chatUnanswered(sb: any, f: Facts): Promise<boolean> {
  const s = f.chat; if (!s) return false;
  const ans = sb.from("lead_messages").select("id, status").eq("direction", "out").eq("auto", false).gte("at", s.created_at);
  const replies = await rows(s.contact_id ? ans.eq("contact_id", s.contact_id) : ans.eq("session_id", s.id));
  // deno-lint-ignore no-explicit-any
  if (replies.some((m: any) => m.status !== "failed" && m.status !== "undelivered")) return false;
  const calls = await rows(sb.from("calls").select("id, status, duration").eq("direction", "outbound").eq("to_number", s.phone).gte("created_at", s.created_at));
  // deno-lint-ignore no-explicit-any
  if (calls.some((c: any) => Number(c.duration) > 0 || c.status === "completed" || c.status === "answered")) return false;
  return true;
}

type Cond = { label: string; ops: string[]; valueSource: string; appliesTo: string[]; gate?: boolean;
  // deno-lint-ignore no-explicit-any
  value: (f: Facts, sb: any, c: any) => unknown | Promise<unknown>; n?: { min: number; max: number } };
const LIST_OPS = ["is", "is_not", "in", "not_in"], BOOL_OPS = ["true", "false"], NUM_OPS = ["lte", "gte"];
export const CONDITIONS: Record<string, Cond> = {
  service: { label: "Service", ops: LIST_OPS, valueSource: "catalog.services", appliesTo: ALL_TRIGGERS,
    value: (f) => (f.contact && f.contact.division) || (f.job && f.job.job_type) || (f.call && f.call.division) || "" },
  source: { label: "Lead source", ops: LIST_OPS, valueSource: "catalog.sources", appliesTo: ALL_TRIGGERS, value: (f) => (f.contact && f.contact.source) || "" },
  tag: { label: "Tag", ops: ["has", "has_not"], valueSource: "catalog.tags", appliesTo: ALL_TRIGGERS, value: (f) => (f.contact && Array.isArray(f.contact.tags)) ? f.contact.tags : [] },
  stage: { label: "Pipeline stage now", ops: LIST_OPS, valueSource: "catalog.stages", appliesTo: ALL_TRIGGERS, value: (f) => f.contact ? stageNow(f.contact) : "" },
  // gate: always one more AND, even in an "any one of these" group (a "cancel if it moved on" is never an OR).
  stage_unchanged: { label: "Still in the stage that started it (stop if the lead moved on)", ops: BOOL_OPS, valueSource: "none", appliesTo: ["stage"], gate: true,
    value: (f) => !!f.contact && String(f.contact.status || "") === String(f.ctx.stage || "") },
  // Implicit for the stage start (never offered): the move was not undone. An Undo puts back the old stage AND its older
  // time; a later real move has a newer time (stage_unchanged is the business's own choice to stop then).
  stage_move_stands: { label: "The stage move was not undone", ops: BOOL_OPS, valueSource: "none", appliesTo: ["stage"],
    value: (f) => !!f.contact && okTime(f.contact.stage_changed_at) && Date.parse(f.contact.stage_changed_at) >= Date.parse(f.eventAt) },
  has_mobile: { label: "Has a mobile number", ops: BOOL_OPS, valueSource: "none", appliesTo: ALL_TRIGGERS, value: (f) => isMobile(toE164(customerPhone(f))) },
  has_email: { label: "Has an email address", ops: BOOL_OPS, valueSource: "none", appliesTo: ALL_TRIGGERS, value: (f) => !!cleanEmail(f.contact && f.contact.email) },
  dont_ask: { label: "Not marked don't ask", ops: BOOL_OPS, valueSource: "none", appliesTo: ALL_TRIGGERS, value: async (f, sb) => !(await dontAskMarked(sb, f)) },
  asked_within_months: { label: "Not asked for a review in the last … months", ops: BOOL_OPS, valueSource: "number", appliesTo: ALL_TRIGGERS, n: { min: 1, max: 36 },
    value: async (f, sb, c) => !(await askedWithin(sb, f, Number(c.n))) },
  not_picked: { label: "Nobody has picked it up yet", ops: BOOL_OPS, valueSource: "none", appliesTo: ["newLead"],
    value: (f) => {
      const c = f.contact; if (!c) return false;
      const at = Date.parse(f.eventAt);
      const touched = (c.status && c.status !== "New") || (c.contacted_at && Date.parse(c.contacted_at) >= at) || (c.last_read_at && Date.parse(c.last_read_at) >= at);
      return !touched;
    } },
  unpaid: { label: "The job is unpaid", ops: BOOL_OPS, valueSource: "none", appliesTo: ["jobClosed"], value: (f) => !!f.job && f.job.payment_status === "Unpaid" },
  chat_unanswered: { label: "Nobody answered the chat", ops: BOOL_OPS, valueSource: "none", appliesTo: ["chat"], value: (f, sb) => chatUnanswered(sb, f) },
  chat_age_hours: { label: "The chat started at most / at least … hours ago", ops: NUM_OPS, valueSource: "number", appliesTo: ["chat"], n: { min: 0, max: 720 },
    value: (f) => f.chat ? (f.nowMs - Date.parse(f.chat.created_at)) / HOUR : Infinity },
};
// deno-lint-ignore no-explicit-any
function sameValue(a: unknown, b: unknown, list: any[]): boolean {
  if (norm(a) === norm(b)) return true;
  const x = list.find((i) => norm(catKey(i)) === norm(b));   // the condition holds the key; a record may hold the label
  return !!x && typeof x.label === "string" && norm(x.label) === norm(a) && norm(a) !== "";
}
// One rule's comparison. Phase-4 ops keep their exact meaning (is/is_not/in/not_in/has/has_not/lte/gte/true/false); the
// stage-2 OPS registry adds text, tag, number, money and date ops (design §2.5). env = the business clock for date ops.
// deno-lint-ignore no-explicit-any
export function applyOp(op: string, value: unknown, c: any, list: any[] = [], env: { nowMs?: number; tz?: string } = {}): boolean {
  const vs = Array.isArray(c.v) ? c.v : [];
  switch (op) {
    case "is": return sameValue(value, c.v, list);
    case "is_not": return !sameValue(value, c.v, list);
    case "in": return vs.some((v: unknown) => sameValue(value, v, list));
    case "not_in": return !vs.some((v: unknown) => sameValue(value, v, list));
    case "has": return Array.isArray(value) && value.some((t) => sameValue(t, c.v, list));
    case "has_not": return !(Array.isArray(value) && value.some((t) => sameValue(t, c.v, list)));
    case "lte": return Number(value) <= Number(c.n);
    case "gte": return Number(value) >= Number(c.n);
    case "true": return value === true;
    case "false": return value === false;
    // stage 2
    case "contains": return norm(c.v) !== "" && norm(value).includes(norm(c.v));
    case "not_contains": return !(norm(c.v) !== "" && norm(value).includes(norm(c.v)));
    case "contains_any": return vs.some((v: unknown) => norm(v) !== "" && norm(value).includes(norm(v)));
    case "contains_none": return !vs.some((v: unknown) => norm(v) !== "" && norm(value).includes(norm(v)));
    case "starts_with": return norm(c.v) !== "" && norm(value).startsWith(norm(c.v));
    case "is_empty": return emptyValue(value);
    case "is_not_empty": return !emptyValue(value);
    case "has_any": return Array.isArray(value) && vs.some((v: unknown) => value.some((t) => sameValue(t, v, list)));
    case "has_none": return !(Array.isArray(value) && vs.some((v: unknown) => value.some((t) => sameValue(t, v, list))));
    case "eq": return numOk(value) && numOk(c.n) && Number(value) === Number(c.n);
    case "neq": return numOk(value) && numOk(c.n) && Number(value) !== Number(c.n);
    case "gt": return numOk(value) && numOk(c.n) && Number(value) > Number(c.n);
    case "lt": return numOk(value) && numOk(c.n) && Number(value) < Number(c.n);
    case "between": {
      if (!numOk(value) || !numOk(c.n) || !numOk(c.v2)) return false;
      const x = Number(value), lo = Math.min(Number(c.n), Number(c.v2)), hi = Math.max(Number(c.n), Number(c.v2));
      return x >= lo && x <= hi;
    }
    case "before": case "after": case "on": {
      const tz = env.tz || REGION_DEFAULTS.timeZone, d = dayOfValue(value, tz), t = dayOfValue(c.v, tz);
      if (!d || !t) return false;
      return op === "before" ? d < t : op === "after" ? d > t : d === t;
    }
    case "within_last": case "within_next": case "more_than_ago": return relativeDate(op, value, c, env);
  }
  return false;   // never reached for a valid rule (the validators refuse unknown ops)
}
const emptyValue = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const numOk = (v: unknown) => v != null && !(typeof v === "string" && v.trim() === "") && typeof v !== "boolean" && Number.isFinite(Number(v));
// A record's date or timestamp as the business day it falls on ('YYYY-MM-DD'), or null.
export function dayOfValue(v: unknown, tz: string): string | null {
  if (typeof v !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return okTime(v) ? zoneParts(Date.parse(v), tz).day : null;
}
// 'YYYY-MM-DD' n months later (the last day of a shorter month: Jan 31 + 1 month = Feb 28/29).
export function shiftMonth(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
// within_last / within_next / more_than_ago: minutes and hours by the clock; days, weeks and months by business day.
// deno-lint-ignore no-explicit-any
function relativeDate(op: string, value: unknown, c: any, env: { nowMs?: number; tz?: string }): boolean {
  const n = Number(c.n), unit = String(c.unit || ""), now = env.nowMs ?? io.now(), tz = env.tz || REGION_DEFAULTS.timeZone;
  if (!Number.isFinite(n) || n < 0 || !WF_REL_UNITS.includes(unit) || typeof value !== "string") return false;
  if (unit === "minutes" || unit === "hours") {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? zoneToUtc(value, 0, 0, tz) : okTime(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(t)) return false;
    const span = n * (unit === "minutes" ? 60e3 : HOUR);
    return op === "within_last" ? t >= now - span && t <= now : op === "within_next" ? t >= now && t <= now + span : t < now - span;
  }
  const d = dayOfValue(value, tz); if (!d) return false;
  const today = zoneParts(now, tz).day;
  const shift = (sign: number) => unit === "months" ? shiftMonth(today, sign * n) : shiftDay(today, sign * n * (unit === "weeks" ? 7 : 1));
  return op === "within_last" ? d >= shift(-1) && d <= today : op === "within_next" ? d >= today && d <= shift(1) : d < shift(-1);
}
// deno-lint-ignore no-explicit-any
export async function evalConds(sb: any, f: Facts, conds: any[], match: "all" | "any"): Promise<{ ok: boolean; failed: string | null }> {
  // Gate conditions first, always all of them (an "any" group never turns a "stop if …" into an OR).
  const gates = conds.filter((c) => c && !c._gated && CONDITIONS[c.field] && CONDITIONS[c.field].gate);
  if (gates.length) {
    const g = await evalConds(sb, f, gates.map((c) => ({ ...c, _gated: true })), "all");
    if (!g.ok) return g;
    const rest = conds.filter((c) => !gates.includes(c));
    return rest.length ? await evalConds(sb, f, rest, match) : { ok: true, failed: null };
  }
  const failed: string[] = [];
  for (const c of conds) {
    const def = CONDITIONS[c.field];
    if (!def || !def.ops.includes(c.op)) { failed.push(String(c.field)); if (match === "all") break; continue; }
    const list = def.valueSource.startsWith("catalog.") ? catList(f.cat, def.valueSource.slice(8)) : [];
    const ok = applyOp(c.op, await def.value(f, sb, c), c, list);
    if (ok && match === "any") return { ok: true, failed: null };
    if (!ok) { failed.push(String(c.field)); if (match === "all") break; }
  }
  if (match === "any") return { ok: conds.length === 0, failed: failed.join(", ") || null };
  return { ok: failed.length === 0, failed: failed[0] || null };
}

export const LIMITS = { name: 120, title: 120, pushBody: 240, subject: 200, emailBody: 5000, textBody: 640, notes: 2000 };
type Action = { label: string; audience: "team" | "customer"; available: boolean; needs: string[];
  // deno-lint-ignore no-explicit-any
  check: (st: any) => string[] };
const tooLong = (x: unknown, n: number, what: string) => typeof x === "string" && x.length > n ? [`${what} is longer than ${n} characters`] : [];
const hasText = (x: unknown) => typeof x === "string" && x.trim() !== "";
export const ACTIONS: Record<string, Action> = {
  push: { label: "A phone notification to team members", audience: "team", available: true, needs: ["to.people or to.roles", "title"],
    check: (st) => {
      const to = obj(st.to), people = Array.isArray(to.people) ? to.people : [], roles = Array.isArray(to.roles) ? to.roles : [];
      return [...(people.length || roles.length ? [] : ["a notification needs at least one person or role"]), ...(hasText(st.title) ? [] : ["a notification needs a title"]),
        ...tooLong(st.title, LIMITS.title, "the title"), ...tooLong(st.body, LIMITS.pushBody, "the notification text")];
    } },
  task: { label: "A task in the app", audience: "team", available: true, needs: ["title"],
    check: (st) => [...(hasText(st.title) ? [] : ["a task needs a title"]), ...tooLong(st.title, LIMITS.title, "the task title"), ...tooLong(st.notes, LIMITS.notes, "the task notes"),
      ...(st.due_days == null || (Number.isInteger(st.due_days) && st.due_days >= 0 && st.due_days <= 365) ? [] : ["the task's due day must be 0 to 365 days after"]),
      ...(st.assignees == null || (Array.isArray(st.assignees) && st.assignees.length <= 10) ? [] : ["at most 10 people on a task"])] },
  email: { label: "An email to the customer", audience: "customer", available: true, needs: ["subject", "body or templateKey"],
    check: (st) => [...(hasText(st.subject) ? [] : ["an email needs a subject"]), ...(hasText(st.body) || hasText(st.templateKey) ? [] : ["an email needs a message"]),
      ...tooLong(st.subject, LIMITS.subject, "the subject"), ...tooLong(st.body, LIMITS.emailBody, "the email")] },
  // Until the business phone (Twilio) is live a text is only recorded as waiting; the engine has no code that sends it.
  text: { label: "A text message to the customer", audience: "customer", available: false, needs: ["body or templateKey"],
    check: (st) => [...(hasText(st.body) || hasText(st.templateKey) ? [] : ["a text needs a message"]), ...tooLong(st.body, LIMITS.textBody, "the text")] },
};

export const MERGE_FIELDS: Record<string, { label: string; events: string[] }> = {
  hi: { label: "Hi + first name (or Hi there)", events: ALL_TRIGGERS },
  first_name: { label: "First name", events: ALL_TRIGGERS },
  name: { label: "Full name", events: ALL_TRIGGERS },
  service: { label: "Service", events: ALL_TRIGGERS },
  brand: { label: "Brand of the service", events: ALL_TRIGGERS },
  business_name: { label: "Business name", events: ALL_TRIGGERS },
  agent: { label: "Office person's first name", events: ALL_TRIGGERS },
  suburb: { label: "Suburb or postcode", events: ALL_TRIGGERS },
  source: { label: "Lead source", events: ALL_TRIGGERS },
  stage: { label: "Pipeline stage", events: ALL_TRIGGERS },
  number: { label: "Phone number", events: ALL_TRIGGERS },
  technician: { label: "Technician's first name", events: ["jobClosed"] },
  amount: { label: "Job amount", events: ["jobClosed"] },
  job_date: { label: "Job date", events: ["jobClosed"] },
  minutes: { label: "The first wait, in minutes", events: ALL_TRIGGERS },
  automation: { label: "This automation's name", events: ALL_TRIGGERS },
};
export function fieldsFor(type: string): string[] { return Object.keys(MERGE_FIELDS).filter((k) => MERGE_FIELDS[k].events.includes(type)); }

// Fills {blanks} (the same rules as review-requests' fillReview): a known blank with a value is replaced; a known blank
// with nothing to put in takes its loose comma or space with it ("Hi {first_name}," → "Hi,"); an unknown {x} stays as it
// is, so unfilled() can stop the message.
export function fillMerge(text: string, vars: Record<string, string>, known: string[]): string {
  const E = "\u0000";
  return String(text ?? "").replace(/\{([a-z_]+)\}/g, (m, k) => known.includes(k) ? (vars[k] || E) : m)
    .replace(/,[ \t]*\u0000(?=[?!.])/g, "").replace(/[ \t]+\u0000(?=[,?!.])/g, "").replace(/[ \t]*\u0000/g, "").replace(/^[ \t]+/gm, "");
}
export function unfilled(text: string): string[] { return [...new Set([...String(text ?? "").matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))]; }
// deno-lint-ignore no-explicit-any
const firstWaitMinutes = (a: any) => { const w = (Array.isArray(a.steps) ? a.steps : []).find((s: any) => s && s.kind === "wait"); return w ? Number(w.n) * ((WAIT_UNITS[w.unit] || WAIT_UNITS.minutes).ms / 60e3) : 0; };
// deno-lint-ignore no-explicit-any
export function mergeVars(f: Facts, a: any): Record<string, string> {
  const c = f.contact, j = f.job, call = f.call, chat = f.chat;
  const name = String((c && c.full_name) || (chat && chat.full_name) || (j && j.customer_name) || "").trim();
  const first = cleanFirstName((chat && chat.first_name) || name);
  const division = String((c && c.division) || (j && j.job_type) || (call && call.division) || "");
  // The service's brand, else the business name (as before 14 Oct; the short name is only the chat and text word).
  const brands = obj(f.cat && f.cat.brands), brand = typeof brands[division] === "string" && brands[division].trim() ? brands[division].trim() : f.company;
  const phone = String(customerPhone(f)), e164 = toE164(phone);
  const minutes = firstWaitMinutes(a);
  return {
    hi: first ? `Hi ${first}` : "Hi there", first_name: first, name,
    service: (chat && chat.service_text) || catLabel(f.cat, "services", division),
    brand, business_name: f.company, agent: String(f.agent || "").trim() || officeOf(f.cat), suburb: String((c && (c.suburb || c.postcode)) || ""),
    source: c && c.source ? catLabel(f.cat, "sources", c.source) : "",
    stage: c ? catLabel(f.cat, "stages", stageNow(c)) : "",
    number: e164 ? pretty(e164) : phone,
    technician: j ? cleanFirstName(j.technician) : "",
    amount: j && j.amount != null && j.amount !== "" && Number.isFinite(Number(j.amount)) ? moneyText(Number(j.amount), f.cat, "plain") : "",
    job_date: j ? String(j.date || "") : "",
    minutes: minutes ? String(minutes) : "", automation: String(a.name || ""),
  };
}
// What conversations' alerts step adds under every email it hands to the info@ mailbox (shown in the builder's preview):
// the FIRST WORD of the author (else the office's name), then the business name and main phone from Business details
// (round 3, T1.7). Identical to the conversations copy (a test compares the two).
export function signatureOf(author: string, biz: { name?: string; phone?: string; office?: string }): string {
  const who = String(author || "").trim().split(" ")[0] || String(biz.office || "").trim() || "Office";
  return "\n\n" + [who, String(biz.name || "").trim(), String(biz.phone || "").trim()].filter(Boolean).join("\n");
}
// The office's name (Settings → Phone, catalog.labels.office); nothing saved = "Office".
// deno-lint-ignore no-explicit-any
export function officeOf(cat: any): string { const v = String(obj(obj(cat).labels).office || "").trim(); return v ? v.slice(0, 30) : "Office"; }
// The business details the signature uses: its name (settings.company_name), main phone and the office's name.
// deno-lint-ignore no-explicit-any
export function bizOf(company: string, cat: any) { const b = obj(cat && cat.business); return { name: String(company || "").trim(), phone: String(b.phone || "").trim(), office: officeOf(cat) }; }
// {agent}: the office person a message is from, as conversations' agentName: the VA on shift today first, then A–Z by
// name; none = the office's name.
// deno-lint-ignore no-explicit-any
export function agentOf(profiles: any[], day: string, cat: any): string {
  // deno-lint-ignore no-explicit-any
  const vas = (profiles || []).filter((p: any) => p && p.role === "va" && String(p.full_name || "").trim());
  // deno-lint-ignore no-explicit-any
  const on = (p: any) => !!p.on_duty && String(p.on_duty_date) === day;
  // deno-lint-ignore no-explicit-any
  vas.sort((a: any, b: any) => (on(a) === on(b) ? String(a.full_name).localeCompare(String(b.full_name)) : on(a) ? -1 : 1));
  return (vas.length && cleanFirstName(vas[0].full_name)) || officeOf(cat);
}
// Who signs an automatic email: the business's signer (Automations → Safety), else the first name of the person who made
// the automation. Never a phrase ("The team" would be signed "The"); none = the email is not sent.
// deno-lint-ignore no-explicit-any
export function emailAuthor(S: Settings, a: any): string {
  const own = String(S.email_signer || "").trim();
  if (own) return own;
  return cleanFirstName(a && a.created_by_name);
}
// The words of an automatic email: the message, then the way out (a blank line between).
export function emailBody(text: string, S: Settings): string {
  const t = String(text ?? "").replace(/\s+$/, ""), foot = String(S.email_footer || "").trim();
  return foot ? `${t}\n\n${foot}` : t;
}

// ── checking an automation ──
const STEP_KINDS = ["wait", "window", "if", "action"];
// deno-lint-ignore no-explicit-any
export function validateAutomation(a: any, _catalog?: any): string[] {
  const out: string[] = [];
  const t = obj(a && a.trigger), trig = TRIGGERS[t.type];
  if (!trig) out.push(`unknown trigger "${String(t.type ?? "")}"`);
  else out.push(...trig.checkParams(obj(t.params)));
  const steps = a && a.steps;
  if (!Array.isArray(steps)) return [...out, "the steps are not a list"];
  if (steps.length > 30) out.push("more than 30 steps");
  if (!steps.some((s) => s && s.kind === "action")) out.push("no action");
  const ids = new Set<string>();
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object") { out.push(`${at}: not a step`); return; }
    if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(s.id)) out.push(`${at}: bad id`);
    else if (ids.has(s.id)) out.push(`${at}: the id "${s.id}" is used twice`); else ids.add(s.id);
    if (!STEP_KINDS.includes(s.kind)) { out.push(`${at}: unknown kind "${String(s.kind ?? "")}"`); return; }
    if (s.kind === "wait") {
      const u = WAIT_UNITS[s.unit];
      if (!u) out.push(`${at}: unknown wait unit`);
      else if (!(Number.isInteger(s.n) && s.n >= 1 && s.n <= u.max)) out.push(`${at}: wait ${s.unit} must be 1 to ${u.max}`);
    } else if (s.kind === "window") {
      if (s.mode != null) { if (!["office", "outsideOffice"].includes(s.mode)) out.push(`${at}: unknown window mode`); }
      else {
        const days = s.days, f = hm(s.from), u = hm(s.until);
        if (!Array.isArray(days) || !days.length || days.some((d: unknown) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) || new Set(days).size !== days.length) out.push(`${at}: the window has no allowed day`);
        if (f === null || u === null || f >= 1440 || f >= u) out.push(`${at}: the window's hours are not valid`);
      }
      if (!["next", "skip", "at"].includes(s.outside)) out.push(`${at}: say what happens outside the window`);
      else if (s.outside === "at" && (hm(s.at) === null || (hm(s.at) as number) >= 1440)) out.push(`${at}: the time to send at is not valid`);
      else if (s.outside === "at" && s.mode == null && hm(s.from) !== null && hm(s.until) !== null && !((hm(s.at) as number) >= (hm(s.from) as number) && (hm(s.at) as number) < (hm(s.until) as number))) out.push(`${at}: the time to send at must be inside the window's hours`);
    } else if (s.kind === "if") {
      if (!["all", "any"].includes(s.match)) out.push(`${at}: say whether all or any of the conditions must hold`);
      const conds = s.conds;
      if (!Array.isArray(conds) || conds.length < 1 || conds.length > 10) { out.push(`${at}: 1 to 10 conditions`); return; }
      // deno-lint-ignore no-explicit-any
      conds.forEach((c: any, k: number) => {
        const def = CONDITIONS[c && c.field], w = `${at}, condition ${k + 1}`;
        if (!def) { out.push(`${w}: unknown condition "${String(c && c.field)}"`); return; }
        if (trig && !def.appliesTo.includes(t.type)) out.push(`${w}: "${c.field}" does not apply to this trigger`);
        if (!def.ops.includes(c.op)) { out.push(`${w}: unknown comparison "${String(c.op)}"`); return; }
        if (["is", "is_not", "has", "has_not"].includes(c.op) && !(typeof c.v === "string" && c.v.trim() && c.v.length <= 100)) out.push(`${w}: pick a value`);
        if (["in", "not_in"].includes(c.op) && !(Array.isArray(c.v) && c.v.length >= 1 && c.v.length <= 50 && c.v.every((x: unknown) => typeof x === "string" && x.trim()))) out.push(`${w}: pick at least one value`);
        if (def.n && !(typeof c.n === "number" && Number.isFinite(c.n) && c.n >= def.n.min && c.n <= def.n.max)) out.push(`${w}: the number must be ${def.n.min} to ${def.n.max}`);
      });
    } else {
      const act = ACTIONS[s.type];
      if (!act) { out.push(`${at}: unknown action "${String(s.type ?? "")}"`); return; }
      out.push(...act.check(s).map((p) => `${at}: ${p}`));
    }
  });
  return out;
}
// deno-lint-ignore no-explicit-any
export function audienceOf(a: any): "team" | "customer" {
  // deno-lint-ignore no-explicit-any
  return (Array.isArray(a && a.steps) ? a.steps : []).some((s: any) => s && s.kind === "action" && ACTIONS[s.type] && ACTIONS[s.type].audience === "customer") ? "customer" : "team";
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== REGISTRY (stage 2: workflow docs, schema 2; design §2.3–§2.5)
// The single source of truth of the v2 engine AND the app: every trigger, action, wait, goal, logic node, condition
// field, operator, merge field and reason, each with GHL's exact label (ghl; null = ours), our label (label), its
// availability with the reason (available) and a declarative config schema (fields: a JSON-Schema subset with
// x-source / x-ref / x-greyed / x-requireOne). The app reads the export (registryExport) and the JSON Schema
// (jsonSchema); it never copies these as constants. The phase-4 TRIGGERS / CONDITIONS / ACTIONS / MERGE_FIELDS above
// keep running the phase-4 rows until phase 7, hence the WF_ prefix here.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Registry maps have no prototype ("constructor" is never an entry) and lookups of user keys are own-key only.
const nul = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), o);
const has = (o: unknown, k: unknown) => !!o && typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
export type Avail = { ok: boolean; reason?: string };
export type AvailCtx = { phone: boolean; xero: boolean; gbp: boolean; reviews: boolean; ai: boolean; teamEmail: boolean; assignee: boolean; atomicTags: boolean };
// The words next to a greyed item, per missing piece (design §2.4, exact).
export const AVAIL_REASONS: Record<string, string> = {
  phone: "Needs the phone line (Twilio)", xero: "Needs Xero", gbp: "Needs the Google Business Profile connector",
  reviews: "Turn on Google reviews first", ai: "Coming with Workflow AI", teamEmail: "Needs a team email sender",
  assignee: "Needs 'Assigned to' on the lead card", atomicTags: "Coming with the new lead card",
};
export const WF_NOT_YET = {
  later: "Coming later", tracking: "Needs tracking (not in OPS)", builtIn: "Built-in only for now",
  action: "Needs link and email-open tracking (not in OPS)", seconds: "The timer runs once a minute",
  dndOff: "Only a person can turn automatic messages back on", contactTz: "Leads have no time zone yet",
};
// What this business has today (design §2.5 availCtx). settingsRow = the settings row (phone_enabled,
// review_requests_*), cat = settings.catalog. ai stays false until stage 6; teamEmail until Q7; atomicTags until G2.3.
// deno-lint-ignore no-explicit-any
export function availCtxOf(settingsRow: any, cat: any, extra: Partial<AvailCtx> = {}): AvailCtx {
  const s = obj(settingsRow), c = obj(cat), con = obj(c.connectors);
  return {
    phone: s.phone_enabled === true, xero: obj(con.xero).connected === true, gbp: obj(con.gbp).connected === true,
    reviews: s.review_requests_enabled === true || s.review_requests_auto === true, ai: false, teamEmail: false,
    assignee: obj(c.features).leadAssignee === true, atomicTags: false, ...extra,
  };
}
const AV_OK: Avail = { ok: true };
const avAlways = (): Avail => AV_OK;
const avNeeds = (flag: keyof AvailCtx) => (c: AvailCtx): Avail => (c && c[flag]) ? AV_OK : { ok: false, reason: AVAIL_REASONS[flag] };
const avNever = (reason: string) => (): Avail => ({ ok: false, reason });
// An x-greyed value: an AvailCtx flag (greyed while it is off) or a fixed reason (always greyed).
function greyedReason(g: string, c: AvailCtx): string | null {
  if (Object.prototype.hasOwnProperty.call(AVAIL_REASONS, g)) return (c && c[g as keyof AvailCtx]) ? null : AVAIL_REASONS[g];
  return g;
}

// ── schema building blocks (a JSON-Schema subset; schemaCheck below reads exactly these keywords) ──
// deno-lint-ignore no-explicit-any
export type JSchema = Record<string, any>;
const ID_PATTERN = "^[A-Za-z][A-Za-z0-9_]{0,39}$";
export const WF_ID_RE = new RegExp(ID_PATTERN);
const HM_PATTERN = "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$";
const sc = {
  str: (max = 200, o: JSchema = {}): JSchema => ({ type: "string", maxLength: max, ...o }),
  req: (max = 200, o: JSchema = {}): JSchema => ({ type: "string", minLength: 1, maxLength: max, ...o }),
  int: (min: number, max: number, o: JSchema = {}): JSchema => ({ type: "integer", minimum: min, maximum: max, ...o }),
  bool: (): JSchema => ({ type: "boolean" }),
  en: (values: string[], o: JSchema = {}): JSchema => ({ type: "string", enum: values, ...o }),
  arr: (items: JSchema, min = 0, max = 50, o: JSchema = {}): JSchema => ({ type: "array", items, minItems: min, maxItems: max, ...o }),
  obj: (props: Record<string, JSchema>, required: string[] = [], o: JSchema = {}): JSchema => ({ type: "object", properties: props, required, additionalProperties: false, ...o }),
  hm: (): JSchema => ({ type: "string", pattern: HM_PATTERN }),
  day: (): JSchema => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  ref: (nullable = false): JSchema => ({ type: nullable ? ["string", "null"] : "string", pattern: ID_PATTERN, "x-ref": "node" }),
  src: (list: string, o: JSchema = {}): JSchema => ({ type: "string", minLength: 1, maxLength: 100, "x-source": list, ...o }),
  def: (name: string): JSchema => ({ $ref: `#/$defs/${name}` }),
};
const TIME_UNITS = ["minutes", "hours", "days"];
const S_TIMEOUT = sc.obj({ n: sc.int(1, 365), unit: sc.en(TIME_UNITS) }, ["n", "unit"]);
const S_OFFSET = sc.obj({ n: sc.int(0, 365), unit: sc.en(TIME_UNITS) }, ["n", "unit"]);
const S_DAYS = sc.arr(sc.int(0, 6), 1, 7, { uniqueItems: true });
const S_MSG = (max: number) => ({ body: sc.str(max), templateKey: sc.src("catalog.templates") });
const REQUIRE_MSG = { "x-requireOne": ["body", "templateKey"], anyOf: [{ required: ["body"] }, { required: ["templateKey"] }] };
export const WF_WAIT_MAX: Record<string, number> = { minutes: 1440, hours: 168, days: 365 };

// ── FIELDS: what a condition can look at (phase-4 CONDITIONS keys kept with their meaning) ──
export const WF_VALUE_TYPES = ["text", "enum", "tags", "number", "money", "date", "bool", "people"];
export const WF_OPS_BY_TYPE: Record<string, string[]> = nul({
  text: ["is", "is_not", "contains", "not_contains", "contains_any", "contains_none", "starts_with", "in", "not_in", "is_empty", "is_not_empty"],
  enum: ["is", "is_not", "in", "not_in", "is_empty", "is_not_empty"],
  tags: ["has", "has_not", "has_any", "has_none", "is_empty", "is_not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"],
  money: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"],
  date: ["before", "after", "on", "within_last", "within_next", "more_than_ago", "is_empty", "is_not_empty"],
  bool: ["true", "false"],
  people: ["is", "in", "is_empty", "is_not_empty"],
});
export type WfField = {
  key: string; label: string; group: string; valueType: string; ops: string[]; source?: string; recordKinds: string[]; triggers?: string[];
  gate?: boolean; hidden?: boolean; wakeOn: string[]; timeRelative?: boolean; sensitivity?: "money" | "private";
  arg?: { n: { min: number; max: number } }; values?: { key: string; label: string }[]; available?: (c: AvailCtx) => Avail;
  // deno-lint-ignore no-explicit-any
  value: (f: any, sb: any, rule: any) => unknown | Promise<unknown>;
};
// deno-lint-ignore no-explicit-any
const fv = (rec: string, col: string) => (f: any) => { const r = f && f[rec]; return r && r[col] !== undefined ? r[col] : null; };
// deno-lint-ignore no-explicit-any
const p4 = (k: string) => (f: any, sb: any, r: any) => CONDITIONS[k].value(f, sb, r);
const ANY_REC = ["contact", "job", "call", "chat"];
const fd = (key: string, label: string, group: string, valueType: string, recordKinds: string[], value: WfField["value"], x: Partial<WfField> = {}): WfField =>
  ({ key, label, group, valueType, ops: WF_OPS_BY_TYPE[valueType], recordKinds, wakeOn: [], value, ...x });
const opt = (keys: string[], labels?: string[]) => keys.map((k, i) => ({ key: k, label: labels ? labels[i] : k }));
// The lead card columns a "Lead changed" trigger watches (capture whitelist) and "Update lead field" may write (minus phone/email).
export const CONTACT_CHANGED_FIELDS = ["full_name", "phone", "email", "postcode", "division", "source", "next_follow_up", "booked_for", "quote_amount", "lost_reason"];
export const UPDATE_FIELD_COLUMNS = CONTACT_CHANGED_FIELDS.filter((c) => c !== "phone" && c !== "email");
export const WF_FIELDS: Record<string, WfField> = nul(Object.fromEntries([
  // phase 4 (same keys, same values)
  fd("service", "Service", "Lead", "enum", ANY_REC, p4("service"), { source: "catalog.services", wakeOn: ["contact_changed"] }),
  fd("source", "Lead source", "Lead", "enum", ["contact"], p4("source"), { source: "catalog.sources", wakeOn: ["contact_changed"] }),
  fd("tag", "Tag", "Lead", "tags", ["contact"], p4("tag"), { source: "catalog.tags", wakeOn: ["contact_tag"] }),
  fd("stage", "Pipeline stage now", "Lead", "enum", ["contact"], p4("stage"), { source: "catalog.stages", wakeOn: ["stage", "lead_status"] }),
  fd("stage_unchanged", "Still in the stage that started it (stop if the lead moved on)", "Lead", "bool", ["contact"], p4("stage_unchanged"), { triggers: ["stage"], gate: true, wakeOn: ["stage"] }),
  fd("stage_move_stands", "The stage move was not undone", "Lead", "bool", ["contact"], p4("stage_move_stands"), { triggers: ["stage"], hidden: true }),
  fd("has_mobile", "Has a mobile number", "Lead", "bool", ["contact", "call", "chat"], p4("has_mobile"), { wakeOn: ["contact_changed"] }),
  fd("has_email", "Has an email address", "Lead", "bool", ["contact"], p4("has_email"), { wakeOn: ["contact_changed"] }),
  fd("dont_ask", "Not marked don't ask", "Lead", "bool", ["contact", "job"], p4("dont_ask")),
  fd("asked_within_months", "Not asked for a review in the last … months", "Lead", "bool", ["contact", "job", "call", "chat"], p4("asked_within_months"), { arg: { n: { min: 1, max: 36 } } }),
  fd("not_picked", "Nobody has picked it up yet", "Lead", "bool", ["contact"], p4("not_picked"), { triggers: ["newLead", "form_submitted"], wakeOn: ["stage", "lead_status"] }),
  fd("unpaid", "The job is unpaid", "Job", "bool", ["job"], p4("unpaid"), { triggers: ["jobClosed"], wakeOn: ["payment_received"] }),
  fd("chat_unanswered", "Nobody answered the chat", "Chat", "bool", ["chat"], p4("chat_unanswered"), { triggers: ["chat"], wakeOn: ["user_replied"] }),
  fd("chat_age_hours", "The chat started at most / at least … hours ago", "Chat", "number", ["chat"], p4("chat_age_hours"), { triggers: ["chat"], timeRelative: true }),
  // lead card
  fd("lead.name", "Full name", "Lead", "text", ["contact"], fv("contact", "full_name"), { wakeOn: ["contact_changed"] }),
  fd("lead.email", "Email", "Lead", "text", ["contact"], fv("contact", "email"), { wakeOn: ["contact_changed"] }),
  fd("lead.phone", "Phone", "Lead", "text", ["contact"], fv("contact", "phone"), { wakeOn: ["contact_changed"] }),
  fd("lead.postcode", "Suburb or postcode", "Lead", "text", ["contact"], fv("contact", "postcode"), { wakeOn: ["contact_changed"] }),
  fd("lead.created", "Created", "Lead", "date", ["contact"], fv("contact", "created_at"), { timeRelative: true }),
  fd("lead.stage_changed", "Moved stage at", "Lead", "date", ["contact"], fv("contact", "stage_changed_at"), { timeRelative: true, wakeOn: ["stage"] }),
  fd("lead.booked_for", "Booked for", "Lead", "date", ["contact"], fv("contact", "booked_for"), { timeRelative: true, wakeOn: ["job_booked", "booking_status"] }),
  fd("lead.next_follow_up", "Next follow-up", "Lead", "date", ["contact"], fv("contact", "next_follow_up"), { timeRelative: true, wakeOn: ["contact_changed"] }),
  fd("lead.quote_amount", "Quote amount", "Lead", "money", ["contact"], fv("contact", "estimated_value"), { sensitivity: "money", wakeOn: ["estimates"] }),
  fd("lead.lost_reason", "Lost reason", "Lead", "text", ["contact"], fv("contact", "lost_reason"), { wakeOn: ["lead_status"] }),
  fd("lead.assigned_user", "Assigned to", "Lead", "people", ["contact"], fv("contact", "assigned_user_id"), { source: "catalog.people", available: avNeeds("assignee"), wakeOn: ["contact_changed"] }),
  // job
  fd("job.amount", "Job amount", "Job", "money", ["job"], fv("job", "amount"), { sensitivity: "money", wakeOn: ["payment_received"] }),
  fd("job.date", "Job date", "Job", "date", ["job"], fv("job", "date"), { timeRelative: true }),
  fd("job.type", "Job service", "Job", "enum", ["job"], fv("job", "job_type"), { source: "catalog.services" }),
  fd("job.technician", "Technician", "Job", "text", ["job"], fv("job", "technician")),
  fd("job.payment_status", "Payment status", "Job", "text", ["job"], fv("job", "payment_status"), { wakeOn: ["payment_received"] }),
  // deno-lint-ignore no-explicit-any
  fd("call.status", "Call status", "Call", "enum", ["call"], (f: any) => f && f.call ? (f.call.missed === true ? "missed" : f.call.direction === "outbound" ? "outbound" : "answered") : null,
    { values: opt(["missed", "answered", "outbound"], ["Missed", "Answered", "Outbound"]) }),
  fd("task.title", "Task title", "Task", "text", ["task"], fv("task", "title")),
  fd("task.due", "Task due", "Task", "date", ["task"], fv("task", "due"), { timeRelative: true }),
  fd("task.status", "Task status", "Task", "text", ["task"], fv("task", "status"), { wakeOn: ["task_completed"] }),
  // the trigger that started the run (branch per trigger) and its payload
  // deno-lint-ignore no-explicit-any
  fd("trigger.id", "Workflow trigger", "Trigger", "enum", [], (f: any) => (f && (f.triggerId ?? obj(f.ctx).trigger_id)) ?? null, { source: "doc.triggers" }),
  // deno-lint-ignore no-explicit-any
  fd("trigger.type", "Workflow trigger type", "Trigger", "enum", [], (f: any) => (f && f.type) ?? null, { source: "registry.triggers" }),
  // deno-lint-ignore no-explicit-any
  ...([["stage", "Moved to stage", "enum", ["stage", "lead_status"], "catalog.stages"], ["tag", "Tag", "text", ["contact_tag"]],
    ["action", "Added or removed", "enum", ["contact_tag", "contact_dnd"]], ["channel", "Channel", "enum", ["customer_replied", "user_replied", "contact_dnd"]],
    ["field", "Changed field", "enum", ["contact_changed"]], ["call_status", "Call status", "enum", ["call_details"]], ["job_date", "Job date", "date", ["jobClosed"]],
    ["status", "Status", "text", ["booking_status", "lead_status", "estimates", "documents_contracts"]], ["form", "Form", "text", ["form_submitted"]]] as [string, string, string, string[], string?][])
    // deno-lint-ignore no-explicit-any
    .map(([k, label, vt, triggers, source]) => fd(`trigger.${k}`, label, "Trigger", vt, [], (f: any) => { const v = obj(f && f.ctx)[k === "job_date" ? "jobDate" : k]; return v === undefined ? null : v; },
      { triggers, ...(source ? { source } : {}), ...(k === "action" ? { values: opt(["added", "removed", "on", "off"], ["Added", "Removed", "Turned on", "Turned off"]) } : {}),
        ...(k === "channel" ? { values: opt(["chat", "email", "sms"], ["Chat", "Email", "SMS"]) } : {}), ...(k === "call_status" ? { values: opt(["missed", "answered", "outbound"], ["Missed", "Answered", "Outbound"]) } : {}),
        ...(k === "field" ? { values: opt(CONTACT_CHANGED_FIELDS) } : {}) })),
  // now (business time zone)
  // deno-lint-ignore no-explicit-any
  fd("now.day_of_week", "Day of the week", "Now", "enum", [], (f: any) => String(zoneParts(f.nowMs, obj(f.S).timezone || REGION_DEFAULTS.timeZone).dow),
    { values: opt(["0", "1", "2", "3", "4", "5", "6"], DOW), timeRelative: true }),
  // deno-lint-ignore no-explicit-any
  fd("now.day_of_month", "Day of the month", "Now", "number", [], (f: any) => Number(zoneParts(f.nowMs, obj(f.S).timezone || REGION_DEFAULTS.timeZone).day.slice(8)), { timeRelative: true }),
].map((x) => [x.key, x])));
// `trigger.<key>` that is not listed above: an inbound-webhook payload key (only an inbound webhook provides it).
export const isDynTriggerField = (k: unknown) => typeof k === "string" && /^trigger\.[a-z0-9_]{1,40}$/.test(k) && !WF_FIELDS[k];

// ── OPS: operators, their GHL label and their arguments (one shape per op: the JSON Schema is a oneOf by op) ──
export type WfOp = { label: string; args: "none" | "one" | "many" | "num" | "range" | "date" | "rel"; ref?: boolean };
export const WF_OPS: Record<string, WfOp> = nul({
  is: { label: "Is", args: "one", ref: true }, is_not: { label: "Is not", args: "one", ref: true },
  contains: { label: "Contains", args: "one" }, not_contains: { label: "Does not contain", args: "one" },
  contains_any: { label: "Contains any of", args: "many" }, contains_none: { label: "Does not contain any of", args: "many" },
  starts_with: { label: "Starts with", args: "one" }, in: { label: "Is any of", args: "many" }, not_in: { label: "Is none of", args: "many" },
  is_empty: { label: "Is empty", args: "none" }, is_not_empty: { label: "Is not empty", args: "none" },
  has: { label: "Has", args: "one" }, has_not: { label: "Does not have", args: "one" }, has_any: { label: "Has any of", args: "many" }, has_none: { label: "Has none of", args: "many" },
  eq: { label: "Is equal to", args: "num", ref: true }, neq: { label: "Is not equal to", args: "num", ref: true },
  gt: { label: "Is greater than", args: "num", ref: true }, gte: { label: "Is greater than or equal to", args: "num", ref: true },
  lt: { label: "Is less than", args: "num", ref: true }, lte: { label: "Is less than or equal to", args: "num", ref: true },
  between: { label: "Is between", args: "range" },
  before: { label: "Is before", args: "date", ref: true }, after: { label: "Is after", args: "date", ref: true }, on: { label: "Is on", args: "date", ref: true },
  within_last: { label: "Is within the last", args: "rel" }, within_next: { label: "Is within the next", args: "rel" }, more_than_ago: { label: "Is more than … ago", args: "rel" },
  true: { label: "Is true", args: "none" }, false: { label: "Is false", args: "none" },
});
export const WF_REL_UNITS = ["minutes", "hours", "days", "weeks", "months"];
const REF_TYPES = ["number", "money", "date", "enum"];   // GHL "Dynamic value": numeric, date, select and money only
export const opValueTypes = (op: string) => WF_VALUE_TYPES.filter((t) => WF_OPS_BY_TYPE[t].includes(op));
// The arguments of one op as JSON-Schema properties (+ which are required; ref-capable ops take v/n OR ref).
function opArgSchema(op: string): { props: Record<string, JSchema>; required: string[]; alt?: string } {
  const a = WF_OPS[op].args, V1 = sc.req(100), VN = sc.arr(sc.req(100), 1, 50);
  if (a === "one") return { props: { v: V1, ...(WF_OPS[op].ref ? { ref: sc.req(60) } : {}) }, required: WF_OPS[op].ref ? [] : ["v"], alt: WF_OPS[op].ref ? "v" : undefined };
  if (a === "many") return { props: { v: VN }, required: ["v"] };
  if (a === "num") return { props: { n: { type: "number" }, ref: sc.req(60) }, required: [], alt: "n" };
  if (a === "range") return { props: { n: { type: "number" }, v2: { type: "number" } }, required: ["n", "v2"] };
  if (a === "date") return { props: { v: sc.day(), ref: sc.req(60) }, required: [], alt: "v" };
  if (a === "rel") return { props: { n: sc.int(1, 1000), unit: sc.en(WF_REL_UNITS) }, required: ["n", "unit"] };
  return { props: (op === "true" || op === "false") ? { n: { type: "number" } } : {}, required: [] };   // a bool rule may carry its field's number (asked_within_months)
}

// ── MERGE FIELDS ({key}; {custom.<key>} and {trigger.<key>} are dynamic) ──
export const WF_MERGE_RE = /\{([a-z_]+(?:\.[a-z0-9_]+)?)\}/g;
export type WfMerge = { key: string; label: string; recordKinds: string[] | "*"; triggers?: string[]; sensitivity?: "money" | "private"; available?: (c: AvailCtx) => Avail };
const mf = (key: string, label: string, recordKinds: string[] | "*", x: Partial<WfMerge> = {}): WfMerge => ({ key, label, recordKinds, ...x });
export const WF_MERGE: Record<string, WfMerge> = nul(Object.fromEntries([
  mf("hi", "Hi + first name (or Hi there)", ANY_REC), mf("first_name", "First name", ANY_REC), mf("name", "Full name", ANY_REC),
  mf("service", "Service", ANY_REC), mf("brand", "Brand of the service", ANY_REC), mf("business_name", "Business name", "*"),
  mf("agent", "Office person's first name", "*"), mf("suburb", "Suburb or postcode", ["contact"]), mf("source", "Lead source", ["contact"]),
  mf("stage", "Pipeline stage", ["contact"]), mf("number", "Phone number", ["contact", "call", "chat"]),
  mf("technician", "Technician's first name", ["job"]), mf("amount", "Job amount", ["job"], { sensitivity: "money" }), mf("job_date", "Job date", ["job"]),
  mf("minutes", "The first wait, in minutes", "*"), mf("automation", "This automation's name", "*"),
  mf("task_title", "Task title", ["task"]), mf("due_date", "Task due date", ["task"]), mf("quote_amount", "Quote amount", ["contact"], { sensitivity: "money" }),
  mf("booked_date", "Booked date", ["contact"]), mf("follow_up_date", "Next follow-up date", ["contact"]), mf("lost_reason", "Lost reason", ["contact"]),
  mf("assigned_user", "Assigned user", ["contact"], { available: avNeeds("assignee") }),
].map((x) => [x.key, x])));

// ── REASONS (code → words; GHL wording where GHL has one) ──
export const WF_REASONS: Record<string, string> = nul({
  filter: "Filter not matched - {label} - Received value: {received}, Expected value: {expected}",
  before_published: "The event happened before the workflow was published", test_record: "A test record", loop_guard: "Stopped a loop between workflows",
  own_change: "This workflow's own change", reentry_off: "Already went through this workflow (re-entry is off)", already_enrolled: "Already in this workflow",
  duplicate_event: "The same event again", no_contact: "No lead card", unavailable: "Not available", paused_step: "The step is paused",
  too_late: "Too late", opted_out: "Opted out", capped: "Already contacted today", outside_hours: "Outside the allowed days and hours",
  missing_details: "Missing details", skip_comms: "Messages skipped until the next wait", removed_by_action: "Removed by Workflow Action",
  removed_by_external_action: "Removed by External Workflow Action", end_of_workflow: "Removed by - End Of Workflow", replied: "Stopped: the lead replied",
  automation_changed: "The workflow changed", switched_off: "The workflow was switched off", deleted: "The workflow was deleted", wrong_kind: "This workflow is not for this kind of record",
});
// "Filter not matched - Service - Received value: Gutters, Expected value: Aircon" (GHL's format).
export function filterReasonText(label: string, received: unknown, expected: unknown): string {
  const show = (x: unknown) => Array.isArray(x) ? x.join(", ") : x == null || x === "" ? "(empty)" : String(x);
  return WF_REASONS.filter.replace("{label}", label).replace("{received}", show(received)).replace("{expected}", show(expected));
}

// ── the entries ──
export type WfEntry = {
  key: string; ghl: string | null; label: string; description: string; category: string; icon: string; keywords: string[]; help: string;
  aliases?: string[]; available: (c: AvailCtx) => Avail; fields: JSchema; engine: boolean; hidden?: boolean; narration: string;
  // deno-lint-ignore no-explicit-any
  check?: (config: any) => { path: string; text: string }[];
};
export type WfTriggerEntry = WfEntry & { recordKind: string; provides: string[]; source: string; filters: string[]; eventKey: string; settleMs?: number;
  alwaysReenter?: boolean; contactless?: boolean | "maybe"; mirror?: string };
export type WfNodeEntry = WfEntry & { kind: string; audience?: string; channel?: string; needsContact?: boolean; outbound?: boolean; wakeOn?: string[]; portLabels?: Record<string, string> };
const NOW_F = ["now.day_of_week", "now.day_of_month"];
const LEAD_F = ["service", "source", "tag", "stage", "has_mobile", "has_email", "lead.name", "lead.email", "lead.phone", "lead.postcode", "lead.created", "lead.stage_changed",
  "lead.booked_for", "lead.next_follow_up", "lead.quote_amount", "lead.lost_reason", "lead.assigned_user", ...NOW_F];
const JOB_F = ["job.amount", "job.date", "job.type", "job.technician", "job.payment_status", "unpaid", "dont_ask", ...LEAD_F];
const PROVIDES: Record<string, string[]> = { contact: ["contact"], job: ["job", "contact"], call: ["call", "contact"], chat: ["chat", "contact"], task: ["task", "contact"],
  hook: ["contact"], supplier: ["supplier"], employee: ["employee"], none: [] };
const ent = (key: string, ghl: string | null, label: string, category: string, icon: string, description: string, x: Partial<WfEntry> = {}): WfEntry =>
  ({ key, ghl, label, description, category, icon, keywords: [], help: description, available: avAlways, fields: sc.obj({}), engine: true, narration: label, ...x });
const tr = (key: string, ghl: string | null, label: string, category: string, recordKind: string, source: string, eventKey: string, filters: string[], description: string,
  x: Partial<WfTriggerEntry> = {}): WfTriggerEntry =>
  ({ ...ent(key, ghl, label, category, "zap", description), recordKind, provides: PROVIDES[recordKind] || [], source, eventKey, filters, ...x } as WfTriggerEntry);
export const WF_ALWAYS_REENTER = ["job_booked", "booking_status", "jobClosed", "payment_received", "custom_date", "task_reminder", "scheduler", "stale"];
export const WF_TRIGGERS: Record<string, WfTriggerEntry> = nul(Object.fromEntries([
  tr("newLead", "Contact created", "Lead created", "Contact", "contact", "scan", '${id}:${reopened_at||"new"}', [...LEAD_F, "not_picked"], "Runs when a new lead comes in (or a closed one is reopened).", { icon: "user-plus" }),
  tr("contact_changed", "Contact changed", "Lead changed", "Contact", "contact", "capture", "${id}:chg:${field}:${txid}", ["trigger.field", ...LEAD_F], "Runs when a field on the lead card changes."),
  tr("contact_tag", "Contact tag", "Lead tag", "Contact", "contact", "capture", "${id}:tag:${+|-}:${tag}:${txid}", ["trigger.tag", "trigger.action", ...LEAD_F], "Runs when a tag is added to or removed from a lead.", { available: avNeeds("atomicTags"), icon: "tag" }),
  tr("custom_date", "Custom date reminder", "Custom date reminder", "Contact", "contact", "time", "${field}:${id}:${date}:${offsetKey}", [...JOB_F], "Runs on, before or after a date on the lead or job.", {
    fields: sc.obj({ field: sc.en(["lead.booked_for", "lead.next_follow_up", "job.date"]), when: sc.en(["on", "before", "after"]), offset: S_OFFSET, at: sc.hm() }, ["field", "when"]), icon: "calendar" }),
  tr("note_added", "Note added", "Note added", "Contact", "contact", "capture", "${id}:note:${noteId}", LEAD_F, "Runs when a note is added to a lead.", { available: avNeeds("atomicTags"), icon: "note" }),
  tr("task_added", "Task added", "Task added", "Contact", "task", "capture", "${id}:added", ["task.title", "task.due", "task.status", ...LEAD_F], "Runs when a task is added.", { icon: "check" }),
  tr("task_completed", "Task completed", "Task completed", "Contact", "task", "capture", "${id}:done:${txid}", ["task.title", "task.due", "task.status", ...LEAD_F], "Runs when a task is marked done.", { icon: "check" }),
  tr("task_reminder", "Task reminder", "Task reminder", "Contact", "task", "time", "${id}:due:${due}:${n}", ["task.title", "task.due", "task.status", ...LEAD_F], "Runs before a task is due.", {
    fields: sc.obj({ before: S_OFFSET }), icon: "bell" }),
  tr("contact_dnd", "Contact DND", "Lead DND", "Contact", "contact", "capture", "${optout_id}:${on|off}", ["trigger.action", "trigger.channel", ...LEAD_F], "Runs when automatic messages to a lead are stopped or allowed again.", { icon: "slash" }),
  tr("inbound_webhook", "Inbound webhook", "Inbound webhook", "Events", "hook", "hook", "hook:${hookId}:${requestId}", [...LEAD_F], "Runs when another system sends data to this workflow's link.", {
    fields: sc.obj({ match: sc.obj({ phone: sc.str(40, { pattern: "^[a-z0-9_]{1,40}$" }), email: sc.str(40, { pattern: "^[a-z0-9_]{1,40}$" }) }) }), contactless: "maybe", icon: "link" }),
  tr("scheduler", "Scheduler", "Scheduler", "Events", "none", "time", "sched:${wfId}:${triggerId}:${localISO}", NOW_F, "Runs on a schedule (no lead).", {
    fields: sc.obj({ freq: sc.en(["daily", "weekly", "monthly"]), days: S_DAYS, monthDays: sc.arr(sc.int(-1, 31), 1, 31, { uniqueItems: true }), at: sc.hm() }, ["freq", "at"]), contactless: true, icon: "clock" }),
  tr("call_details", "Call details", "Call details", "Events", "call", "scan", "${call.id} (missed) / ${call.id}:${status}", ["trigger.call_status", "call.status", ...LEAD_F], "Runs when a call is missed, answered or made.", { aliases: ["missedCall"], icon: "phone" }),
  tr("customer_replied", "Customer replied", "Lead replied", "Events", "contact", "capture", "msg:${id}", ["trigger.channel", ...LEAD_F], "Runs when a lead replies by chat or email.", { icon: "message" }),
  tr("user_replied", "User replied", "User replied", "Events", "contact", "capture", "msg:${id}", ["trigger.channel", ...LEAD_F], "Someone in the office replied", { icon: "message" }),
  tr("form_submitted", "Form submitted", "Website form submitted", "Events", "contact", "scan", '${id}:form:${reopened_at||"new"}', ["trigger.form", ...LEAD_F, "not_picked"], "Runs when the website form is sent.", { icon: "form" }),
  tr("chat", "Conversations SLA", "Conversations SLA", "Communication", "chat", "scan", "${session.id}", ["chat_age_hours", ...LEAD_F], "Runs when a website chat is not answered in time.", { icon: "chat" }),
  tr("job_booked", "Customer booked appointment", "Customer booked a job", "Jobs", "contact", "capture", "${id}:booked:${booked_for}", LEAD_F, "Runs when a lead is booked in.", { icon: "calendar" }),
  tr("booking_status", "Appointment status", "Job booking status", "Jobs", "contact", "capture", "${id}:bk:${status}:${txid}", ["trigger.status", ...LEAD_F], "Runs when a booking's status changes.", { icon: "calendar" }),
  tr("jobClosed", null, "Job closed", "Jobs", "job", "scan", "${job.id}", JOB_F, "Runs when a job is entered as done.", {
    fields: sc.obj({ maxJobAgeDays: sc.int(1, 30) }), icon: "briefcase" }),
  tr("stage", "Pipeline stage changed", "Pipeline stage changed", "Pipeline", "contact", "scan", "${id}:${status}:${stage_changed_at ISO ms}", ["trigger.stage", ...LEAD_F], "Runs when a lead moves to a pipeline stage.", { settleMs: STAGE_SETTLE_MS, icon: "columns" }),
  tr("lead_status", "Opportunity status changed", "Lead status changed", "Pipeline", "contact", "capture", "${id}:st:${status}:${txid}", ["trigger.stage", "trigger.status", ...LEAD_F], "Runs when a lead is marked open, won or lost.", { icon: "flag" }),
  tr("stale", "Stale opportunities", "Stale leads", "Pipeline", "contact", "time", "${id}:stale:${stage_changed_at}:${N}", LEAD_F, "Runs when a lead has stayed in its stage for some days.", {
    fields: sc.obj({ days: sc.int(1, 365) }, ["days"]), icon: "hourglass" }),
  tr("invoice", "Invoice", "Invoice", "Payments", "job", "capture", "", JOB_F, "Runs when an invoice changes.", { available: avNeeds("xero"), icon: "receipt" }),
  tr("commission_invoice", null, "Commission invoice received", "Ours", "none", "capture", "inv:${week}:${person}", NOW_F, "Runs when a contractor's weekly invoice comes in.", {
    available: avNever(WF_NOT_YET.builtIn), engine: false, hidden: true, mirror: "invoice", contactless: true, icon: "receipt" }),
  tr("payment_received", "Payment received", "Payment received (job paid)", "Payments", "job", "capture", "${id}:paid:${txid}", JOB_F, "Runs when a job is marked paid.", { icon: "dollar" }),
  tr("estimates", "Estimates", "Quote status", "Payments", "contact", "capture", "${id}:quote:${txid}", ["trigger.status", ...LEAD_F], "Runs when a quote is sent to a lead.", { icon: "file" }),
  tr("documents_contracts", "Documents & contracts", "Contractor agreement signed", "Payments", "supplier", "capture", "sup:${id}:signed:${agreement_signed_at}", ["trigger.status", ...NOW_F], "Runs when a contractor signs the agreement.", { contactless: true, icon: "file" }),
  tr("review_received", "New review received", "New Google review", "Events", "none", "capture", "rev:${reviewId}", NOW_F, "Runs when a new Google review comes in.", {
    available: avNeeds("gbp"), aliases: ["googleReview"], contactless: true, icon: "star" }),
  tr("doc_expiring", null, "Employee document expiring", "Ours", "employee", "time", "doc:${emp}:${doc}:${expiry}:${days}", NOW_F, "Runs before an employee's document expires.", {
    available: avNever(WF_NOT_YET.builtIn), engine: false, hidden: true, aliases: ["docExpiry"], contactless: true, icon: "id" }),
  tr("insurance_expiring", null, "Business insurance expiring", "Ours", "none", "time", "ins:${kind}:${expiry}:${days}", NOW_F, "Runs before the business insurance expires.", {
    available: avNever(WF_NOT_YET.builtIn), engine: false, hidden: true, aliases: ["bizInsurance"], contactless: true, icon: "shield" }),
].map((t) => [t.key, { ...t, alwaysReenter: WF_ALWAYS_REENTER.includes(t.key) }])));

// Nodes: actions, waits, goals and the logic kinds (if_else, split, goto, workflow).
const nd = (kind: string, key: string, ghl: string | null, label: string, category: string, icon: string, description: string, x: Partial<WfNodeEntry> = {}): WfNodeEntry =>
  ({ ...ent(key, ghl, label, category, icon, description), kind, ...x } as WfNodeEntry);
const act = (key: string, ghl: string | null, label: string, category: string, audience: string, description: string, fields: JSchema, x: Partial<WfNodeEntry> = {}) =>
  nd("action", key, ghl, label, category, "bolt", description, { audience, fields, needsContact: audience === "customer", outbound: audience === "customer" || audience === "external", ...x });
const S_TO = sc.obj({ people: sc.arr(sc.src("catalog.people"), 0, 20), roles: sc.arr(sc.en(["owner", "manager", "va", "technician"]), 0, 4, { uniqueItems: true }) });
export const WF_ACTIONS: Record<string, WfNodeEntry> = nul(Object.fromEntries([
  act("update_field", "Update contact field", "Update lead field", "Contact", "internal", "Changes a field on the lead card.", sc.obj({ field: sc.en(UPDATE_FIELD_COLUMNS), value: sc.str(500) }, ["field", "value"])),
  act("add_tag", "Add contact tag", "Add lead tag", "Contact", "internal", "Adds tags to the lead.", sc.obj({ tags: sc.arr(sc.src("catalog.tags"), 1, 10) }, ["tags"]), { available: avNeeds("atomicTags") }),
  act("remove_tag", "Remove contact tag", "Remove lead tag", "Contact", "internal", "Removes tags from the lead.", sc.obj({ tags: sc.arr(sc.src("catalog.tags"), 1, 10) }, ["tags"]), { available: avNeeds("atomicTags") }),
  act("assign_user", "Assign to user", "Assign to user", "Contact", "internal", "Sets who the lead is assigned to.", sc.obj({ user: sc.src("catalog.people") }, ["user"]), { available: avNeeds("assignee"), aliases: ["assign_owner"] }),
  act("remove_assigned_user", "Remove assigned user", "Remove assigned user", "Contact", "internal", "Clears who the lead is assigned to.", sc.obj({}), { available: avNeeds("assignee") }),
  act("dnd", "Enable/disable DND", "Stop automatic messages", "Contact", "internal", "Stops automatic messages to the lead.",
    sc.obj({ mode: sc.en(["enable", "disable"], { "x-greyed": { disable: WF_NOT_YET.dndOff } }), channel: sc.en(["all", "email", "sms", "chat"]) }, ["mode", "channel"])),
  act("add_note", "Add to notes", "Add to notes", "Contact", "internal", "Adds a note to the lead card.", sc.obj({ text: sc.req(2000) }, ["text"]), { available: avNeeds("atomicTags") }),
  act("add_task", "Add task", "Add task", "Contact", "team", "Adds a task in the app.", sc.obj({ title: sc.req(120), notes: sc.str(2000), due_days: sc.int(0, 365),
    assignees: sc.arr(sc.str(100), 0, 10), priority: sc.en(["Low", "Medium", "High", "Urgent"]) }, ["title"]), { aliases: ["task"], channel: "task" }),
  act("edit_conversation", "Edit conversation", "Edit conversation", "Contact", "internal", "Marks the lead's conversation as read", sc.obj({})),
  act("send_email", "Send email", "Send email", "Communication", "customer", "Sends an email to the lead.", sc.obj({ subject: sc.req(200), ...S_MSG(5000) }, ["subject"], REQUIRE_MSG), { aliases: ["email"], channel: "email" }),
  act("send_sms", "Send SMS", "Send SMS", "Communication", "customer", "Sends a text to the lead.", sc.obj(S_MSG(640), [], REQUIRE_MSG), { available: avNeeds("phone"), aliases: ["text"], channel: "sms" }),
  act("internal_notification", "Send internal notification", "Send internal notification", "Communication", "team", "Notifies people in the team.",
    sc.obj({ channel: sc.en(["push", "email", "sms"], { "x-greyed": { email: "teamEmail", sms: "phone" } }), to: S_TO, title: sc.req(120), body: sc.str(240) }, ["to", "title"]),
    { aliases: ["push"], channel: "push", check: (c) => (obj(c.to).people || []).length || (obj(c.to).roles || []).length ? [] : [{ path: "/to", text: "Pick at least one person or role" }] }),
  act("send_review_request", "Send review request", "Send review request", "Communication", "customer", "Asks the customer for a Google review.", sc.obj({}), { available: avNeeds("reviews"), channel: "review" }),
  act("send_live_chat", "Send live chat message", "Send live chat message", "Communication", "customer", "Replies in the lead's open website chat.", sc.obj(S_MSG(640), [], REQUIRE_MSG), { channel: "chat" }),
  act("manual_call", "Manual action to call", "Manual action to call", "Communication", "team", "Adds a call-the-lead task for the office.", sc.obj({ title: sc.req(120), notes: sc.str(2000) }, ["title"]), { channel: "task" }),
  act("manual_sms", "Manual action to SMS", "Manual action to SMS", "Communication", "team", "Adds a text-the-lead task for the office.", sc.obj({ title: sc.req(120), notes: sc.str(2000) }, ["title"]), { available: avNeeds("phone"), channel: "task" }),
  act("internal_comment", "Add internal comments", "Add internal comment", "Communication", "internal", "Adds a comment to the lead's history.", sc.obj({ text: sc.req(2000) }, ["text"])),
  act("move_stage", "Create/update opportunity", "Move lead to pipeline stage", "Pipeline", "internal", "Moves the lead to a stage.", sc.obj({ stage: sc.src("catalog.stages") }, ["stage"]),
    { check: (c) => norm(c.stage) === "won" ? [{ path: "/stage", text: "A lead is won when its job is entered" }] : [] }),
  act("mark_lost", null, "Mark lead lost", "Pipeline", "internal", "Marks the lead lost.", sc.obj({ reason: sc.str(100) })),
  act("send_invoice", "Send invoice", "Send invoice", "Payments", "customer", "Sends an invoice.", sc.obj({}), { available: avNeeds("xero"), channel: "email" }),
  act("send_estimate", "Send estimate", "Send quote", "Payments", "customer", "Sends a quote.", sc.obj({}), { available: avNeeds("xero"), channel: "email" }),
  act("webhook", "Webhook", "Webhook", "Send data", "external", "Sends the lead's details to another system.", sc.obj({ url: sc.req(2048), method: sc.en(["POST", "PUT"]),
    fields: sc.arr(sc.req(60), 0, 50), template: sc.str(16000), headers: sc.arr(sc.obj({ name: sc.req(100), value: sc.str(500) }, ["name", "value"]), 0, 10) }, ["url"]), { channel: "webhook", needsContact: false }),
  act("update_custom_value", "Update custom value", "Update custom value", "Internal", "internal", "Changes one of the business's custom values.",
    sc.obj({ key: sc.req(40, { pattern: "^[a-z][a-z0-9_]{0,39}$" }), value: sc.str(500) }, ["key", "value"])),
  act("math", "Math operation", "Math operation", "Internal", "none", "Works out a number.", sc.obj({}), { available: avNever(WF_NOT_YET.later) }),
  act("ai_agent", "AI Agent", "AI Agent", "Workflow AI", "none", "An AI agent step.", sc.obj({}), { available: avNeeds("ai") }),
  act("ai_decision", "AI decision maker", "AI decision maker", "Workflow AI", "none", "Lets AI pick a branch.", sc.obj({}), { available: avNeeds("ai") }),
  act("ai_summarize", "AI summarize", "AI summarize", "Workflow AI", "none", "Lets AI summarise the conversation.", sc.obj({}), { available: avNeeds("ai") }),
].map((x) => [x.key, x])));
// The customer audience + the outgoing webhook drive the Draft rules (SQL automation_action_audience mirrors this list;
// G2.4 adds the file-text parity test).
export const WF_GUARDED_AUDIENCES = ["customer", "external"];
export const WF_GUARDED_TYPES = Object.values(WF_ACTIONS).filter((a) => WF_GUARDED_AUDIENCES.includes(String(a.audience))).map((a) => a.key);

// Waits (GHL's 8 cards, GHL order; §2.3).
const timeoutCheck = (unitKey = "unit", nKey = "n") => (c: JSchema) => {
  const u = c[unitKey], n = c[nKey];
  return WF_WAIT_MAX[u] != null && typeof n === "number" && n > WF_WAIT_MAX[u] ? [{ path: `/${nKey}`, text: `At most ${WF_WAIT_MAX[u]} ${u}` }] : [];
};
const wt = (key: string, ghl: string, label: string, example: string, fields: JSchema, x: Partial<WfNodeEntry> = {}) =>
  nd("wait", key, ghl, label, "Internal", "hourglass", example, { fields, wakeOn: [], ...x });
const S_WINDOW = sc.obj({ use: sc.en(["office", "outsideOffice", "custom"]), days: S_DAYS, from: sc.hm(), until: sc.hm(), outside: sc.en(["next", "at", "end"]), at: sc.hm() }, ["use", "outside"]);
export const WF_WAITS: Record<string, WfNodeEntry> = nul(Object.fromEntries([
  wt("period", "For a set period of time", "For a set period of time", "Ex: 2 days, 6 hours, 30 minutes",
    sc.obj({ n: sc.int(1, 1440), unit: sc.en(["seconds", ...TIME_UNITS], { "x-greyed": { seconds: WF_NOT_YET.seconds } }),
      resume: sc.obj({ days: S_DAYS, from: sc.hm(), until: sc.hm() }, ["days", "from", "until"]) }, ["n", "unit"]),
    { check: (c) => [...timeoutCheck()(c), ...(c.resume && hm(c.resume.from) !== null && hm(c.resume.until) !== null && (hm(c.resume.from) as number) >= (hm(c.resume.until) as number) ? [{ path: "/resume/until", text: "The window must end after it starts" }] : [])] }),
  wt("date", "Until a specific date/time", "Until a specific date/time", "Ex: December 4th at 9:00 AM",
    sc.obj({ at: sc.str(16, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }), ref: sc.en(["lead.booked_for", "lead.next_follow_up", "job.date", "task.due"]), dayTime: sc.hm(),
      when: sc.en(["on", "before", "after"]), offset: S_OFFSET, ifPassed: sc.en(["continue", "end", "goto", "skip_comms"]), gotoStep: sc.ref(true) }, ["when", "ifPassed"]),
    { check: (c) => (c.at == null) === (c.ref == null) ? [{ path: "/at", text: "Pick a date or a date field (one of them)" }] : [] }),
  wt("recurring", "Until a recurring window opens", "Until a recurring window opens", "Ex: Every Tuesday, 15th of each month",
    { oneOf: [sc.obj({ mode: { const: "times" }, freq: sc.en(["weekly", "monthly", "yearly"]), days: S_DAYS, monthDays: sc.arr(sc.int(-1, 31), 1, 31, { uniqueItems: true }),
      nth: sc.arr(sc.int(-1, 5), 1, 5, { uniqueItems: true }), months: sc.arr(sc.int(1, 12), 1, 12, { uniqueItems: true }), date: sc.str(5, { pattern: "^\\d{2}-\\d{2}$" }), at: sc.hm() }, ["mode", "freq", "at"]),
    sc.obj({ mode: { const: "window" }, window: S_WINDOW }, ["mode", "window"])] },
    { check: (c) => {
      const w = obj(c.window), out: { path: string; text: string }[] = [];
      if (c.mode === "window" && w.use === "custom") {
        if (!Array.isArray(w.days) || !w.days.length) out.push({ path: "/window/days", text: "The window has no allowed day" });
        if (hm(w.from) === null || hm(w.until) === null || (hm(w.from) as number) >= 1440 || (hm(w.from) as number) >= (hm(w.until) as number)) out.push({ path: "/window/from", text: "The window's hours are not valid" });
      }
      if (c.mode === "window" && w.outside === "at" && (hm(w.at) === null || (hm(w.at) as number) >= 1440)) out.push({ path: "/window/at", text: "The time to send at is not valid" });
      else if (c.mode === "window" && w.outside === "at" && w.use === "custom" && hm(w.from) !== null && hm(w.until) !== null && !((hm(w.at) as number) >= (hm(w.from) as number) && (hm(w.at) as number) < (hm(w.until) as number)))
        out.push({ path: "/window/at", text: "The time to send at must be inside the window's hours" });
      if (c.mode === "times" && c.freq === "weekly" && !(Array.isArray(c.days) && c.days.length)) out.push({ path: "/days", text: "Pick at least one day" });
      if (c.mode === "times" && c.freq === "monthly" && !(Array.isArray(c.monthDays) && c.monthDays.length) && !(Array.isArray(c.nth) && c.nth.length && Array.isArray(c.days) && c.days.length)) out.push({ path: "/monthDays", text: "Pick the days of the month" });
      if (c.mode === "times" && c.freq === "yearly" && typeof c.date !== "string") out.push({ path: "/date", text: "Pick the date" });
      return out;
    } }),
  wt("scheduled", "Until a scheduled date/time", "Until a scheduled date/time", "Ex: 1 hour before scheduled appointment",
    sc.obj({ anchor: sc.en(["job.date", "lead.booked_for", "lead.next_follow_up", "invoice.due"], { "x-greyed": { "invoice.due": "xero" } }), when: sc.en(["at", "before", "after"]), offset: S_OFFSET,
      dayTime: sc.hm(), ifPassed: sc.en(["continue", "end", "goto", "skip_comms"]), gotoStep: sc.ref(true) }, ["anchor", "when", "ifPassed"])),
  wt("reply", "Until the contact replies", "Until the lead replies", "Wait for a reply on SMS, Email, etc.",
    sc.obj({ channels: sc.arr(sc.en(["chat", "email", "sms"], { "x-greyed": { sms: "phone" } }), 1, 3, { uniqueItems: true }), timeout: S_TIMEOUT }, ["channels"]),
    { portLabels: { next: "Replied", timeout: "Timed out" }, wakeOn: ["customer_replied"] }),
  wt("user_reply", "Until a user replies", "Until a user replies", "Wait for a user to send a message to the contact",
    sc.obj({ channels: sc.arr(sc.en(["chat", "email", "sms"], { "x-greyed": { sms: "phone" } }), 1, 3, { uniqueItems: true }),
      users: { oneOf: [sc.en(["any", "assigned"], { "x-greyed": { assigned: "assignee" } }), sc.arr(sc.src("catalog.people"), 1, 20)] }, timeout: S_TIMEOUT }, ["channels", "users"]),
    { portLabels: { next: "Replied", timeout: "Timed out" }, wakeOn: ["user_replied"] }),
  wt("action", "Until the contact takes a specific action", "Until the lead takes a specific action", "Ex: Clicks a link, Opens an email", sc.obj({}), { available: avNever(WF_NOT_YET.action) }),
  wt("conditions", "Until specific conditions are met", "Until specific conditions are met", "Build a custom segment with any of your fields",
    sc.obj({ when: sc.def("condition"), timeout: S_TIMEOUT }, ["when"]), { portLabels: { next: "Conditions met", timeout: "Timed out" } }),
].map((x) => [x.key, x])));
export const WF_HOLDING_WAITS = ["period", "date", "recurring", "scheduled"];   // + reply/user_reply/conditions WITH a timeout

// Goals (§3.6).
const IF_NOT_MET = sc.en(["end", "continue", "wait"]);
const gl = (key: string, ghl: string | null, label: string, wakeOn: string[], props: Record<string, JSchema>, required: string[] = [], x: Partial<WfNodeEntry> = {}) =>
  nd("goal", key, ghl, label, "Internal", "target", `Jumps here as soon as: ${label.toLowerCase()}.`, { fields: sc.obj({ ...props, ifNotMet: IF_NOT_MET }, [...required, "ifNotMet"]), wakeOn, ...x });
export const WF_GOALS: Record<string, WfNodeEntry> = nul(Object.fromEntries([
  gl("tag_added", "Contact Tag Added or Removed", "Tag added", ["contact_tag"], { tags: sc.arr(sc.src("catalog.tags"), 1, 10) }, ["tags"]),
  gl("tag_removed", "Contact Tag Added or Removed", "Tag removed", ["contact_tag"], { tags: sc.arr(sc.src("catalog.tags"), 1, 10) }, ["tags"]),
  gl("stage_reached", null, "Lead reached a stage", ["stage", "lead_status"], { stages: sc.arr(sc.src("catalog.stages"), 1, 20) }, ["stages"]),
  gl("lead_status", null, "Lead status", ["lead_status"], { statuses: sc.arr(sc.en(["open", "won", "lost"]), 1, 3, { uniqueItems: true }) }, ["statuses"]),
  gl("appointment", "Appointment Status", "Job booking status", ["job_booked", "booking_status"], { statuses: sc.arr(sc.req(40), 1, 10) }, ["statuses"]),
  gl("payment", "Payment Received", "Job paid", ["payment_received"], {}),
  gl("form", "Form Submitted", "Website form submitted", ["form_submitted"], {}),
  gl("user_replied", "User Replied", "Someone in the office replied", ["user_replied"], { channels: sc.arr(sc.en(["chat", "email", "sms"]), 1, 3, { uniqueItems: true }) }),
  gl("task", "Task Status", "Task status", ["task_added", "task_completed"], { status: sc.en(["created", "completed"]) }, ["status"]),
  gl("document", "Document Status", "Contractor agreement signed", ["documents_contracts"], {}),
  gl("email_event", "Email Events", "Email events", [], {}, [], { available: avNever(WF_NOT_YET.tracking) }),
  gl("trigger_link", "Clicked a Trigger Link", "Clicked a trigger link", [], {}, [], { available: avNever(WF_NOT_YET.tracking) }),
  gl("review_clicked", "Review Request Clicked", "Review request clicked", [], {}, [], { available: avNever(WF_NOT_YET.tracking) }),
].map((x) => [x.key, x])));

// Logic: If / else, Split, Go to, Add to / Remove from workflow.
export const WF_LOGIC: Record<string, WfNodeEntry> = nul(Object.fromEntries([
  nd("if_else", "if_else", "If / else", "If / else", "Internal", "branch", "Sends the lead down the first branch whose conditions match.", {
    fields: sc.obj({ branches: sc.arr(sc.obj({ id: sc.req(40, { pattern: ID_PATTERN }), name: sc.str(60), when: sc.def("condition") }, ["id", "when"]), 1, 10),
      noneName: sc.str(60), gate: sc.bool() }, ["branches"]) }),
  nd("split", "split", "Split", "Split", "Internal", "split", "Sends leads down paths at random, by percent.", {
    fields: sc.obj({ paths: sc.arr(sc.obj({ id: sc.req(40, { pattern: ID_PATTERN }), name: sc.str(60), percent: sc.int(0, 100) }, ["id", "percent"]), 2, 5) }, ["paths"]) }),
  nd("goto", "goto", "Go to", "Go to", "Internal", "corner", "Jumps to another step of this workflow.", { fields: sc.obj({ target: sc.ref(true) }, ["target"]) }),
  nd("workflow", "add_to_workflow", "Add to workflow", "Add to workflow", "Internal", "plus", "Starts another workflow for this lead.", {
    fields: sc.obj({ workflowId: sc.src("catalog.workflows"), passTriggerData: sc.bool() }, ["workflowId"]) }),
  nd("workflow", "remove_from_workflow", "Remove from workflow", "Remove from workflow", "Internal", "minus", "Takes the lead out of workflows.", {
    fields: sc.obj({ scope: sc.en(["current", "another", "all_except_current", "all"]), workflowId: sc.src("catalog.workflows") }, ["scope"]),
    check: (c) => c.scope === "another" && !c.workflowId ? [{ path: "/workflowId", text: "Pick the workflow" }] : [] }),
].map((x) => [x.key, x])));
// Narration templates ("Describe this workflow" is built from these, deterministically; {x} = the config value x, lists
// joined, catalog keys shown by their labels; the app's wfNodeSummary fills them). Entries not listed say their label.
const NARRATION: [Record<string, WfEntry>, Record<string, string>][] = [
  [WF_TRIGGERS, { newLead: "When a new lead comes in", stage: "When a lead moves to a pipeline stage", jobClosed: "When a job is closed", call_details: "When a call comes in",
    chat: "When a website chat is not answered", stale: "When a lead stays {days} days in its stage", scheduler: "Every {freq} at {at}", custom_date: "{when} the {field}",
    customer_replied: "When the lead replies", user_replied: "When someone in the office replies", form_submitted: "When the website form is sent", inbound_webhook: "When data comes in by webhook" }],
  [WF_WAITS, { period: "Wait {n} {unit}", date: "Wait until {at}{ref}", recurring: "Wait for the next allowed time", scheduled: "Wait until {when} the {anchor}",
    reply: "Wait for the lead to reply ({channels})", user_reply: "Wait for the office to reply ({channels})", conditions: "Wait until the conditions are met" }],
  [WF_ACTIONS, { send_email: "Email the lead: {subject}", send_sms: "Text the lead", send_live_chat: "Reply in the lead's chat", internal_notification: "Notify the team: {title}",
    add_task: "Add a task: {title}", manual_call: "Task to call the lead: {title}", manual_sms: "Task to text the lead: {title}", move_stage: "Move the lead to {stage}",
    mark_lost: "Mark the lead lost", update_field: "Set {field} to {value}", add_tag: "Add the tags {tags}", remove_tag: "Remove the tags {tags}", webhook: "Send data to {url}",
    update_custom_value: "Set the custom value {key} to {value}", add_note: "Add a note", internal_comment: "Add an internal comment", dnd: "Stop automatic messages ({channel})" }],
  [WF_LOGIC, { goto: "Go to {target}", add_to_workflow: "Add to the workflow {workflowId}", remove_from_workflow: "Remove from workflows ({scope})" }],
  [WF_GOALS, { tag_added: "Goal: the tags {tags} are added", tag_removed: "Goal: the tags {tags} are removed", stage_reached: "Goal: the lead reaches {stages}" }],
];
for (const [reg, map] of NARRATION) for (const [k, t] of Object.entries(map)) if (has(reg, k)) reg[k].narration = t;
export const WF_KINDS = ["action", "if_else", "wait", "goal", "split", "goto", "workflow"];
// The registry entry of a node (kind + type), or null.
export function nodeEntry(kind: unknown, type: unknown): WfNodeEntry | null {
  const k = String(kind ?? ""), t = String(type ?? "");
  const reg = k === "action" ? WF_ACTIONS : k === "wait" ? WF_WAITS : k === "goal" ? WF_GOALS : WF_LOGIC;
  return Object.prototype.hasOwnProperty.call(reg, t) && reg[t].kind === k ? reg[t] : null;
}
export const triggerEntry = (type: unknown): WfTriggerEntry | null => Object.prototype.hasOwnProperty.call(WF_TRIGGERS, String(type ?? "")) ? WF_TRIGGERS[String(type)] : null;
// A v1 / mirror key → the stored key (missedCall → call_details, push → internal_notification, …).
export function wfAliasOf(kind: "trigger" | "action", key: string): string {
  const reg: Record<string, WfEntry> = kind === "trigger" ? WF_TRIGGERS : WF_ACTIONS;
  if (Object.prototype.hasOwnProperty.call(reg, key)) return key;
  const hit = Object.values(reg).find((e) => (e.aliases || []).includes(key) || (kind === "trigger" && (e as WfTriggerEntry).mirror === key));
  return hit ? hit.key : key;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== CONDITIONS (stage 2): one condition = segments of rules (design §2.2). Gate rules (FIELDS gate, today only
// stage_unchanged) are pulled out and AND-ed in front, wherever they sit (the phase-4 evalConds rule). A segment is true
// when its rules joined by its match are; the condition when its segments joined by the outer match are ("all" when not
// set). An empty segment (a trigger with no filter) is true.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type CondDetail = { field: string; op: string; label: string; received: unknown; expected: unknown; ok: boolean };
export type CondEnv = { nowMs: number; tz: string; list?: (field: string) => unknown[] };
// deno-lint-ignore no-explicit-any
export const ruleExpected = (r: any): unknown => r.ref ? `{${r.ref}}` : r.v2 != null ? `${r.n}–${r.v2}` : r.unit ? `${r.n} ${r.unit}` : r.v !== undefined ? r.v : r.n !== undefined ? r.n : r.op;
// deno-lint-ignore no-explicit-any
const segRules = (s: any): any[] => (Array.isArray(obj(s).rules) ? obj(s).rules : []).map(obj);
export const isGateRule = (r: { field?: unknown }) => !!(WF_FIELDS[String(r.field)] && WF_FIELDS[String(r.field)].gate);
// valueOf(rule) = the record's value of rule.field (with the rule, for a field that takes a number). → { ok, failed, conds }.
// deno-lint-ignore no-explicit-any
export async function evalCondition(cond: any, valueOf: (rule: any) => unknown | Promise<unknown>, env: CondEnv): Promise<{ ok: boolean; failed: string | null; conds: CondDetail[] }> {
  const c = obj(cond), segs = (Array.isArray(c.segments) ? c.segments : []).map(obj), conds: CondDetail[] = [];
  // deno-lint-ignore no-explicit-any
  const one = async (r: any): Promise<boolean> => {
    const def = WF_FIELDS[r.field], dyn = isDynTriggerField(r.field), ops = def ? def.ops : dyn ? WF_OPS_BY_TYPE.text : [];
    let ok = false, received: unknown = null;
    if (ops.includes(r.op)) {
      received = await valueOf(r);
      const rule = r.ref ? { ...r, v: await valueOf({ field: r.ref }), n: await valueOf({ field: r.ref }) } : r;
      ok = applyOp(r.op, received, rule, env.list ? env.list(r.field) : [], env);
    }
    conds.push({ field: String(r.field), op: String(r.op), label: def ? def.label : String(r.field), received, expected: ruleExpected(r), ok });
    return ok;
  };
  const gates = segs.flatMap(segRules).filter(isGateRule);
  for (const g of gates) if (!(await one(g))) return { ok: false, failed: String(g.field), conds };
  // a segment that held only gates is gone (the gates above decided it); one that was empty from the start is true
  const rest = segs.map((s) => ({ any: s.match === "any", all: segRules(s), rules: segRules(s).filter((r) => !isGateRule(r)) })).filter((s) => !(s.all.length && !s.rules.length));
  if (!rest.length) return { ok: true, failed: null, conds };
  const outerAny = c.match === "any", fails: string[] = [];
  for (const s of rest) {
    let sOk = true, sFail: string | null = null;
    if (s.rules.length) {
      if (s.any) { const f: string[] = []; sOk = false; for (const r of s.rules) { if (await one(r)) { sOk = true; break; } f.push(String(r.field)); } if (!sOk) sFail = f.join(", "); }
      else for (const r of s.rules) if (!(await one(r))) { sOk = false; sFail = String(r.field); break; }
    }
    if (sOk && outerAny) return { ok: true, failed: null, conds };
    if (!sOk) { if (!outerAny) return { ok: false, failed: sFail, conds }; if (sFail) fails.push(sFail); }
  }
  return outerAny ? { ok: false, failed: fails.join(", ") || null, conds } : { ok: true, failed: null, conds };
}
// A field's value on the facts of a run (FIELDS registry; an inbound-webhook payload key from the trigger context).
// deno-lint-ignore no-explicit-any
export async function factValue(f: any, sb: any, rule: any): Promise<unknown> {
  const def = WF_FIELDS[rule && rule.field];
  if (def) return await def.value(f, sb, rule);
  if (isDynTriggerField(rule && rule.field)) { const v = obj(f && f.ctx)[String(rule.field).slice(8)]; return v === undefined ? null : v; }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== DOC (stage 2): ports, canonical JSON, shape and arm keys, per-workflow settings, upgradeV1, compile, patches
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const WF_LIMITS = { triggers: 10, maxStepsDefault: 100, maxStepsCeiling: 200, docBytes: 256 * 1024, name: 120, note: 2000, segments: 5, rules: 10 };
// catalog.automations.maxSteps, clamped 1..200 (default 100).
// deno-lint-ignore no-explicit-any
export function wfMaxSteps(cat: any): number {
  const v = obj(obj(cat).automations).maxSteps;
  if (v == null || v === "" || !Number.isFinite(Number(v))) return WF_LIMITS.maxStepsDefault;
  return Math.max(1, Math.min(WF_LIMITS.maxStepsCeiling, Math.trunc(Number(v))));
}
// The output ports of a node, in drawing order (design §2.2 table). An unknown kind keeps one "next" port.
// deno-lint-ignore no-explicit-any
export function wfPorts(node: any): string[] {
  const n = obj(node), c = obj(n.config);
  switch (n.kind) {
    case "if_else": return [...(Array.isArray(c.branches) ? c.branches.map((b: unknown) => String(obj(b).id)) : []), "none"];
    case "split": return Array.isArray(c.paths) ? c.paths.map((p: unknown) => String(obj(p).id)) : [];
    case "goto": return [];
    case "wait": return c.timeout != null && ["reply", "user_reply", "conditions"].includes(n.type) ? ["next", "timeout"] : ["next"];
    case "workflow": return n.type === "remove_from_workflow" && (c.scope === "current" || c.scope === "all") ? [] : ["next"];
  }
  return ["next"];
}
// deno-lint-ignore no-explicit-any
export function wfPortLabel(node: any, port: string): string {
  const n = obj(node), c = obj(n.config);
  if (n.kind === "if_else") return port === "none" ? String(c.noneName || "None") : String(obj((c.branches || []).find((b: unknown) => obj(b).id === port)).name || "Branch");
  if (n.kind === "split") { const p = obj((c.paths || []).find((x: unknown) => obj(x).id === port)); return `${p.name || "Path"} ${p.percent ?? 0}%`; }
  const e = nodeEntry(n.kind, n.type);
  return (e && e.portLabels && e.portLabels[port]) || "";
}
// JSON with object keys sorted at every level (arrays keep their order; undefined is left out): the one serialisation
// the shape key, the arm key, content hashes and the SQL jsonb compare share.
export function canonJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x === undefined ? null : x);
  if (Array.isArray(x)) return "[" + x.map((v) => canonJson(v === undefined ? null : v)).join(",") + "]";
  const o = x as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonJson(o[k])).join(",") + "}";
}
// The shape key (design §2.8): a change = version bump + waiting runs cancelled. Only what decides WHERE a run is: entry,
// and per node id, kind, type, out pairs in port order, branch / path id order, a wait's timeout port, goto target and a
// date / scheduled wait's go-to step ("if passed: go to"). Never names, notes, disabled, locked, messages, numbers, conditions, percents, layout, settings.
// deno-lint-ignore no-explicit-any
export function defShape(doc: any): string {
  const d = obj(doc), nodes = obj(d.nodes);
  const list = Object.keys(nodes).sort().map((id) => {
    const n = obj(nodes[id]), c = obj(n.config), out = obj(n.out);
    return [id, n.kind ?? null, n.type ?? null, wfPorts(n).map((p) => [p, out[p] ?? null]),
      n.kind === "if_else" && Array.isArray(c.branches) ? c.branches.map((b: unknown) => obj(b).id ?? null) : null,
      n.kind === "split" && Array.isArray(c.paths) ? c.paths.map((p: unknown) => obj(p).id ?? null) : null,
      n.kind === "wait" ? c.timeout != null : null, n.kind === "goto" ? (c.target ?? null) : null,
      n.kind === "wait" && (n.type === "date" || n.type === "scheduled") ? (c.gotoStep ?? null) : null];
  });
  return canonJson({ entry: d.entry ?? null, nodes: list });
}
// The arm key (§2.8): a change while Published = re-arm (armed_at := now, no cancel). The full triggers (id, type,
// filters, config, goto, disabled), entry, re-entry, time zone and the time window (only its "off" when off).
// deno-lint-ignore no-explicit-any
export function armKey(doc: any, settings: any): string {
  const d = obj(doc), s = normWfSettings(settings);
  const triggers = (Array.isArray(d.triggers) ? d.triggers : []).map((t: unknown) => {
    const x = obj(t);
    return { id: x.id ?? null, type: x.type ?? null, filters: x.filters ?? null, config: x.config ?? {}, goto: x.goto ?? null, disabled: x.disabled === true };
  });
  return canonJson({ triggers, entry: d.entry ?? null, reentry: s.reentry, timezone: s.timezone, window: s.window.on ? s.window : { on: false } });
}

// ── per-workflow settings (automations.settings, §2.6) ──
export const WF_SETTINGS_DEFAULTS = { reentry: "off", perRecord: true, stopOnResponse: false, timezone: "business",
  window: { on: false, days: [1, 2, 3, 4, 5], from: "08:00", until: "17:00" }, sender: { fromName: null as string | null }, markRead: false };
export type WfSettings = typeof WF_SETTINGS_DEFAULTS;
// The settings clamped to what the engine runs (pure; identical in the app). legacy_always is kept only when prev has it.
// deno-lint-ignore no-explicit-any
export function normWfSettings(raw: any, prev: any = raw): WfSettings {
  const r = obj(raw), p = obj(prev), D = WF_SETTINGS_DEFAULTS, w = obj(r.window);
  const days = Array.isArray(w.days) ? [...new Set(w.days.filter((x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6))].sort() as number[] : [];
  const from = hm(w.from), until = hm(w.until), hoursOk = from !== null && until !== null && from < until && from < 1440;
  const name = typeof obj(r.sender).fromName === "string" ? obj(r.sender).fromName.trim().slice(0, 60) : "";
  return {
    reentry: r.reentry === "off" || r.reentry === "after_exit" ? r.reentry : (r.reentry === "legacy_always" && p.reentry === "legacy_always") ? "legacy_always" : D.reentry,
    perRecord: typeof r.perRecord === "boolean" ? r.perRecord : D.perRecord,
    stopOnResponse: r.stopOnResponse === true,
    timezone: r.timezone === "contact" ? "contact" : "business",
    window: { on: w.on === true, days: days.length ? days : [...D.window.days], from: hoursOk ? String(w.from) : D.window.from, until: hoursOk ? String(w.until) : D.window.until },
    sender: { fromName: name || null },
    markRead: r.markRead === true,
  };
}
export type WfIssue = { code: string; severity: "error" | "warning"; path: string; nodeId?: string; triggerId?: string; text: string };
// What the owner must fix in the settings before they can be saved (availability included).
// deno-lint-ignore no-explicit-any
export function wfSettingsProblems(raw: any, prev: any, ctx: AvailCtx): WfIssue[] {
  const r = obj(raw), p = obj(prev), out: WfIssue[] = [], err = (code: string, path: string, text: string) => out.push({ code, severity: "error", path: "/settings" + path, text });
  if (r.reentry != null && !["off", "after_exit", "legacy_always"].includes(r.reentry)) err("E_SCHEMA", "/reentry", "Pick how leads can enter again");
  if (r.reentry === "legacy_always" && p.reentry !== "legacy_always") err("E_SCHEMA", "/reentry", "This re-entry option is only kept on upgraded workflows");
  if (r.timezone === "contact") err("E_UNAVAILABLE", "/timezone", WF_NOT_YET.contactTz);
  else if (r.timezone != null && r.timezone !== "business") err("E_SCHEMA", "/timezone", "Pick the time zone");
  const w = obj(r.window);
  if (w.on === true) {
    if (!Array.isArray(w.days) || !w.days.length || w.days.some((d: unknown) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) err("E_SCHEMA", "/window/days", "The time window has no allowed day");
    const f = hm(w.from), u = hm(w.until);
    if (f === null || u === null || f >= u || f >= 1440) err("E_SCHEMA", "/window/from", "The time window's hours are not valid");
  }
  if (obj(r.sender).fromName != null && (typeof obj(r.sender).fromName !== "string" || obj(r.sender).fromName.length > 60)) err("E_SCHEMA", "/sender/fromName", "The sender name is at most 60 characters");
  void ctx;
  return out;
}

// ── upgradeV1: a phase-4 row (trigger + steps) → the same workflow as a doc (§2.2, §3.16). Ids are kept (in-flight runs
// and log rows point at them); an id that is not a valid v2 id gets a fresh one (idMap). Every phase-4 shape maps 1:1:
// wait → period; window → recurring/window (outside "skip" → "end"); if → If / else with gate (an empty None ends the
// run "skipped" as phase 4 did); push/task/email/text → internal_notification/add_task/send_email/send_sms. Settings =
// exact phase-4 behaviour (re-entry legacy_always, one run per record). Pure; the input is never changed. ──
export const WF_MIGRATED_SETTINGS = { reentry: "legacy_always", perRecord: true, stopOnResponse: false, timezone: "business", window: { on: false }, sender: { fromName: null }, markRead: false };
const V1_ACTIONS: Record<string, string> = { push: "internal_notification", task: "add_task", email: "send_email", text: "send_sms" };
// deno-lint-ignore no-explicit-any
const jclone = <T>(x: T): T => x === undefined ? x : JSON.parse(JSON.stringify(x));
// deno-lint-ignore no-explicit-any
export function upgradeV1(trigger: any, steps: any): { doc: any; settings: any; idMap: Record<string, string> } {
  const t = obj(trigger), list = (Array.isArray(steps) ? steps : []).map(obj), idMap: Record<string, string> = {};
  const used = new Set<string>(), keep: string[] = [];
  list.forEach((s) => { const id = String(s.id ?? ""); if (WF_ID_RE.test(id) && !used.has(id)) { used.add(id); keep.push(id); } else keep.push(""); });
  const suffix = (id: string) => { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : 0; };
  let seq = Math.max(list.length, ...keep.map(suffix), 0);
  const fresh = (prefix: string) => { let id = ""; do { seq++; id = `${prefix}${seq}`; } while (used.has(id)); used.add(id); return id; };
  const ids = keep.map((id, i) => { if (id) return id; const n = fresh("s"); if (list[i].id != null) idMap[String(list[i].id)] = n; return n; });
  const tid = used.has("t1") ? fresh("t") : (used.add("t1"), "t1");
  const type = wfAliasOf("trigger", String(t.type ?? "")), te = triggerEntry(type), params = obj(t.params);
  const rules: unknown[] = [], tcfg: Record<string, unknown> = {};
  if (t.type === "stage" && typeof params.stage === "string" && params.stage !== "") rules.push({ field: "trigger.stage", op: "is", v: params.stage });
  // the missed-call scanner (phase 4, reused) carries no call_status in the event: the filter reads the call record
  if (t.type === "missedCall") rules.push({ field: "call.status", op: "is", v: "missed" });
  if (t.type === "jobClosed" && params.maxJobAgeDays != null) tcfg.maxJobAgeDays = params.maxJobAgeDays;
  const trig: Record<string, unknown> = { id: tid, type, name: te ? (te.ghl || te.label) : String(t.type ?? ""), filters: { match: "all", segments: [{ match: "all", rules }] } };
  if (Object.keys(tcfg).length) trig.config = tcfg;
  // deno-lint-ignore no-explicit-any
  const nodes: Record<string, any> = {};
  list.forEach((s, i) => {
    const id = ids[i], next = i + 1 < ids.length ? ids[i + 1] : null;
    // deno-lint-ignore no-explicit-any
    const rest: any = jclone(s); delete rest.id; delete rest.kind; delete rest.type; const locked = rest.lock === true; delete rest.lock;
    // deno-lint-ignore no-explicit-any
    let n: any;
    if (s.kind === "wait") n = { kind: "wait", type: "period", config: rest, out: { next } };
    else if (s.kind === "window") {
      const w: Record<string, unknown> = { use: s.mode === "office" || s.mode === "outsideOffice" ? s.mode : "custom" };
      if (w.use === "custom") { w.days = jclone(s.days); w.from = s.from; w.until = s.until; }
      w.outside = s.outside === "skip" ? "end" : s.outside; if (s.at !== undefined) w.at = s.at;
      n = { kind: "wait", type: "recurring", config: { mode: "window", window: w }, out: { next } };
    } else if (s.kind === "if") {
      let bid = `${id}_yes`; if (!WF_ID_RE.test(bid) || used.has(bid)) bid = fresh("b"); else used.add(bid);
      n = { kind: "if_else", type: "if_else", config: { gate: true, noneName: "None",
        branches: [{ id: bid, name: "Yes", when: { match: "any", segments: [{ match: s.match === "any" ? "any" : "all", rules: jclone(Array.isArray(s.conds) ? s.conds : []) }] } }] },
        out: { [bid]: next, none: null } };
    } else if (s.kind === "action") {
      const at = V1_ACTIONS[String(s.type)] || String(s.type ?? "");
      n = { kind: "action", type: at, config: at === "internal_notification" ? { channel: "push", ...rest } : rest, out: { next } };
    } else n = { kind: String(s.kind ?? ""), type: String(s.type ?? s.kind ?? ""), config: rest, out: { next } };
    if (locked) n.locked = true;
    nodes[id] = n;
  });
  return { doc: { schema: 2, seq, entry: ids.length ? ids[0] : null, triggers: [trig], nodes }, settings: jclone(WF_MIGRATED_SETTINGS), idMap };
}

// ── node references hidden in config (x-ref "node" in the registry schema: goto.target, date.gotoStep) ──
// deno-lint-ignore no-explicit-any
export function nodeRefs(node: any): { key: string; to: string | null }[] {
  const n = obj(node), e = nodeEntry(n.kind, n.type), c = obj(n.config), out: { key: string; to: string | null }[] = [];
  if (!e) return out;
  for (const [k, s] of Object.entries(obj(e.fields.properties))) if (obj(s)["x-ref"] === "node" && has(c, k)) out.push({ key: k, to: typeof c[k] === "string" ? c[k] : null });
  return out;
}
// The index the executor and the validators use (design §3.4): parents, children in port order, refs, heads, the first
// node of a trigger, reachability (with or without go-to refs), the goals downstream of a node and which triggers can
// reach each node. Never throws on a broken doc (it indexes what is there).
// deno-lint-ignore no-explicit-any
export function compile(doc: any) {
  const d = obj(doc), nodes = nul(obj(d.nodes)) as Record<string, any>, ids = Object.keys(nodes);
  const parent: Record<string, { from: string; port: string }> = nul({}), kids: Record<string, string[]> = nul({});
  for (const id of ids) {
    const out = obj(obj(nodes[id]).out); kids[id] = [];
    for (const p of wfPorts(nodes[id])) { const t = out[p]; if (typeof t === "string" && has(nodes, t) && !parent[t] && t !== id) { parent[t] = { from: id, port: p }; kids[id].push(t); } }
  }
  const refs: { from: string; key: string; to: string }[] = [];
  for (const id of ids) for (const r of nodeRefs(nodes[id])) if (r.to && has(nodes, r.to)) refs.push({ from: id, key: r.key, to: r.to });
  const heads = ids.filter((id) => !parent[id]);
  const triggers = (Array.isArray(d.triggers) ? d.triggers : []).map(obj);
  const entry = typeof d.entry === "string" && has(nodes, d.entry) ? d.entry : null;
  const first = (triggerId?: string | null): string | null => {
    const t = triggers.find((x) => x.id === triggerId);
    return t && typeof t.goto === "string" && has(nodes, t.goto) ? t.goto : entry;
  };
  const reach = (starts: (string | null)[], viaRefs: boolean): Set<string> => {
    const seen = new Set<string>(), todo = starts.filter((s): s is string => !!s && has(nodes, s));
    while (todo.length) {
      const id = todo.pop() as string; if (seen.has(id)) continue; seen.add(id);
      todo.push(...kids[id]);
      if (viaRefs) for (const r of refs) if (r.from === id) todo.push(r.to);
    }
    return seen;
  };
  // goals after id along out edges (not through go-to), in reading order (port order, depth first)
  const downstreamGoals = (id: string): string[] => {
    const out: string[] = [], seen = new Set<string>([id]);
    const walk = (x: string) => { for (const k of kids[x] || []) { if (seen.has(k)) continue; seen.add(k); if (obj(nodes[k]).kind === "goal") out.push(k); walk(k); } };
    walk(id); return out;
  };
  const ancestors = (id: string): string[] => { const out: string[] = []; let x = parent[id]; const seen = new Set<string>(); while (x && !seen.has(x.from)) { seen.add(x.from); out.push(x.from); x = parent[x.from]; } return out; };
  const enabled = triggers.filter((t) => t.disabled !== true && typeof t.id === "string");
  const reachingTriggers: Record<string, string[]> = nul({});
  for (const id of ids) reachingTriggers[id] = [];
  for (const t of enabled) for (const id of reach([first(t.id)], true)) reachingTriggers[id].push(t.id);
  // a node no trigger reaches (a delinked cluster) is checked against every trigger, as in Standard
  for (const id of ids) if (!reachingTriggers[id].length) reachingTriggers[id] = enabled.map((t) => t.id);
  return { nodes, ids, parent, kids, refs, heads, entry, triggers, first, reach, downstreamGoals, ancestors, reachingTriggers };
}
export type Compiled = ReturnType<typeof compile>;

// ── wfApplyPatch: the edit contract (design §6.3; the app has the same function, shared fixtures). Atomic: any error →
// the doc unchanged + errors with opIndex. New ids are minted from seq (t/n/b/p + seq); ids the caller supplies (temp
// "$1" or any other) are always remapped, and later ops may use them (idMap). Slots: { src: "@entry" } = the trunk,
// { src: nodeId, port? } = below that node on that port (default its first port), null = a new unconnected head. ──
// deno-lint-ignore no-explicit-any
export function wfApplyPatch(doc: any, ops: any[], extra: { settings?: any; name?: string } = {}): { doc: any; settings: any; name: any; errors: { code: string; path: string; opIndex: number; text: string }[]; idMap: Record<string, string> } {
  const d = jclone(obj(doc));
  d.schema = 2; d.seq = Number.isInteger(d.seq) && d.seq >= 0 ? d.seq : 0; d.nodes = nul(obj(d.nodes)); d.triggers = Array.isArray(d.triggers) ? d.triggers : []; if (d.entry === undefined) d.entry = null;
  let settings = jclone(extra.settings ?? null), name = extra.name ?? null;
  const idMap: Record<string, string> = nul({}), errors: { code: string; path: string; opIndex: number; text: string }[] = [];
  const R = (id: unknown) => has(idMap, id) ? idMap[id as string] : id as string;
  const allIds = () => { const s = new Set<string>(Object.keys(d.nodes)); for (const t of d.triggers) s.add(String(obj(t).id)); for (const n of Object.values(d.nodes)) { const c = obj(obj(n).config); for (const b of [...(Array.isArray(c.branches) ? c.branches : []), ...(Array.isArray(c.paths) ? c.paths : [])]) s.add(String(obj(b).id)); } return s; };
  const mint = (prefix: string, supplied?: unknown) => { const taken = allIds(); let id = ""; do { d.seq++; id = `${prefix}${d.seq}`; } while (taken.has(id)); if (typeof supplied === "string" && supplied) idMap[supplied] = id; return id; };
  const parentOf = (id: string): { from: string; port: string } | null => { for (const [pid, n] of Object.entries(d.nodes)) for (const p of wfPorts(n)) if (obj(obj(n).out)[p] === id) return { from: pid, port: p }; return null; };
  const subtree = (id: string): string[] => { const out: string[] = [], todo = [id]; while (todo.length) { const x = todo.pop() as string; if (out.includes(x) || !d.nodes[x]) continue; out.push(x); for (const p of wfPorts(d.nodes[x])) { const t = d.nodes[x].out[p]; if (typeof t === "string") todo.push(t); } } return out; };
  const lockedRules = (cond: unknown): string[] => (Array.isArray(obj(cond).segments) ? obj(cond).segments : []).flatMap(segRules).filter((r: any) => r.lock === true).map(canonJson);
  // deno-lint-ignore no-explicit-any
  const nodeLocks = (n: any): string[] => { const c = obj(obj(n).config); return [...(Array.isArray(c.branches) ? c.branches.flatMap((b: unknown) => lockedRules(obj(b).when)) : []), ...lockedRules(c.when)]; };
  const keepsLocks = (before: string[], after: string[]) => before.every((r) => after.includes(r));
  const dropNodes = (gone: string[]) => {
    for (const x of gone) delete d.nodes[x];
    for (const n of Object.values(d.nodes)) { const c = obj(obj(n).config); for (const r of nodeRefs(n)) if (r.to && gone.includes(r.to)) c[r.key] = null; for (const p of wfPorts(n)) if (gone.includes((n as any).out[p])) (n as any).out[p] = null; }
    for (const t of d.triggers) if (gone.includes(obj(t).goto)) t.goto = null;
    if (gone.includes(d.entry)) d.entry = null;
  };
  // fresh ids for branches / paths, refs through idMap, out reconciled to the ports
  // deno-lint-ignore no-explicit-any
  const prepConfig = (kind: string, cfg: any, keepIds: Set<string>) => {
    const c = jclone(obj(cfg));
    for (const [list, prefix] of [["branches", "b"], ["paths", "p"]] as const) if (Array.isArray(c[list])) c[list] = c[list].map((x: unknown) => { const b = { ...obj(x) }; b.id = keepIds.has(String(b.id)) ? b.id : mint(prefix, b.id); return b; });
    if (kind === "goto" && c.target != null) c.target = R(c.target);
    if (c.gotoStep != null) c.gotoStep = R(c.gotoStep);
    return c;
  };
  // deno-lint-ignore no-explicit-any
  const slotOf = (slot: any): { get: () => string | null; set: (v: string | null) => void; src: string } | null | "bad" => {
    if (slot == null) return null;
    const s = obj(slot);
    if (s.src === "@entry") return { src: "@entry", get: () => d.entry ?? null, set: (v) => { d.entry = v; } };
    const src = R(s.src), n = d.nodes[src]; if (!n) return "bad";
    const ports = wfPorts(n), port = s.port == null ? ports[0] : R(s.port);
    if (!ports.includes(port)) return "bad";
    return { src, get: () => n.out[port] ?? null, set: (v) => { n.out[port] = v; } };
  };
  for (let i = 0; i < (Array.isArray(ops) ? ops.length : 0) && !errors.length; i++) {
    const op = obj(ops[i]), fail = (code: string, text: string, path = "") => errors.push({ code, path: `/${i}${path}`, opIndex: i, text });
    try {
      if (op.op === "addTrigger") {
        const t = obj(op.trigger); if (!triggerEntry(t.type)) { fail("E_UNKNOWN_TYPE", "Unknown trigger", "/trigger/type"); break; }
        const nt: Record<string, unknown> = { ...jclone(t), id: mint("t", t.id), filters: t.filters ? jclone(t.filters) : { match: "all", segments: [{ match: "all", rules: [] }] } };
        if (t.goto != null) nt.goto = R(t.goto);
        d.triggers.push(nt);
      } else if (op.op === "setTrigger" || op.op === "removeTrigger") {
        const k = d.triggers.findIndex((t: unknown) => obj(t).id === R(op.id)); if (k < 0) { fail("E_PATCH_ID", "No such trigger", "/id"); break; }
        if (op.op === "removeTrigger") { if (lockedRules(d.triggers[k].filters).length) { fail("E_LOCKED", "This trigger has locked filters"); break; } d.triggers.splice(k, 1); continue; }
        const p = obj(op.patch), old = d.triggers[k], nt = { ...old };
        for (const key of ["name", "type", "filters", "config", "goto", "disabled"]) if (key in p) nt[key] = jclone(p[key]);
        if ("type" in p && !triggerEntry(nt.type)) { fail("E_UNKNOWN_TYPE", "Unknown trigger", "/patch/type"); break; }
        if ("type" in p && p.type !== old.type && !("config" in p)) delete nt.config;
        if (nt.goto != null) nt.goto = R(nt.goto);
        if (!keepsLocks(lockedRules(old.filters), lockedRules(nt.filters))) { fail("E_LOCKED", "A locked filter can't be changed", "/patch/filters"); break; }
        d.triggers[k] = nt;
      } else if (op.op === "addNode") {
        const nn = obj(op.node);
        if (!nodeEntry(nn.kind, nn.type)) { fail("E_UNKNOWN_TYPE", "Unknown step", "/node"); break; }
        const slot = slotOf(op.slot); if (slot === "bad") { fail("E_SLOT", "That place doesn't exist", "/slot"); break; }
        const id = mint("n", nn.id);
        const node: Record<string, any> = { kind: nn.kind, type: nn.type, config: prepConfig(nn.kind, nn.config, new Set()), out: {} };
        for (const k of ["name", "note", "disabled"]) if (nn[k] !== undefined) node[k] = nn[k];
        const ports = wfPorts(node); for (const p of ports) node.out[p] = null;
        if (slot) {
          const below = slot.get();
          if (!ports.length && below) { fail("E_GOTO_NOT_LAST", "A step that ends the path can only be the last step", "/slot"); break; }
          if (ports.length) node.out[ports[0]] = below;
          d.nodes[id] = node; slot.set(id);
        } else d.nodes[id] = node;
      } else if (op.op === "setNode") {
        const id = R(op.id), old = d.nodes[id]; if (!old) { fail("E_PATCH_ID", "No such step", "/id"); break; }
        if (old.locked) { fail("E_LOCKED", "This step is locked"); break; }
        const p = obj(op.patch), n = { ...old };
        for (const k of ["name", "note", "disabled"]) if (k in p) { if (p[k] == null) delete n[k]; else n[k] = p[k]; }
        if ("type" in p && p.type !== old.type) { if (!nodeEntry(old.kind, p.type)) { fail("E_UNKNOWN_TYPE", "Unknown step", "/patch/type"); break; } n.type = p.type; n.config = {}; }
        const keep = new Set<string>([...wfPorts(old)]);
        if ("config" in p) n.config = prepConfig(n.kind, { ...(n.type === old.type ? obj(old.config) : {}), ...obj(p.config) }, keep);
        if (!keepsLocks(nodeLocks(old), nodeLocks(n))) { fail("E_LOCKED", "A locked condition can't be changed", "/patch/config"); break; }
        const ports = wfPorts(n), out: Record<string, string | null> = {}, lost: string[] = [];
        for (const q of ports) out[q] = obj(old.out)[q] ?? null;
        for (const q of wfPorts(old)) if (!ports.includes(q) && obj(old.out)[q]) lost.push(obj(old.out)[q]);
        if (n.disabled === true && ports.length > 1) { fail("E_DISABLED_BRANCHING", "A step with branches can't be paused", "/patch/disabled"); break; }
        if (lost.length && !op.dropPorts) { fail("E_PORT_HAS_STEPS", "A removed branch still has steps", "/patch"); break; }
        n.out = out; d.nodes[id] = n;
        if (lost.length) { const gone = lost.flatMap(subtree); if (gone.some((x) => d.nodes[x] && d.nodes[x].locked)) { fail("E_LOCKED", "A locked step is in a removed branch"); break; } dropNodes(gone); }
      } else if (op.op === "removeNode") {
        const id = R(op.id), n = d.nodes[id]; if (!n) { fail("E_PATCH_ID", "No such step", "/id"); break; }
        const ports = wfPorts(n), mode = op.mode === "fromHere" ? "fromHere" : "one";
        let child: string | null = null, gone: string[];
        if (mode === "fromHere") gone = subtree(id);
        else {
          if (ports.length > 1 && !ports.includes(R(op.keepPort))) { fail("E_KEEP_PORT", "Pick the path to keep", "/keepPort"); break; }
          const kp = ports.length > 1 ? R(op.keepPort) : ports[0];
          child = kp ? (n.out[kp] ?? null) : null;
          gone = [id, ...ports.filter((q) => q !== kp && n.out[q]).flatMap((q) => subtree(n.out[q]))];
        }
        if (gone.some((x) => d.nodes[x] && d.nodes[x].locked)) { fail("E_LOCKED", "A locked step can't be removed"); break; }
        const par = parentOf(id), wasEntry = d.entry === id;
        if (child) n.out = {};   // keep the kept child out of the deletion
        dropNodes(gone);
        if (par && d.nodes[par.from]) d.nodes[par.from].out[par.port] = child;
        if (wasEntry) d.entry = child;
      } else if (op.op === "moveNode") {
        const id = R(op.id), n = d.nodes[id]; if (!n) { fail("E_PATCH_ID", "No such step", "/id"); break; }
        if (n.locked) { fail("E_LOCKED", "A locked step can't be moved"); break; }
        const ports = wfPorts(n), whole = op.mode === "fromHere" || ports.length > 1, moving = whole ? subtree(id) : [id];
        const s = obj(op.slot); if (s.src !== "@entry" && moving.includes(R(s.src))) { fail("E_SLOT", "A step can't move into its own path", "/slot"); break; }
        // detach
        const par = parentOf(id), wasEntry = d.entry === id, child = whole ? null : (ports.length ? n.out[ports[0]] ?? null : null);
        if (par) d.nodes[par.from].out[par.port] = child; if (wasEntry) d.entry = child;
        if (!whole && ports.length) n.out[ports[0]] = null;
        const slot = slotOf(op.slot); if (slot === "bad" || slot === null) { fail("E_SLOT", "That place doesn't exist", "/slot"); break; }
        const below = slot.get();
        if (below) {
          // the steps below the slot go under the moved block's last step (a straight block only)
          let tail = id; const seen = new Set<string>();
          while (!seen.has(tail)) { seen.add(tail); const tp = wfPorts(d.nodes[tail]); if (tp.length !== 1) { tail = ""; break; } const nx = d.nodes[tail].out[tp[0]]; if (!nx) break; tail = nx; }
          if (!tail) { fail("E_SLOT", "Move it to the end of a path", "/slot"); break; }
          d.nodes[tail].out[wfPorts(d.nodes[tail])[0]] = below;
        }
        slot.set(id);
      } else if (op.op === "connect") {
        const from = R(op.from), to = R(op.to), n = d.nodes[from];
        if (!n || !d.nodes[to]) { fail("E_PATCH_ID", "No such step", n ? "/to" : "/from"); break; }
        const port = op.port == null ? wfPorts(n)[0] : R(op.port); if (!wfPorts(n).includes(port)) { fail("E_SLOT", "No such path", "/port"); break; }
        const anc: string[] = []; for (let x = parentOf(from); x; x = parentOf(x.from)) { if (anc.includes(x.from)) break; anc.push(x.from); }
        if (to === from || anc.includes(to)) { fail("E_CONNECT_LOOP", "Loops are made with a Go to step", "/to"); break; }
        if (d.entry === to) { fail("E_ENTRY_NOT_HEAD", "The first step can't have a step above it", "/to"); break; }
        const old = parentOf(to); if (old) d.nodes[old.from].out[old.port] = null;
        n.out[port] = to;
      } else if (op.op === "disconnect") {
        const from = R(op.from), n = d.nodes[from]; if (!n) { fail("E_PATCH_ID", "No such step", "/from"); break; }
        const port = op.port == null ? wfPorts(n)[0] : R(op.port); if (!wfPorts(n).includes(port)) { fail("E_SLOT", "No such path", "/port"); break; }
        n.out[port] = null;
      } else if (op.op === "setEntry") {
        const id = op.id == null ? null : R(op.id);
        if (id !== null && (!d.nodes[id] || parentOf(id))) { fail("E_ENTRY_NOT_HEAD", "Only a step with nothing above it can be first", "/id"); break; }
        d.entry = id;
      } else if (op.op === "setSettings") settings = { ...obj(settings), ...jclone(obj(op.patch)) };
      else if (op.op === "rename") { if (typeof op.name !== "string" || !op.name.trim() || op.name.length > WF_LIMITS.name) { fail("E_SCHEMA", "The name is 1 to 120 characters", "/name"); break; } name = op.name.trim(); }
      else fail("E_SCHEMA", `Unknown edit "${String(op.op ?? "")}"`, "/op");
    } catch { fail("E_SCHEMA", "The workflow is broken here: check it first"); }   // a malformed doc never throws out of a patch
  }
  if (errors.length) return { doc, settings: extra.settings ?? null, name: extra.name ?? null, errors, idMap: {} };
  return { doc: { ...d, nodes: { ...d.nodes } }, settings, name, errors, idMap: { ...idMap } };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== VALIDATE (stage 2, design §6.2). Codes are stable strings; one implementation of each check.
//   validateStructure  fatal at run time (a run of a doc with these fails)
//   validateAvailability  blocks Publish and AI output; at run time the step only skips
//   validateSemantic   errors block Publish / a Published save; warnings never block
// Issue = { code, severity, path (JSON pointer), nodeId?, triggerId?, text }.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ── schemaCheck: the JSON-Schema subset the registry uses (type, const, enum, properties, required,
// additionalProperties, propertyNames, min/maxProperties, items, min/maxItems, uniqueItems, min/maxLength, pattern,
// minimum, maximum, allOf, oneOf, anyOf, $ref to "#/..." in root). x-* keywords are ignored here. → [{ path, text }] ──
const typeOk = (t: string, v: unknown) => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v)
  : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t;
const RE_CACHE = new Map<string, RegExp>();
// deno-lint-ignore no-explicit-any
export function schemaCheck(schema: JSchema, value: unknown, root: JSchema = schema, path = "", out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  let s = schema;
  for (let hops = 0; s && typeof s.$ref === "string" && hops < 20; hops++) {
    // deno-lint-ignore no-explicit-any
    s = s.$ref.replace(/^#\/?/, "").split("/").filter(Boolean).reduce((a: any, k: string) => a && a[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  if (!s || typeof s !== "object") return out;
  const err = (p: string, text: string) => { out.push({ path: p, text }); };
  if (s.type) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.some((t: string) => typeOk(t, value))) { err(path, `must be ${ts.join(" or ")}`); return out; } }
  if ("const" in s && canonJson(value) !== canonJson(s.const)) err(path, `must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => canonJson(e) === canonJson(value))) err(path, "is not one of the allowed values");
  if (typeof value === "string") {
    if (s.minLength != null && value.length < s.minLength) err(path, s.minLength === 1 ? "must not be empty" : `must be at least ${s.minLength} characters`);
    if (s.maxLength != null && value.length > s.maxLength) err(path, `must be at most ${s.maxLength} characters`);
    if (s.pattern) { let re = RE_CACHE.get(s.pattern); if (!re) { re = new RegExp(s.pattern); RE_CACHE.set(s.pattern, re); } if (!re.test(value)) err(path, "is not in the right format"); }
  }
  if (typeof value === "number") {
    if (s.minimum != null && value < s.minimum) err(path, `must be at least ${s.minimum}`);
    if (s.maximum != null && value > s.maximum) err(path, `must be at most ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems != null && value.length < s.minItems) err(path, `needs at least ${s.minItems}`);
    if (s.maxItems != null && value.length > s.maxItems) err(path, `takes at most ${s.maxItems}`);
    if (s.uniqueItems && new Set(value.map(canonJson)).size !== value.length) err(path, "has the same value twice");
    if (s.items) value.forEach((v, i) => schemaCheck(s.items, v, root, `${path}/${i}`, out));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>, keys = Object.keys(o), props = obj(s.properties);
    for (const k of Array.isArray(s.required) ? s.required : []) if (!has(o, k)) err(`${path}/${k}`, "is missing");
    if (s.minProperties != null && keys.length < s.minProperties) err(path, `needs at least ${s.minProperties} entries`);
    if (s.maxProperties != null && keys.length > s.maxProperties) err(path, `takes at most ${s.maxProperties} entries`);
    for (const k of keys) {
      if (s.propertyNames) { const before = out.length; schemaCheck(s.propertyNames, k, root, `${path}/${k}`, out); if (out.length > before) continue; }
      if (has(props, k)) schemaCheck(props[k], o[k], root, `${path}/${k}`, out);
      else if (s.additionalProperties === false) err(`${path}/${k}`, "is not allowed here");
      else if (s.additionalProperties && typeof s.additionalProperties === "object") schemaCheck(s.additionalProperties, o[k], root, `${path}/${k}`, out);
    }
  }
  if (Array.isArray(s.allOf)) for (const b of s.allOf) schemaCheck(b, value, root, path, out);
  if (Array.isArray(s.anyOf) && !s.anyOf.some((b: JSchema) => !schemaCheck(b, value, root, path).length))
    err(path, Array.isArray(s["x-requireOne"]) ? `needs one of ${s["x-requireOne"].join(", ")}` : "matches none of the allowed shapes");
  if (Array.isArray(s.oneOf)) {
    const results = s.oneOf.map((b: JSchema) => schemaCheck(b, value, root, path));
    const passing = results.filter((r: unknown[]) => !r.length).length;
    if (passing > 1) err(path, "matches more than one shape");
    else if (passing === 0) {
      // the branch whose const keys (kind/type/op/mode) match says what is wrong; else one plain error
      const v = obj(value), fit = s.oneOf.map((b: JSchema, i: number) => [b, i] as [JSchema, number]).filter(([b]) => {
        let x = b; for (let h = 0; x && x.$ref && h < 20; h++) x = x.$ref.replace(/^#\/?/, "").split("/").filter(Boolean).reduce((a: any, k: string) => a && a[k], root);
        const consts = Object.entries(obj(obj(x).properties)).filter(([, p]) => p && typeof p === "object" && "const" in (p as JSchema));
        return consts.length > 0 && consts.every(([k, p]) => canonJson(v[k]) === canonJson((p as JSchema).const));
      });
      if (fit.length === 1) out.push(...results[fit[0][1]]); else err(path, "matches none of the allowed shapes");
    }
  }
  return out;
}

// The loose condition schemas used by the structure check (rule ARGUMENTS are the semantic check's rule_value_* codes).
const LOOSE_RULE: JSchema = { type: "object", properties: { field: sc.req(80), op: sc.req(40) }, required: ["field", "op"] };
const condSchema = (rule: JSchema, minRules: number): JSchema =>
  sc.obj({ match: sc.en(["any", "all"]), segments: sc.arr(sc.obj({ match: sc.en(["all", "any"]), rules: sc.arr(rule, minRules, WF_LIMITS.rules) }, ["match", "rules"]), 1, WF_LIMITS.segments) }, ["match", "segments"]);
const LOOSE_DEFS: JSchema = { $defs: { condition: condSchema(LOOSE_RULE, 1), filters: condSchema(LOOSE_RULE, 0) } };

// deno-lint-ignore no-explicit-any
const issue = (code: string, path: string, text: string, x: { nodeId?: string; triggerId?: string; severity?: "error" | "warning" } = {}): WfIssue =>
  ({ code, severity: x.severity || (code.startsWith("W_") ? "warning" : "error"), path, text, ...(x.nodeId ? { nodeId: x.nodeId } : {}), ...(x.triggerId ? { triggerId: x.triggerId } : {}) });
const esc = (k: string) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
// every condition in a doc: trigger filters, If / else branches, "Until specific conditions are met"
// deno-lint-ignore no-explicit-any
function conditionsOf(doc: any): { cond: any; path: string; nodeId?: string; triggerId?: string }[] {
  const d = obj(doc), out: { cond: unknown; path: string; nodeId?: string; triggerId?: string }[] = [];
  (Array.isArray(d.triggers) ? d.triggers : []).forEach((t: unknown, i: number) => { const x = obj(t); out.push({ cond: x.filters, path: `/triggers/${i}/filters`, triggerId: String(x.id ?? "") }); });
  for (const [id, n] of Object.entries(obj(d.nodes))) {
    const c = obj(obj(n).config);
    if (obj(n).kind === "if_else" && Array.isArray(c.branches)) c.branches.forEach((b: unknown, k: number) => out.push({ cond: obj(b).when, path: `/nodes/${esc(id)}/config/branches/${k}/when`, nodeId: id }));
    if (obj(n).kind === "wait" && obj(n).type === "conditions") out.push({ cond: c.when, path: `/nodes/${esc(id)}/config/when`, nodeId: id });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export function validateStructure(doc: any, opts: { maxSteps?: number; stored?: any } = {}): WfIssue[] {
  const out: WfIssue[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [issue("E_SCHEMA", "", "The workflow is not an object")];
  const d = doc;
  if (d.schema !== 2) out.push(issue("E_SCHEMA", "/schema", "schema must be 2"));
  if (!Number.isInteger(d.seq) || d.seq < 0) out.push(issue("E_SCHEMA", "/seq", "seq must be a whole number"));
  if (!(d.entry === null || typeof d.entry === "string")) out.push(issue("E_SCHEMA", "/entry", "entry must be a step id or null"));
  if (!Array.isArray(d.triggers)) out.push(issue("E_SCHEMA", "/triggers", "triggers must be a list"));
  if (!d.nodes || typeof d.nodes !== "object" || Array.isArray(d.nodes)) out.push(issue("E_SCHEMA", "/nodes", "nodes must be an object"));
  if (!Array.isArray(d.triggers) || !d.nodes || typeof d.nodes !== "object" || Array.isArray(d.nodes)) return out;
  for (const k of Object.keys(d)) if (!["schema", "seq", "entry", "triggers", "nodes"].includes(k)) out.push(issue("E_SCHEMA", `/${esc(k)}`, "is not allowed here"));
  if (new TextEncoder().encode(canonJson(d)).length > WF_LIMITS.docBytes) out.push(issue("E_TOO_BIG", "", "The workflow is larger than 256 KB"));
  const nodes = nul(d.nodes) as Record<string, any>, ids = Object.keys(nodes);
  const max = opts.maxSteps ?? WF_LIMITS.maxStepsDefault;
  if (ids.length > max) out.push(issue("E_MAX_NODES", "/nodes", `At most ${max} steps`));
  if (d.triggers.length > WF_LIMITS.triggers) out.push(issue("E_SCHEMA", "/triggers", `At most ${WF_LIMITS.triggers} triggers`));
  const seen = new Map<string, string>();
  const claim = (id: unknown, path: string, x: { nodeId?: string; triggerId?: string }) => {
    if (typeof id !== "string" || !WF_ID_RE.test(id)) { out.push(issue("E_BAD_ID", path, `"${String(id)}" is not a valid id`, x)); return; }
    if (seen.has(id)) out.push(issue("E_DUP_ID", path, `The id "${id}" is used twice`, x)); else seen.set(id, path);
  };
  d.triggers.forEach((t: unknown, i: number) => {
    const p = `/triggers/${i}`;
    if (!t || typeof t !== "object" || Array.isArray(t)) { out.push(issue("E_SCHEMA", p, "A trigger must be an object")); return; }
    const x = t as Record<string, any>, tid = typeof x.id === "string" ? x.id : undefined;
    claim(x.id, `${p}/id`, { triggerId: tid });
    const te = triggerEntry(x.type);
    if (!te) { out.push(issue("E_UNKNOWN_TYPE", `${p}/type`, `Unknown trigger "${String(x.type ?? "")}"`, { triggerId: tid })); return; }
    for (const k of Object.keys(x)) if (!["id", "type", "name", "disabled", "filters", "config", "goto"].includes(k)) out.push(issue("E_SCHEMA", `${p}/${esc(k)}`, "is not allowed here", { triggerId: tid }));
    if (x.name != null && !(typeof x.name === "string" && x.name.length <= WF_LIMITS.name)) out.push(issue("E_SCHEMA", `${p}/name`, "The name is at most 120 characters", { triggerId: tid }));
    if (x.disabled != null && typeof x.disabled !== "boolean") out.push(issue("E_SCHEMA", `${p}/disabled`, "must be true or false", { triggerId: tid }));
    for (const e of schemaCheck(LOOSE_DEFS.$defs.filters, x.filters, LOOSE_DEFS, `${p}/filters`)) out.push(issue("E_SCHEMA", e.path, e.text, { triggerId: tid }));
    for (const e of schemaCheck(te.fields, x.config ?? {}, LOOSE_DEFS, `${p}/config`)) out.push(issue("E_SCHEMA", e.path, e.text, { triggerId: tid }));
    if (x.goto != null && !(typeof x.goto === "string" && has(nodes, x.goto))) out.push(issue("E_GOTO_TARGET", `${p}/goto`, "The trigger's Go to points at a step that doesn't exist", { triggerId: tid }));
  });
  const parents = new Map<string, number>();
  for (const id of ids) {
    const p = `/nodes/${esc(id)}`, n = nodes[id];
    claim(id, p, { nodeId: id });
    if (!n || typeof n !== "object" || Array.isArray(n)) { out.push(issue("E_SCHEMA", p, "A step must be an object", { nodeId: id })); continue; }
    const e = nodeEntry(n.kind, n.type);
    if (!e) { out.push(issue("E_UNKNOWN_TYPE", `${p}/type`, `Unknown step "${String(n.kind ?? "")}/${String(n.type ?? "")}"`, { nodeId: id })); }
    for (const k of Object.keys(n)) if (!["kind", "type", "name", "note", "disabled", "locked", "config", "out"].includes(k)) out.push(issue("E_SCHEMA", `${p}/${esc(k)}`, "is not allowed here", { nodeId: id }));
    if (n.name != null && !(typeof n.name === "string" && n.name.length <= WF_LIMITS.name)) out.push(issue("E_SCHEMA", `${p}/name`, "The name is at most 120 characters", { nodeId: id }));
    if (n.note != null && !(typeof n.note === "string" && n.note.length <= WF_LIMITS.note)) out.push(issue("E_SCHEMA", `${p}/note`, "The note is at most 2000 characters", { nodeId: id }));
    for (const k of ["disabled", "locked"]) if (n[k] != null && typeof n[k] !== "boolean") out.push(issue("E_SCHEMA", `${p}/${k}`, "must be true or false", { nodeId: id }));
    const c = n.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) out.push(issue("E_SCHEMA", `${p}/config`, "config must be an object", { nodeId: id }));
    else if (e) {
      for (const x of schemaCheck(e.fields, c, LOOSE_DEFS, `${p}/config`)) out.push(issue("E_SCHEMA", x.path, x.text, { nodeId: id }));
      if (e.check) for (const x of e.check(c)) out.push(issue("E_SCHEMA", `${p}/config${x.path}`, x.text, { nodeId: id }));
    }
    const cfg = obj(c);
    for (const b of n.kind === "if_else" && Array.isArray(cfg.branches) ? cfg.branches : []) claim(obj(b).id, `${p}/config/branches`, { nodeId: id });
    for (const q of n.kind === "split" && Array.isArray(cfg.paths) ? cfg.paths : []) claim(obj(q).id, `${p}/config/paths`, { nodeId: id });
    if (n.kind === "split" && Array.isArray(cfg.paths)) {
      const pc = cfg.paths.map((q: unknown) => obj(q).percent);
      if (cfg.paths.length < 2 || cfg.paths.length > 5 || pc.some((x: unknown) => !Number.isInteger(x) || (x as number) < 0) || pc.reduce((a: number, b: number) => a + (Number(b) || 0), 0) !== 100)
        out.push(issue("E_SPLIT_PCT", `${p}/config/paths`, "A split has 2 to 5 paths whose percents add up to 100", { nodeId: id }));
    }
    const ports = wfPorts(n), o = n.out;
    if (!o || typeof o !== "object" || Array.isArray(o)) { out.push(issue("E_PORTS", `${p}/out`, "out must be an object", { nodeId: id })); continue; }
    const keys = Object.keys(o);
    if (!ports.length && keys.length) out.push(issue("E_GOTO_NOT_LAST", `${p}/out`, "This step ends its path: nothing can come after it", { nodeId: id }));
    else if (canonJson(keys) !== canonJson(ports)) out.push(issue("E_PORTS", `${p}/out`, `The paths must be exactly ${ports.join(", ") || "none"}`, { nodeId: id }));
    for (const k of keys) {
      const t = o[k];
      if (t === null) continue;
      if (typeof t !== "string" || !has(nodes, t)) { out.push(issue("E_SCHEMA", `${p}/out/${esc(k)}`, "points at a step that doesn't exist", { nodeId: id })); continue; }
      parents.set(t, (parents.get(t) || 0) + 1);
    }
    if (n.disabled === true && ports.length > 1) out.push(issue("E_DISABLED_BRANCHING", `${p}/disabled`, "A step with branches can't be paused", { nodeId: id }));
    if (e) {
      const need = n.kind === "goto" ? "target" : n.kind === "wait" && (n.type === "date" || n.type === "scheduled") && cfg.ifPassed === "goto" ? "gotoStep" : "";
      const refs = nodeRefs(n);
      if (need === "gotoStep" && !refs.some((r) => r.key === need)) out.push(issue("E_GOTO_TARGET", `${p}/config/${need}`, "Pick the step to go to", { nodeId: id }));
      for (const r of refs) if ((r.to === null && r.key === need) || (r.to !== null && !has(nodes, r.to))) out.push(issue("E_GOTO_TARGET", `${p}/config/${r.key}`, "Go to points at a step that doesn't exist", { nodeId: id }));
    }
  }
  for (const [t, k] of parents) if (k > 1) out.push(issue("E_EDGE_TWO_PARENTS", `/nodes/${esc(t)}`, "A step can come after only one step", { nodeId: t }));
  // an edge cycle (loops are only made with a Go to step)
  const state = new Map<string, number>(), cyc = new Set<string>();
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const p of wfPorts(nodes[id])) { const t = obj(nodes[id].out)[p]; if (typeof t !== "string" || !has(nodes, t)) continue; if (state.get(t) === 1) cyc.add(t); else if (!state.get(t)) dfs(t); }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id) && nodes[id] && typeof nodes[id] === "object") dfs(id);
  for (const id of cyc) out.push(issue("E_CYCLE", `/nodes/${esc(id)}`, "The steps go round in a circle: loops are made with a Go to step", { nodeId: id }));
  if (typeof d.entry === "string" ? (!has(nodes, d.entry) || parents.has(d.entry)) : (d.entry === null && ids.length > 0))
    out.push(issue("E_ENTRY_NOT_HEAD", "/entry", "The first step must exist and have nothing above it"));
  // locked guard steps and conditions (System / template workflows) stay exactly as stored
  if (opts.stored) {
    const sn = obj(obj(opts.stored).nodes), body = (n: unknown) => { const x = obj(n); return canonJson({ kind: x.kind, type: x.type, config: x.config, locked: x.locked }); };
    for (const [id, n] of Object.entries(sn)) if (obj(n).locked === true && (!has(nodes, id) || body(nodes[id]) !== body(n))) out.push(issue("E_LOCKED", `/nodes/${esc(id)}`, "This step is locked and can't be removed or changed", { nodeId: id }));
    const lockedBy = (dd: unknown) => { const m = new Map<string, string[]>(); for (const c of conditionsOf(dd)) { const key = c.nodeId ? `n:${c.nodeId}` : `t:${c.triggerId}`; m.set(key, [...(m.get(key) || []), ...(Array.isArray(obj(c.cond).segments) ? obj(c.cond).segments : []).flatMap(segRules).filter((r: any) => r.lock === true).map(canonJson)]); } return m; };
    const before = lockedBy(opts.stored), now = lockedBy(d);
    for (const [key, rules] of before) { const have = now.get(key) || []; if (rules.some((r) => !have.includes(r))) out.push(issue("E_LOCKED", key.startsWith("n:") ? `/nodes/${esc(key.slice(2))}` : "/triggers", "A locked condition can't be removed or changed", key.startsWith("n:") ? { nodeId: key.slice(2) } : { triggerId: key.slice(2) })); }
  }
  return out;
}

// x-greyed values inside a config (walks properties, items and the first fitting oneOf branch).
function greyedIn(schema: JSchema, value: unknown, ctx: AvailCtx, path: string, out: { path: string; reason: string }[]) {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.oneOf)) { const b = schema.oneOf.find((x: JSchema) => !schemaCheck(x, value, LOOSE_DEFS).length); if (b) greyedIn(b, value, ctx, path, out); return; }
  const g = obj(schema["x-greyed"]);
  if (typeof value === "string" && has(g, value)) { const r = greyedReason(g[value], ctx); if (r) out.push({ path, reason: r }); }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => greyedIn(schema.items, v, ctx, `${path}/${i}`, out));
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [k, s] of Object.entries(obj(schema.properties))) if (has(value as object, k)) greyedIn(s as JSchema, (value as Record<string, unknown>)[k], ctx, `${path}/${k}`, out);
}
// Unavailable types, greyed options and Advanced-only constructs in a Standard workflow. stored = the saved doc: an
// unavailable step that is already there with the same id and type stays (a warning), so a migrated SMS workflow
// round-trips (design §6.1 existingOnly).
// deno-lint-ignore no-explicit-any
export function validateAvailability(doc: any, ctx: AvailCtx, opts: { builder?: string; stored?: any } = {}): WfIssue[] {
  const d = obj(doc), out: WfIssue[] = [], sn = obj(obj(opts.stored).nodes), st = Array.isArray(obj(opts.stored).triggers) ? obj(opts.stored).triggers.map(obj) : [];
  (Array.isArray(d.triggers) ? d.triggers : []).forEach((t: unknown, i: number) => {
    const x = obj(t), te = triggerEntry(x.type); if (!te) return;
    const a = te.available(ctx), had = st.some((s: any) => s.id === x.id && s.type === x.type);
    if (!a.ok) out.push(issue("E_UNAVAILABLE", `/triggers/${i}/type`, a.reason || "Not available", { triggerId: String(x.id ?? ""), severity: had ? "warning" : "error" }));
    const gs: { path: string; reason: string }[] = []; greyedIn(te.fields, x.config, ctx, `/triggers/${i}/config`, gs);
    for (const g of gs) out.push(issue("E_UNAVAILABLE", g.path, g.reason, { triggerId: String(x.id ?? "") }));
    if (x.goto != null && opts.builder !== "advanced") out.push(issue("E_ADVANCED_ONLY", `/triggers/${i}/goto`, "A trigger's own Go to needs the Advanced builder", { triggerId: String(x.id ?? "") }));
  });
  for (const [id, n] of Object.entries(obj(d.nodes))) {
    const x = obj(n), e = nodeEntry(x.kind, x.type); if (!e) continue;
    const a = e.available(ctx), had = obj(sn[id]).kind === x.kind && obj(sn[id]).type === x.type;
    if (!a.ok) out.push(issue("E_UNAVAILABLE", `/nodes/${esc(id)}/type`, a.reason || "Not available", { nodeId: id, severity: had ? "warning" : "error" }));
    const gs: { path: string; reason: string }[] = []; greyedIn(e.fields, x.config, ctx, `/nodes/${esc(id)}/config`, gs);
    for (const g of gs) {
      const same = had && canonJson(obj(sn[id]).config) === canonJson(x.config);
      out.push(issue("E_UNAVAILABLE", g.path, g.reason, { nodeId: id, severity: same ? "warning" : "error" }));
    }
  }
  for (const c of conditionsOf(d)) (Array.isArray(obj(c.cond).segments) ? obj(c.cond).segments : []).forEach((s: unknown, si: number) => segRules(s).forEach((r, ri) => {
    const f = WF_FIELDS[r.field]; const a = f && f.available ? f.available(ctx) : AV_OK;
    if (!a.ok) out.push(issue("E_UNAVAILABLE", `${c.path}/segments/${si}/rules/${ri}/field`, a.reason || "Not available", { nodeId: c.nodeId, triggerId: c.triggerId }));
  }));
  if (opts.builder !== "advanced") {
    const C = compile(d), on = C.reach([C.entry], false);
    for (const id of C.ids) if (!on.has(id)) out.push(issue("E_ADVANCED_ONLY", `/nodes/${esc(id)}`, "Steps that are not connected need the Advanced builder", { nodeId: id }));
  }
  return out;
}

// ── semantic checks ──
// deno-lint-ignore no-explicit-any
const actionAudience = (n: any): string => { const e = obj(n).kind === "action" ? WF_ACTIONS[obj(n).type] : null; return e ? String(e.audience) : ""; };
export const isCustomerNode = (n: unknown) => actionAudience(n) === "customer";
// Does this trigger give the run what a field / blank needs?
// deno-lint-ignore no-explicit-any
export function fieldProvided(field: string, t: any): boolean {
  const te = triggerEntry(obj(t).type); if (!te) return false;
  if (isDynTriggerField(field)) return te.key === "inbound_webhook";
  const f = WF_FIELDS[field]; if (!f) return false;
  if (f.group === "Now" || field === "trigger.id" || field === "trigger.type") return true;
  if (f.triggers) return f.triggers.includes(te.key);
  return f.recordKinds.some((k) => te.provides.includes(k));
}
// deno-lint-ignore no-explicit-any
export function mergeProvided(key: string, t: any): boolean {
  const te = triggerEntry(obj(t).type); if (!te) return false;
  if (key.startsWith("custom.")) return true;
  if (key.startsWith("trigger.")) return fieldProvided(key, t);
  const m = WF_MERGE[key]; if (!m) return false;
  if (m.triggers) return m.triggers.includes(te.key);
  return m.recordKinds === "*" || m.recordKinds.some((k) => te.provides.includes(k));
}
export const mergeKnown = (key: string) => has(WF_MERGE, key) || /^custom\.[a-z0-9_]{1,40}$/.test(key) || /^trigger\.[a-z0-9_]{1,40}$/.test(key);
// every {blank} in a config's words (all string values, nested)
function blanksIn(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof x === "string") for (const m of x.matchAll(WF_MERGE_RE)) out.add(m[1]);
  else if (Array.isArray(x)) x.forEach((v) => blanksIn(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (k !== "templateKey") blanksIn(v, out);
  return out;
}
// The outgoing webhook's address: https only, never an internal or private place (design §3.12). '' = fine.
export function webhookUrlProblem(url: unknown): string {
  let u: URL; try { u = new URL(String(url ?? "")); } catch { return "Not a web address"; }
  if (u.protocol !== "https:") return "Only https:// addresses";
  if (u.username || u.password) return "No passwords in the address";
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\[.*\]$/.test(h) || /^\d+(\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return "An IP address is not allowed";
  if (h === "localhost" || /\.(local|internal|localhost|lan|home|corp)$/.test(h) || !h.includes(".")) return "An internal address is not allowed";
  if (/(^|\.)supabase\.(co|in)$/.test(h)) return "This address is not allowed";
  return "";
}
export const SECRET_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey)$|token|secret|passw|session|signature|credential|private/i;
// deno-lint-ignore no-explicit-any
export function ruleProblems(r: any, path: string, x: { nodeId?: string; triggerId?: string }): WfIssue[] {
  const out: WfIssue[] = [], f = WF_FIELDS[r.field], dyn = isDynTriggerField(r.field);
  if (!f && !dyn) return [issue("E_UNKNOWN_TYPE", `${path}/field`, `Unknown field "${String(r.field ?? "")}"`, x)];
  const ops = f ? f.ops : WF_OPS_BY_TYPE.text, vt = f ? f.valueType : "text";
  if (!ops.includes(r.op) || !WF_OPS[r.op]) return [issue("E_SCHEMA", `${path}/op`, `"${String(r.op ?? "")}" can't be used with ${f ? f.label : r.field}`, x)];
  const a = WF_OPS[r.op].args, miss = (k: string) => out.push(issue("rule_value_missing", `${path}/${k}`, "Pick a value", x)), bad = (k: string, t: string) => out.push(issue("rule_value_type", `${path}/${k}`, t, x));
  const str1 = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.length <= 100;
  if (r.ref != null) {
    const rf = WF_FIELDS[r.ref], same = rf && (rf.valueType === vt || (["number", "money"].includes(rf.valueType) && ["number", "money"].includes(vt)));
    if (!WF_OPS[r.op].ref || !REF_TYPES.includes(vt)) bad("ref", "A dynamic value only works with numbers, money, dates and lists");
    else if (!same) bad("ref", "The other field is not the same kind of value");
    return out;
  }
  if (a === "one") { if (r.v == null || r.v === "") miss("v"); else if (!str1(r.v)) bad("v", "Pick one value"); }
  else if (a === "many") { if (r.v == null || (Array.isArray(r.v) && !r.v.length)) miss("v"); else if (!Array.isArray(r.v) || r.v.length > 50 || !r.v.every(str1)) bad("v", "Pick one or more values"); }
  else if (a === "num") { if (r.n == null || r.n === "") miss("n"); else if (typeof r.n !== "number" || !Number.isFinite(r.n)) bad("n", "Enter a number"); }
  else if (a === "range") { for (const k of ["n", "v2"]) { if (r[k] == null || r[k] === "") miss(k); else if (typeof r[k] !== "number" || !Number.isFinite(r[k])) bad(k, "Enter a number"); } }
  else if (a === "date") { if (r.v == null || r.v === "") miss("v"); else if (!(typeof r.v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.v))) bad("v", "Pick a date"); }
  else if (a === "rel") {
    if (r.n == null || r.n === "") miss("n"); else if (!Number.isInteger(r.n) || r.n < 1 || r.n > 1000) bad("n", "Enter a whole number from 1 to 1000");
    if (r.unit == null) miss("unit"); else if (!WF_REL_UNITS.includes(r.unit)) bad("unit", "Pick minutes, hours, days, weeks or months");
  }
  if (f && f.arg) { const { min, max } = f.arg.n; if (r.n == null) miss("n"); else if (!(typeof r.n === "number" && r.n >= min && r.n <= max)) bad("n", `The number must be ${min} to ${max}`); }
  if (f && f.values && (a === "one" || a === "many") && !out.length) for (const v of Array.isArray(r.v) ? r.v : [r.v]) if (!f.values.some((o) => o.key === v)) { bad("v", "Not one of the choices"); break; }
  return out;
}
// deno-lint-ignore no-explicit-any
export function validateSemantic(doc: any, opts: { builder?: string; catalog?: any; profiles?: any[] } = {}): WfIssue[] {
  const d = obj(doc), out: WfIssue[] = [], C = compile(d), nodes = C.nodes, triggers = C.triggers;
  const known = (t: unknown) => !!t && !!triggerEntry(obj(t).type);   // an unknown trigger is E_UNKNOWN_TYPE already
  const enabled = triggers.filter((t) => t.disabled !== true);
  if (!enabled.length) out.push(issue("E_NO_TRIGGER", "/triggers", "No trigger is on: only manual add or Add to workflow can start it", { severity: "warning" }));
  if (!C.ids.some((id) => ["action", "workflow"].includes(obj(nodes[id]).kind))) out.push(issue("E_NO_ACTION", "/nodes", "The workflow does nothing: add an action"));
  // conditions: rule arguments, fields per trigger, gates in an "any" group
  for (const c of conditionsOf(d)) {
    const segs = Array.isArray(obj(c.cond).segments) ? obj(c.cond).segments : [], x = { nodeId: c.nodeId, triggerId: c.triggerId };
    const reaching = c.nodeId ? C.reachingTriggers[c.nodeId].map((tid) => triggers.find((t) => t.id === tid)).filter(known) : [];
    const own = c.triggerId != null ? triggers.find((t) => t.id === c.triggerId) : null;
    let gateInAny = false;
    segs.forEach((s: unknown, si: number) => segRules(s).forEach((r, ri) => {
      const p = `${c.path}/segments/${si}/rules/${ri}`, probs = ruleProblems(r, p, x);
      out.push(...probs);
      if (probs.some((q) => q.code === "E_UNKNOWN_TYPE")) return;
      if (own) {
        const te = triggerEntry(own.type);
        if (te && !(te.filters.includes(r.field) || (te.key === "inbound_webhook" && isDynTriggerField(r.field))))
          out.push(issue("E_FIELD_NOT_FOR_ALL_TRIGGERS", `${p}/field`, `${WF_FIELDS[r.field] ? WF_FIELDS[r.field].label : r.field} can't be used as a filter of "${te.label}"`, x));
      } else for (const t of reaching) if (t && !fieldProvided(r.field, t)) out.push(issue("E_FIELD_NOT_FOR_ALL_TRIGGERS", `${p}/field`, `${WF_FIELDS[r.field] ? WF_FIELDS[r.field].label : r.field} is not known for the trigger "${t.name || (triggerEntry(t.type) || { label: t.type }).label}"`, { ...x, triggerId: t.id }));
      if (WF_FIELDS[r.field] && WF_FIELDS[r.field].hidden) out.push(issue("W_HIDDEN_TYPE", `${p}/field`, `${WF_FIELDS[r.field].label} is set by the system`, x));
      if (isGateRule(r) && ((obj(s).match === "any" && segRules(s).length > 1) || (obj(c.cond).match === "any" && segs.length > 1))) gateInAny = true;
    }));
    if (gateInAny) out.push(issue("W_GATE_MOVED", c.path, "\"Still in the stage that started it\" is always checked first, even in an \"any\" group", x));
  }
  for (const t of triggers) { const te = triggerEntry(t.type); if (te && te.hidden) out.push(issue("W_HIDDEN_TYPE", "/triggers", `"${te.label}" is a built-in start`, { triggerId: String(t.id ?? "") })); }
  // loops: every Go to cycle holds at a wait; a customer message inside a loop is capped daily
  const holds = (id: string) => { const n = obj(nodes[id]), c = obj(n.config); return n.kind === "wait" && (WF_HOLDING_WAITS.includes(n.type) || (["reply", "user_reply", "conditions"].includes(n.type) && c.timeout != null)); };
  const edges = (id: string, skip: (x: string) => boolean) => [...C.kids[id], ...C.refs.filter((r) => r.from === id).map((r) => r.to)].filter((x) => !skip(x));
  const sccs = (skip: (x: string) => boolean): string[][] => {
    let idx = 0; const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), res: string[][] = [];
    const strong = (v: string) => {
      index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
      for (const w of edges(v, skip)) { if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v) as number, low.get(w) as number)); } else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number)); }
      if (low.get(v) === index.get(v)) { const comp: string[] = []; let w = ""; do { w = stack.pop() as string; on.delete(w); comp.push(w); } while (w !== v); if (comp.length > 1 || edges(v, skip).includes(v)) res.push(comp); }
    };
    for (const id of C.ids) if (!skip(id) && !index.has(id)) strong(id);
    return res;
  };
  for (const comp of sccs(holds)) for (const id of comp) if (obj(nodes[id]).kind === "goto") out.push(issue("E_LOOP_NO_WAIT", `/nodes/${esc(id)}`, "This loop has no wait: add a wait inside it", { nodeId: id }));
  for (const comp of sccs(() => false)) if (comp.some((id) => isCustomerNode(nodes[id]))) for (const id of comp) if (obj(nodes[id]).kind === "goto") out.push(issue("W_LOOP_CUSTOMER", `/nodes/${esc(id)}`, "A customer message is inside a loop: the daily limit applies", { nodeId: id }));
  // per node
  const cat = opts.catalog, templates = obj(obj(cat).templates);
  const reachable = C.reach([C.entry, ...triggers.map((t) => C.first(t.id))], true);
  for (const id of C.ids) {
    const n = obj(nodes[id]), c = obj(n.config), e = nodeEntry(n.kind, n.type), p = `/nodes/${esc(id)}`, x = { nodeId: id };
    if (!e) continue;
    const reaching = C.reachingTriggers[id].map((tid) => triggers.find((t) => t.id === tid)).filter(known);
    if (n.kind === "action") {
      for (const k of blanksIn(c)) {
        if (!mergeKnown(k)) { out.push(issue("E_MERGE_FIELD", `${p}/config`, `{${k}} is not a blank this workflow can fill`, x)); continue; }
        for (const t of reaching) if (!mergeProvided(k, t)) out.push(issue("W_MERGE_FIELD", `${p}/config`, `{${k}} is empty when "${t.name || (triggerEntry(t.type) || { label: t.type }).label}" starts it`, { ...x, triggerId: t.id }));
      }
      if (typeof c.templateKey === "string" && c.templateKey && cat && !has(templates, c.templateKey)) out.push(issue("E_TEMPLATE_MISSING", `${p}/config/templateKey`, "This message template no longer exists", x));
      if (isCustomerNode(n) && reaching.length) {
        const less = reaching.filter((t: any) => { const te = triggerEntry(t.type); return te && te.contactless; });
        if (less.length === reaching.length && less.every((t: any) => triggerEntry(t.type)?.contactless === true)) out.push(issue("E_CUSTOMER_NO_CONTACT", p, "This message has no lead to go to: its trigger has no lead", x));
        else if (less.length) out.push(issue("W_CUSTOMER_IN_CONTACTLESS", p, "Some triggers of this workflow have no lead: the message is skipped then", x));
      }
      if (n.type === "webhook") {
        const why = webhookUrlProblem(c.url); if (why) out.push(issue("E_WEBHOOK_URL", `${p}/config/url`, why, x));
        (Array.isArray(c.headers) ? c.headers : []).forEach((h: unknown, k: number) => { const hh = obj(h); if (SECRET_HEADER_RE.test(String(hh.name ?? "")) || /^bearer\s/i.test(String(hh.value ?? ""))) out.push(issue("E_SECRET_HEADER", `${p}/config/headers/${k}`, "Secret headers can't be typed here", x)); });
        out.push(issue("W_SENDS_OUTSIDE", p, `Sends lead details to ${(() => { try { return new URL(String(c.url)).hostname; } catch { return "another system"; } })()}`, x));
      }
      if (n.type === "internal_notification" || n.type === "webhook") {
        const to = obj(c.to), roles = Array.isArray(to.roles) ? to.roles : [], people = Array.isArray(to.people) ? to.people : [], profs = Array.isArray(opts.profiles) ? opts.profiles : [];
        const others = n.type === "webhook" || roles.some((r: unknown) => r !== "owner") || people.some((pid: unknown) => { const pr = profs.find((q: any) => q && q.id === pid); return !pr || pr.role !== "owner"; });
        const money = [...blanksIn(c)].filter((k) => WF_MERGE[k] && WF_MERGE[k].sensitivity);
        if (others && money.length) out.push(issue("W_MONEY_TO_NON_OWNER", `${p}/config`, `${money.map((k) => `{${k}}`).join(", ")} is money, and this also goes to people who are not owners`, x));
      }
    }
    // a date / scheduled wait reads its date from a field: every trigger that reaches it must give that field (§3.3)
    if (n.kind === "wait" && (n.type === "date" || n.type === "scheduled")) {
      const k = n.type === "date" ? "ref" : "anchor", field = c[k];
      const fixed = n.type === "date" && typeof c.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(c.at);
      if (!fixed && typeof field === "string" && (WF_FIELDS[field] || isDynTriggerField(field)))
        for (const t of reaching) if (t && !fieldProvided(field, t)) out.push(issue("E_FIELD_NOT_FOR_ALL_TRIGGERS", `${p}/config/${k}`, `${WF_FIELDS[field] ? WF_FIELDS[field].label : field} is not known for the trigger "${t.name || (triggerEntry(t.type) || { label: t.type }).label}"`, { ...x, triggerId: t.id }));
    }
    if (n.kind === "wait" && n.type === "reply" && !C.ancestors(id).some((a) => isCustomerNode(nodes[a]))) out.push(issue("W_REPLY_NO_SEND", p, "Nothing is sent to the lead before this wait", x));
    const ports = wfPorts(n);
    if ((n.kind === "wait" || n.kind === "goal") && ports.length && ports.every((q) => obj(n.out)[q] == null)) out.push(issue("W_LAST_NOT_ACTION", p, "The last step does nothing: end with an action, or remove it", x));
    if (e.hidden) out.push(issue("W_HIDDEN_TYPE", p, `"${e.label}" is a built-in step`, x));
    if (opts.builder === "advanced" && !reachable.has(id)) out.push(issue("W_DELINKED", p, "Not connected: no trigger reaches this step", x));
  }
  return out;
}
// All three, split into errors and warnings (codes for parity fixtures: sorted, unique).
// deno-lint-ignore no-explicit-any
export function validateDoc(doc: any, opts: { builder?: string; avail?: AvailCtx; catalog?: any; stored?: any; profiles?: any[]; maxSteps?: number } = {}) {
  const all = [...validateStructure(doc, { maxSteps: opts.maxSteps ?? (opts.catalog ? wfMaxSteps(opts.catalog) : undefined), stored: opts.stored }),
    ...(opts.avail ? validateAvailability(doc, opts.avail, { builder: opts.builder, stored: opts.stored }) : []),
    ...validateSemantic(doc, { builder: opts.builder, catalog: opts.catalog, profiles: opts.profiles })];
  return { errors: all.filter((x) => x.severity === "error"), warnings: all.filter((x) => x.severity === "warning") };
}
export const issueCodes = (list: WfIssue[]) => [...new Set(list.map((x) => x.code))].sort();

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== REGISTRY EXPORT + JSON SCHEMA (design §2.5 export DTO, §6.1). The business's own lists (stages, services,
// sources, tags, templates, people, workflows) come in as `biz` and become enums in $defs/business, so the static part
// of the schema stays the same for every business (prompt-cacheable).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type BizLists = Record<string, { key: string; label: string }[]>;
// deno-lint-ignore no-explicit-any
export function bizListsOf(cat: any, extra: { people?: { id: string; full_name?: string }[]; workflows?: { id: string; name?: string }[] } = {}): BizLists {
  const c = obj(cat), list = (sec: string) => catList(c, sec).map((x) => ({ key: catKey(x), label: typeof x.label === "string" && x.label.trim() ? x.label.trim() : catKey(x) })).filter((x) => x.key);
  return { stages: list("stages"), services: list("services"), sources: list("sources"), tags: list("tags"),
    templates: Object.keys(obj(c.templates)).map((k) => ({ key: k, label: k })),
    people: (extra.people || []).map((p) => ({ key: String(p.id), label: String(p.full_name || p.id) })),
    workflows: (extra.workflows || []).map((w) => ({ key: String(w.id), label: String(w.name || w.id) })) };
}
const bizDef = (items: { key: string; label: string }[] | undefined): JSchema => items && items.length
  ? { type: "string", enum: items.map((x) => x.key), "x-enumLabels": items.map((x) => x.label) } : { type: "string", minLength: 1, maxLength: 100 };
// x-source → $ref into $defs/business (generate) or an inline enum (export); greyed values dropped when `ctx` says so.
function resolveSchema(s: JSchema, mode: { inline?: BizLists; ctx?: AvailCtx; dropGreyed?: boolean }): JSchema {
  if (Array.isArray(s)) return s.map((x) => resolveSchema(x, mode)) as unknown as JSchema;
  if (!s || typeof s !== "object") return s;
  const out: JSchema = {};
  for (const [k, v] of Object.entries(s)) out[k] = (v && typeof v === "object") ? resolveSchema(v as JSchema, mode) : v;
  const src = s["x-source"];
  if (typeof src === "string" && src.startsWith("catalog.")) {
    const name = src.slice(8);
    if (mode.inline) { const b = bizDef(mode.inline[name]); delete out.minLength; delete out.maxLength; Object.assign(out, b); }
    else return { $ref: `#/$defs/business/${name}`, "x-source": src };
  }
  if (mode.dropGreyed && mode.ctx && Array.isArray(out.enum) && out["x-greyed"]) {
    const g = obj(out["x-greyed"]); out.enum = out.enum.filter((v: string) => !has(g, v) || !greyedReason(g[v], mode.ctx as AvailCtx));
  }
  return out;
}
// The export DTO the builder and the AI read (step "registry").
// deno-lint-ignore no-explicit-any
export function registryExport(ctx: AvailCtx, biz: BizLists = {}) {
  const base = (e: WfEntry) => ({ key: e.key, ghl: e.ghl, label: e.label, description: e.description, category: e.category, icon: e.icon, keywords: e.keywords, help: e.help,
    aliases: e.aliases || [], engine: e.engine, hidden: !!e.hidden, availability: e.available(ctx), narration: e.narration, fields: resolveSchema(e.fields, { inline: biz, ctx }) });
  const node = (e: WfNodeEntry) => ({ ...base(e), kind: e.kind, ...(e.audience ? { audience: e.audience, channel: e.channel || null, needsContact: !!e.needsContact, outbound: !!e.outbound } : {}),
    ...(e.wakeOn ? { wakeOn: e.wakeOn } : {}), ...(e.portLabels ? { portLabels: e.portLabels } : {}) });
  return {
    v: 2, availCtx: ctx,
    triggers: Object.values(WF_TRIGGERS).map((t) => ({ ...base(t), recordKind: t.recordKind, source: t.source, filters: t.filters, alwaysReenter: !!t.alwaysReenter, contactless: t.contactless || false, ...(t.mirror ? { mirror: t.mirror } : {}) })),
    actions: Object.values(WF_ACTIONS).map(node), waits: Object.values(WF_WAITS).map(node), goals: Object.values(WF_GOALS).map(node), logic: Object.values(WF_LOGIC).map(node),
    fields: Object.values(WF_FIELDS).map((f) => ({ key: f.key, label: f.label, group: f.group, valueType: f.valueType, ops: f.ops, source: f.source || null, recordKinds: f.recordKinds,
      triggers: f.triggers || null, gate: !!f.gate, hidden: !!f.hidden, wakeOn: f.wakeOn, timeRelative: !!f.timeRelative, sensitivity: f.sensitivity || null, arg: f.arg || null,
      values: f.values || (f.source && f.source.startsWith("catalog.") ? biz[f.source.slice(8)] || [] : null), availability: f.available ? f.available(ctx) : AV_OK,
      narration: "{field} {opLabel} {values}" })),
    ops: Object.entries(WF_OPS).map(([op, o]) => ({ op, label: o.label, valueTypes: opValueTypes(op), args: o.args, ref: !!o.ref, ...opArgSchema(op) })),
    merge: Object.values(WF_MERGE).map((m) => ({ key: m.key, label: m.label, recordKinds: m.recordKinds, triggers: m.triggers || null, sensitivity: m.sensitivity || null, availability: m.available ? m.available(ctx) : AV_OK })),
    reasons: WF_REASONS,
    settings: { defaults: WF_SETTINGS_DEFAULTS },
  };
}
// The JSON Schema (draft 2020-12) of { definition, settings } for this business (design §6.1). mode "generate" = what
// the AI may write (unavailable types and greyed options, if_else gate, legacy_always and timezone "contact" left out;
// Advanced-only constructs only for builder "advanced"); mode "accept" = everything a stored doc may hold. stored =
// the saved doc: its unavailable steps are accepted under their own ids only ($defs/existingOnly).
// deno-lint-ignore no-explicit-any
export function jsonSchema(ctx: AvailCtx, biz: BizLists = {}, opts: { mode?: "generate" | "accept"; builder?: string; stored?: any; maxSteps?: number } = {}): JSchema {
  const gen = opts.mode !== "accept", adv = opts.builder === "advanced", mode = { ctx, dropGreyed: gen };
  const ok = (e: WfEntry) => !gen || (e.available(ctx).ok && !e.hidden);
  const fieldOk = (f: WfField) => !gen || (!f.hidden && (!f.available || f.available(ctx).ok));
  // one rule shape per op; the field list is every field that takes the op (a trigger's filters: only its own fields,
  // and for an inbound webhook any payload key "trigger.<key>" with the text ops)
  const ruleVariant = (op: string, allowed?: string[], dyn = false): JSchema | null => {
    const fields = Object.values(WF_FIELDS).filter((f) => f.ops.includes(op) && fieldOk(f) && (!allowed || allowed.includes(f.key))).map((f) => f.key);
    const dynOk = dyn && WF_OPS_BY_TYPE.text.includes(op);
    if (!fields.length && !dynOk) return null;
    const fieldS: JSchema = dynOk ? { type: "string", anyOf: [{ enum: fields }, { pattern: "^trigger\\.[a-z0-9_]{1,40}$" }] } : { type: "string", enum: fields };
    const a = opArgSchema(op), props: JSchema = { field: fieldS, op: { const: op }, ...a.props, lock: sc.bool() };
    if (op === "true" || op === "false") props.n = { type: "number" };
    const v: JSchema = { type: "object", properties: props, required: ["field", "op", ...a.required], additionalProperties: false };
    if (a.alt) v.anyOf = [{ required: [a.alt] }, { required: ["ref"] }];
    return v;
  };
  const rule: JSchema = { oneOf: Object.keys(WF_OPS).map((op) => ruleVariant(op)).filter(Boolean) };
  const outSchema = (e: WfNodeEntry): JSchema => {
    const t = sc.ref(true);
    if (e.kind === "if_else" || e.kind === "split") return { type: "object", propertyNames: { pattern: ID_PATTERN }, additionalProperties: t, minProperties: 2 };
    if (e.kind === "goto") return { type: "object", maxProperties: 0 };
    if (e.kind === "wait" && e.portLabels) return { type: "object", properties: { next: t, timeout: t }, required: ["next"], additionalProperties: false };
    if (e.key === "remove_from_workflow") return { type: "object", properties: { next: t }, additionalProperties: false };
    return sc.obj({ next: t }, ["next"]);
  };
  const nodeVariant = (e: WfNodeEntry): JSchema => {
    let fields = resolveSchema(e.fields, mode);
    if (gen && e.key === "if_else") { fields = jclone(fields); delete fields.properties.gate; }
    return sc.obj({ kind: { const: e.kind }, type: { const: e.key }, name: sc.str(WF_LIMITS.name), note: sc.str(WF_LIMITS.note), disabled: sc.bool(), locked: sc.bool(), config: fields, out: outSchema(e) }, ["kind", "type", "config", "out"]);
  };
  const allNodes = [...Object.values(WF_ACTIONS), ...Object.values(WF_WAITS), ...Object.values(WF_GOALS), ...Object.values(WF_LOGIC)];
  const triggerVariant = (t: WfTriggerEntry): JSchema => sc.obj({ id: sc.req(40, { pattern: ID_PATTERN }), type: { const: t.key }, name: sc.str(WF_LIMITS.name), disabled: sc.bool(),
    filters: sc.def(`filters_${t.key}`), config: resolveSchema(t.fields, mode), ...(adv || !gen ? { goto: sc.ref(true) } : {}) },
    ["id", "type", "filters", ...((t.fields.required || []).length ? ["config"] : [])]);
  const triggerDefs: JSchema = {};
  for (const t of Object.values(WF_TRIGGERS).filter(ok)) {
    const own = Object.values(WF_FIELDS).filter((f) => t.filters.includes(f.key) && fieldOk(f)).map((f) => f.key);
    triggerDefs[`rule_${t.key}`] = t.key === "inbound_webhook" ? { oneOf: Object.keys(WF_OPS).map((op) => ruleVariant(op, t.filters, true)).filter(Boolean) }
      : { allOf: [sc.def("rule"), { type: "object", properties: { field: { enum: own } } }] };
    triggerDefs[`filters_${t.key}`] = condSchema(sc.def(`rule_${t.key}`), 0);
  }
  const nodesSchema: JSchema = { type: "object", propertyNames: { pattern: ID_PATTERN }, additionalProperties: sc.def("node"), maxProperties: opts.maxSteps ?? WF_LIMITS.maxStepsDefault };
  const existingOnly: JSchema = {};
  if (gen && opts.stored) for (const [id, n] of Object.entries(obj(obj(opts.stored).nodes))) {
    const e = nodeEntry(obj(n).kind, obj(n).type);
    if (e && !ok(e)) { existingOnly[id] = nodeVariant(e); (nodesSchema.properties = nodesSchema.properties || {})[id] = { anyOf: [sc.def("node"), { $ref: `#/$defs/existingOnly/${id}` }] }; }
  }
  const S = WF_SETTINGS_DEFAULTS;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema", title: "Workflow", type: "object",
    properties: { definition: sc.def("doc"), settings: sc.def("settings") }, required: ["definition"], additionalProperties: false,
    $defs: {
      doc: sc.obj({ schema: { const: 2 }, seq: sc.int(0, 1000000), entry: sc.ref(true), triggers: sc.arr(sc.def("trigger"), 0, WF_LIMITS.triggers), nodes: nodesSchema }, ["schema", "seq", "entry", "triggers", "nodes"]),
      trigger: { oneOf: Object.values(WF_TRIGGERS).filter(ok).map(triggerVariant) },
      node: { oneOf: allNodes.filter(ok).map(nodeVariant) },
      condition: condSchema(sc.def("rule"), 1), rule, ...triggerDefs,
      settings: sc.obj({ reentry: sc.en(gen ? ["off", "after_exit"] : ["off", "after_exit", "legacy_always"]), perRecord: sc.bool(), stopOnResponse: sc.bool(),
        timezone: sc.en(gen ? ["business"] : ["business", "contact"]), window: sc.obj({ on: sc.bool(), days: S_DAYS, from: sc.hm(), until: sc.hm() }, ["on"]),
        sender: sc.obj({ fromName: { type: ["string", "null"], maxLength: 60 } }), markRead: sc.bool() }, [], { default: S }),
      business: Object.fromEntries(["stages", "services", "sources", "tags", "templates", "people", "workflows"].map((k) => [k, bizDef(biz[k])])),
      ...(Object.keys(existingOnly).length ? { existingOnly } : {}),
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The engine
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
// avail = what this business has (availCtx, §2.5) for the v2 executor; unset = worked out from the catalog.
export type TickCtx = { S: Settings; cat: any; company: string; agent?: string; autos: Map<string, any>; counts: Record<string, number>; avail?: AvailCtx };
const newCounts = () => ({ events: 0, enqueued: 0, processed: 0, sent: 0, queued: 0, skipped: 0, deferred: 0 });
// deno-lint-ignore no-explicit-any
export async function loadContext(sb: any, nowMs = Date.now()): Promise<TickCtx> {
  const { data: srow } = await sb.from("automation_settings").select("*").eq("business_id", BUSINESS_ID).maybeSingle();
  const { data: st, error: stErr } = await sb.from("settings").select("company_name, catalog").limit(1);
  // the names, brands and days off are in the settings: a failed read stops this run (the next minute tries again), it
  // never runs as if nothing were saved
  if (stErr) throw new Error("settings not read: " + String(stErr.message || stErr));
  const set = (st && st[0]) || {}, cat = obj(set.catalog), S = normSettings(srow);
  // One time zone (T1.2): the business's (Region and format) wins; else the old automation_settings value; else Sydney.
  if (bizTzSet(cat)) S.timezone = bizTzOf(cat);
  // {agent} (T1.7): the office people, read once a run; if they can't be read, the office's name.
  let agent = officeOf(cat);
  try { agent = agentOf(await rows(sb.from("profiles").select("full_name, role, on_duty, on_duty_date").eq("role", "va")), zoneParts(nowMs, S.timezone).day, cat); } catch { /* the office's name */ }
  return { S, cat, company: String(set.company_name || "").trim(), agent, autos: new Map(), counts: newCounts() };
}
// deno-lint-ignore no-explicit-any
async function enabledAutomations(sb: any): Promise<any[]> {
  return await rows(sb.from("automations").select("*").eq("business_id", BUSINESS_ID).eq("enabled", true));
}
// deno-lint-ignore no-explicit-any
async function readAutomation(sb: any, id: string): Promise<any | null> {
  const { data, error } = await sb.from("automations").select("*").eq("id", id).eq("business_id", BUSINESS_ID).maybeSingle();
  if (error) throw new Error(String(error.message || error));
  return data || null;
}

// The record and its customer card, read fresh. null = the record is gone.
// deno-lint-ignore no-explicit-any
export async function loadFacts(sb: any, run: any, T: TickCtx, nowMs: number): Promise<Facts | null> {
  // deno-lint-ignore no-explicit-any
  const one = async (table: string, cols: string, id: unknown): Promise<any> => {
    const { data, error } = await sb.from(table).select(cols).eq("id", id).maybeSingle();
    if (error) throw new Error(String(error.message || error));
    return data || null;
  };
  const f: Facts = { kind: run.record_kind, type: run.event_type, contact: null, job: null, call: null, chat: null, ctx: obj(run.context), eventAt: run.event_at, S: T.S, cat: T.cat, company: T.company, nowMs, agent: T.agent };
  const kind = run.record_kind, id = run.record_id;
  if (kind === "contact") { f.contact = await one("contacts", CONTACT_COLS, id); if (!f.contact) return null; return f; }
  const table = kind === "job" ? "jobs" : kind === "call" ? "calls" : kind === "chat" ? "chat_sessions" : "";
  if (!table) return null;
  const row = await one(table, kind === "job" ? JOB_COLS : kind === "call" ? CALL_COLS : CHAT_COLS, id);
  if (!row) return null;
  if (kind === "job") f.job = row; else if (kind === "call") f.call = row; else f.chat = row;
  if (row.contact_id) f.contact = await one("contacts", CONTACT_COLS, row.contact_id);
  return f;
}

// The words of a customer message: its own text, or a saved template (Settings → Message templates).
// deno-lint-ignore no-explicit-any
function messageOf(st: any, cat: any): string | null {
  if (hasText(st.templateKey)) { const t = obj(cat && cat.templates)[st.templateKey]; return typeof t === "string" && t.trim() ? t : null; }
  return typeof st.body === "string" ? st.body : "";
}

// Every address of this customer (its email and its phone in E.164): the daily cap and the review-ask check count a
// message to any of them, so two cards of the same person (a duplicate) share one cap.
// deno-lint-ignore no-explicit-any
export function customerKeys(c: any): string[] { return [...new Set([cleanEmail(c && c.email), toE164(c && c.phone)].filter(Boolean))]; }
export const customerHours = (S: Settings) => ({ days: S.customer_days, from: S.customer_from, until: S.customer_until });
// How many automatic messages this customer got in the last 24 hours, on every channel: this engine's (any card with one
// of these addresses, including one being sent right now), the other functions' automatic texts and emails to this card,
// and review requests sent to these addresses.
// deno-lint-ignore no-explicit-any
export async function recentAutoMessages(sb: any, c: any, keys: string[], nowMs: number, max: number): Promise<number> {
  const since = iso(nowMs - DAY);
  const who = [`contact_id.eq.${c.id}`, ...keys.map((k) => `recipient.eq."${k}"`)].join(",");
  const logs = await rows(sb.from("automation_log").select("id, ref_id").eq("business_id", BUSINESS_ID).eq("audience", "customer").in("status", ["sending", "sent", "queued"]).gte("at", since).or(who).limit(50));
  if (logs.length >= max) return logs.length;
  // deno-lint-ignore no-explicit-any
  const mine = new Set(logs.map((l: any) => String(l.ref_id || "")).filter(Boolean));
  const msgs = await rows(sb.from("lead_messages").select("id, status").eq("contact_id", c.id).eq("direction", "out").eq("auto", true).gte("at", since).limit(50));
  // deno-lint-ignore no-explicit-any
  const others = msgs.filter((m: any) => !mine.has(String(m.id)) && m.status !== "failed" && m.status !== "undelivered").length;
  const ors = keys.map((k) => (k.includes("@") ? `email.eq."${k}"` : `phone.eq."${k}"`)).join(",");
  const asks = ors ? await rows(sb.from("review_requests").select("id").eq("status", "sent").gte("sent_at", since).or(ors).limit(10)) : [];
  return logs.length + others + asks.length;
}
// May this customer get this message now? { ok, to, keys } | { defer: ms } | { skip: reason }.
// deno-lint-ignore no-explicit-any
export async function customerGuard(sb: any, S: Settings, f: Facts, channel: string, nowMs: number, automation: any, texts: string[] = [], hoursCat: any = {}): Promise<{ ok: true; to: string; keys: string[] } | { defer: number } | { skip: string }> {
  if (!automation || automation.enabled !== true) return { skip: "switched off" };
  const c = f.contact;
  if (!c) return { skip: "no customer card" };
  if (S.ignore_test_records && hasTag(c.tags, S.test_tags)) return { skip: "test record" };
  if (hasTag(c.tags, S.dont_contact_tags)) return { skip: "do not contact" };
  if (S.respect_dont_ask && await dontAskMarked(sb, f)) return { skip: "marked don't ask" };
  let to = "";
  if (channel === "email") {
    to = cleanEmail(c.email);
    if (!to) return { skip: "no email" };
    const outs = await rows(sb.from("customer_opt_outs").select("id").eq("business_id", BUSINESS_ID).in("channel", ["email", "all"]).or(`contact_id.eq.${c.id},value_key.eq."${to}"`).limit(1));
    if (outs.length) return { skip: "opted out" };
  } else if (channel === "text") {
    to = toE164(c.phone);
    if (!isMobile(to)) return { skip: "no mobile" };
    const key = phoneKey(to);
    const stop = await rows(sb.from("sms_opt_outs").select("phone_key").eq("phone_key", key).limit(1));
    const outs = stop.length ? stop : await rows(sb.from("customer_opt_outs").select("id").eq("business_id", BUSINESS_ID).in("channel", ["text", "all"]).or(`contact_id.eq.${c.id},value_key.eq."${key}"`).limit(1));
    if (outs.length) return { skip: "opted out" };
  } else return { skip: "not a customer channel" };
  const hours = customerHours(S);
  if (!inWindow(nowMs, hours, S.timezone, hoursCat)) {
    const next = nextAllowed(nowMs, hours, S.timezone, hoursCat);
    return next === null ? { skip: "no customer days set" } : { defer: next };
  }
  const keys = [...new Set([to, ...customerKeys(c)])];
  if (await recentAutoMessages(sb, c, keys, nowMs, S.customer_daily_cap) >= S.customer_daily_cap) return { skip: "already contacted today" };
  const missing = [...new Set(texts.flatMap(unfilled))];
  if (missing.length) return { skip: "missing details: " + missing.join(", ") };
  return { ok: true, to, keys };
}

const DEEP_LINK: Record<string, string> = { contact: "?tab=crm", job: "?tab=jobs", call: "?tab=myDay", chat: "?tab=crm" };
const TASK_PRIORITIES = ["Low", "Medium", "High", "Urgent"];
// The app's board rule (index.html boardForAssignees): the office's tasks — a VA login (full name, technician name or the
// first word of the full name) or an employee with the VA role — and tasks with no one go on the office's board (its
// storage key stays 'ron'); anyone else's on their own board.
// deno-lint-ignore no-explicit-any
export function boardFor(names: string[], profiles: any[], employees: any[] = []): string {
  const first = names[0]; if (!first) return "ron";
  const va = profiles.find((p) => p.role === "va" && (p.full_name === first || p.technician_name === first || String(p.full_name || "").trim().split(/\s+/)[0] === first))
    || employees.some((e) => e && e.name === first && Array.isArray(e.roles) && e.roles.includes("VA"));
  return va ? "ron" : first;
}
// deno-lint-ignore no-explicit-any
async function pushRecipients(sb: any, st: any): Promise<{ ids: string[]; names: string[] }> {
  const to = obj(st.to), people = (Array.isArray(to.people) ? to.people : []).map(String), roles = (Array.isArray(to.roles) ? to.roles : []).map(String);
  const list = await rows(sb.from("profiles").select("id, full_name, role"));
  // deno-lint-ignore no-explicit-any
  const chosen = list.filter((p: any) => people.includes(String(p.id)) || roles.includes(String(p.role)));
  // deno-lint-ignore no-explicit-any
  const ids = [...new Set(chosen.map((p: any) => String(p.id)))] as string[];
  // deno-lint-ignore no-explicit-any
  return { ids, names: ids.map((id) => (list.find((p: any) => String(p.id) === id) || {}).full_name || "").filter(Boolean) };
}
// deno-lint-ignore no-explicit-any
async function taskPeople(sb: any, st: any): Promise<string[]> {
  const ids = (Array.isArray(st.assignees) ? st.assignees : []).map(String);
  if (!ids.length) return [];
  const list = await rows(sb.from("employees").select("id, name, status").in("id", ids));
  // deno-lint-ignore no-explicit-any
  return ids.map((id: string) => list.find((e: any) => String(e.id) === id && e.status === "Active")).filter(Boolean).map((e: any) => String(e.name));
}
type Exec = { status: string; reason?: string; recipient?: string; ref?: string; detail?: Record<string, unknown> };
// The actions themselves. A customer action only runs after customerGuard said ok.
// deno-lint-ignore no-explicit-any
export async function execute(sb: any, st: any, a: any, f: Facts, T: TickCtx, nowMs: number, to: string): Promise<Exec> {
  const known = fieldsFor(f.type), vars = mergeVars(f, a), fill = (x: unknown) => fillMerge(String(x ?? ""), vars, known);
  const recordId = String((f.contact && f.kind === "contact" ? f.contact.id : (f.job || f.call || f.chat || {}).id) || "");
  if (st.type === "push") {
    const r = await pushRecipients(sb, st);
    const payload = { title: fill(st.title), body: fill(st.body || ""), url: APP_URL + (DEEP_LINK[f.kind] || ""), tag: `auto-${String(a.id).slice(0, 8)}-${recordId}` };
    const sent = await sendTo(sb, r.ids, payload, await vapidKeys(sb));
    return sent.sent > 0 ? { status: "sent", recipient: clip(r.names.join(", "), 200) } : { status: "failed", reason: "no device", recipient: clip(r.names.join(", "), 200) };
  }
  if (st.type === "task") {
    const names = await taskPeople(sb, st);
    const profiles = await rows(sb.from("profiles").select("id, full_name, role, technician_name"));
    const employees = names.length ? await rows(sb.from("employees").select("name, roles").eq("name", names[0])) : [];
    const c = f.contact;
    const row = {
      board: boardFor(names, profiles, employees), title: clip(fill(st.title), LIMITS.title), status: "Not Started",
      due: st.due_days == null ? null : shiftDay(zoneParts(nowMs, T.S.timezone).day, Number(st.due_days)),
      notes: clip(fill(st.notes || ""), LIMITS.notes), client: (c && c.full_name) || "", contact_id: c ? c.id : null,
      priority: TASK_PRIORITIES.includes(st.priority) ? st.priority : "Medium", assignees: names, assigned_to: names[0] || "", heads_up: "",
      created_by: clip("Automation: " + String(a.name || ""), 200), created_at: iso(nowMs), technician: "", category: c ? "Client-related" : "", subtasks: [], updates: [],
    };
    const { data, error } = await sb.from("tasks").insert(row).select("id").single();
    if (error) throw new Error(String(error.message || error));
    return { status: "sent", recipient: clip(names.join(", ") || "office board", 200), ref: data ? String(data.id) : undefined };
  }
  if (st.type === "email") {
    // The info@ mailbox sends it within a minute (conversations' alerts step adds the signature, from the author's first
    // word): plain text, the business's way out at the bottom, no signature here.
    const body = emailBody(fill(messageOf(st, T.cat) || ""), T.S), subject = fill(st.subject);
    const author = emailAuthor(T.S, a);
    if (!author) return { status: "skipped", reason: "no email signer set" };
    const { data, error } = await sb.from("lead_messages").insert({
      contact_id: f.contact.id, channel: "email", direction: "out", body, subject, author, auto: true, email: to, status: "queued", at: iso(nowMs),
    }).select("id").single();
    if (error) throw new Error(String(error.message || error));
    return { status: "queued", recipient: to, ref: data ? String(data.id) : undefined };
  }
  if (st.type === "text") return { status: "waiting_phone", reason: "waiting for the business phone", recipient: to };
  return { status: "failed", reason: "unknown action" };
}

// One log row per action, claimed BEFORE acting: a second claim (a retry after a crash) finds it and does nothing.
// deno-lint-ignore no-explicit-any
async function claimLog(sb: any, run: any, a: any, st: any, f: Facts | null, status: string, reason: string | null, nowMs: number, recipient: string | null = null): Promise<string | null> {
  const act = ACTIONS[st.type];
  const { data, error } = await sb.from("automation_log").insert({
    business_id: BUSINESS_ID, run_id: run.id, step_id: st.id, status, reason, channel: st.type, audience: act ? act.audience : "team",
    automation_id: a.id, automation_name: clip(a.name || "automation", LIMITS.name), record_kind: run.record_kind, record_id: run.record_id,
    contact_id: (f && f.contact && f.contact.id) || run.contact_id || null, recipient, at: iso(nowMs),
  }).select("id").single();
  if (error) { if (String(error.code) === "23505") return null; throw new Error(String(error.message || error)); }
  return data ? String(data.id) : null;
}
// A customer message's claim, in ONE database call that holds a lock on this customer (the card and each address): it
// counts this engine's messages of the last 24 hours (including any being sent right now by another call) and writes
// the 'sending' row only under the cap. Two calls at the same moment (the app's "look now" and the timer) can never both
// pass. → { id } | { capped: true } | { done: true } (already claimed before: never twice).
// deno-lint-ignore no-explicit-any
async function claimCustomer(sb: any, run: any, a: any, st: any, f: Facts, keys: string[], S: Settings, nowMs: number): Promise<{ id: string } | { capped: true } | { done: true }> {
  const { data, error } = await sb.rpc("automation_claim_customer", {
    p_business: BUSINESS_ID, p_run: run.id, p_step: st.id, p_automation: a.id, p_name: clip(a.name || "automation", LIMITS.name), p_channel: st.type,
    p_record_kind: run.record_kind, p_record_id: run.record_id, p_contact: f.contact.id, p_recipients: keys, p_since: iso(nowMs - DAY), p_cap: S.customer_daily_cap, p_now: iso(nowMs),
  });
  if (error) throw new Error(String(error.message || error));
  const r = String(data || "");
  if (r === "capped") return { capped: true };
  if (r.startsWith("claimed:")) return { id: r.slice(8) };
  return { done: true };
}

// When a customer message can't go now (customer hours): where the run waits and from which step it goes on then.
// It goes back over the conditions and earlier actions just before it (they are checked again then; an action that
// already ran never runs twice) and, when an "Only on" window comes before them, over that window too: the new time is
// the first moment inside both the window and the customer hours, or the run stops when the window says "skip" or the
// two never meet. Never back past a wait (that would wait again).
// deno-lint-ignore no-explicit-any
export function planDefer(steps: any[], i: number, deferMs: number, S: Settings, hoursCat: any): { at: number; back: number } | { skip: string } {
  let back = i, win = null;
  while (back > 0 && ["if", "action", "window"].includes(steps[back - 1].kind)) {
    back--;
    if (steps[back].kind === "window") { win = steps[back]; break; }
  }
  if (!win) return { at: deferMs, back };
  if (inWindow(deferMs, win, S.timezone, hoursCat)) return { at: deferMs, back };
  if (win.outside === "skip") return { skip: "outside the allowed days and hours (customer hours)" };
  const both = nextInBoth(deferMs, win, customerHours(S), S.timezone, hoursCat);
  return both === null ? { skip: "the window and the customer hours never meet" } : { at: both, back };
}

// How long a customer message may wait for its customer card (a job entered with the customer typed in is linked to its
// card a moment later; a missed call is matched to a card by the office).
const NO_CARD_WAIT_MS = 10 * 60e3, NO_CARD_RETRY_MS = 2 * 60e3;

// Moves one run as far as it can go now, writes where it got to and returns that patch.
// deno-lint-ignore no-explicit-any
export async function advance(sb: any, run: any, T: TickCtx, nowMs: number): Promise<Record<string, unknown>> {
  const nowIso = iso(nowMs), S = T.S, tz = S.timezone;
  const ctx = { ...obj(run.context) };
  let i = Number(run.step_index) || 0, anchor = Date.parse(run.anchor_at), dueAt = Date.parse(run.due_at);
  const base = () => ({ step_index: i, anchor_at: iso(anchor), lease_until: null, updated_at: nowIso, context: ctx });
  const end = (status: string, reason: string | null) => ({ ...base(), status, reason: reason ? clip(reason, 200) : null, due_at: run.due_at, finished_at: nowIso });
  const wait = (until: number, at: number) => { T.counts.deferred++; return { ...base(), step_index: at, status: "waiting", reason: null, due_at: iso(until), attempts: 0 }; };
  const write = async (patch: Record<string, unknown>) => { await sb.from("automation_runs").update(patch).eq("id", run.id); return patch; };
  // deno-lint-ignore no-explicit-any
  const stale = (x: any): string | null => {
    if (!x) return "automation deleted";
    if (x.enabled !== true) return "switched off";
    if (Number(x.version) !== Number(run.automation_version)) return "automation changed";
    // Switched off and on again since this event (armed_at moved): what happened before the switch-on never fires it.
    if (!x.armed_at || Date.parse(run.event_at) < Date.parse(x.armed_at)) return "switched off and on again since then";
    return null;
  };

  if (!T.autos.has(run.automation_id)) T.autos.set(run.automation_id, await readAutomation(sb, run.automation_id));
  const a = T.autos.get(run.automation_id);
  const gone = stale(a);
  if (gone) return await write(end("cancelled", gone));
  const problems = validateAutomation(a, T.cat);
  if (problems.length) return await write(end("failed", "invalid: " + problems.slice(0, 3).join("; ")));
  const f = await loadFacts(sb, run, T, nowMs);
  if (!f) return await write(end("cancelled", "record deleted"));
  if (Number(run.attempts) > 5) return await write(end("failed", "kept failing"));
  T.counts.processed++;
  const trig = TRIGGERS[a.trigger.type];
  const steps = a.steps;
  while (i < steps.length) {
    const st = steps[i];
    if (st.kind === "wait") {
      const until = planWait(anchor, st, tz);
      if (nowMs < until) return await write(wait(until, i));
      anchor = until; dueAt = until; i++; continue;
    }
    if (st.kind === "window") {
      if (ctx._pass === st.id || inWindow(nowMs, st, tz, T.cat)) { delete ctx._pass; anchor = nowMs; i++; continue; }
      if (st.outside === "skip") return await write(end("skipped", "outside the allowed days and hours"));
      const next = st.outside === "at" ? nextAt(nowMs, st, st.at, tz, T.cat) : nextAllowed(nowMs, st, tz, T.cat);
      if (next === null) return await write(end("skipped", "the window never opens"));
      ctx._pass = st.id;
      return await write(wait(next, i));
    }
    if (st.kind === "if") {
      const imp = trig.implicit.length ? await evalConds(sb, f, trig.implicit, "all") : { ok: true, failed: null };
      const r = imp.ok ? await evalConds(sb, f, st.conds, st.match) : imp;
      if (!r.ok) return await write(end("skipped", "condition: " + (r.failed || "not met")));
      i++; continue;
    }
    // an action
    const act = ACTIONS[st.type];
    if (trig.implicit.length) {
      const imp = await evalConds(sb, f, trig.implicit, "all");
      if (!imp.ok) return await write(end("skipped", "condition: " + (imp.failed || "not met")));
    }
    if (nowMs - dueAt > S.max_late_hours * HOUR) {
      if (await claimLog(sb, run, a, st, f, "skipped", "too late", nowMs)) T.counts.skipped++;
      i++; continue;
    }
    const { data: prior } = await sb.from("automation_log").select("id").eq("run_id", run.id).eq("step_id", st.id).limit(1);
    if (prior && prior.length) { i++; continue; }   // this action already ran (or was skipped) in an earlier pass
    if (act.audience === "customer") {
      // Double guard: the automation is read again right before anything goes to a customer.
      const fresh = await readAutomation(sb, a.id);
      const why = stale(fresh);
      if (why) return await write(end("cancelled", why));
      const skip = async (reason: string) => { if (await claimLog(sb, run, a, st, f, "skipped", reason, nowMs)) T.counts.skipped++; i++; };
      if (st.type === "email" && !emailAuthor(S, fresh)) { await skip("no email signer set"); continue; }
      const vars = mergeVars(f, a), known = fieldsFor(f.type);
      const texts = st.type === "email" ? [fillMerge(st.subject, vars, known), fillMerge(messageOf(st, T.cat) ?? "{template}", vars, known)] : [fillMerge(messageOf(st, T.cat) ?? "{template}", vars, known)];
      const g = await customerGuard(sb, S, f, st.type, nowMs, fresh, texts, T.cat);
      if ("skip" in g && g.skip === "no customer card" && nowMs - Date.parse(run.event_at) < NO_CARD_WAIT_MS) {
        // Not linked yet: look again in a moment (the conditions are checked again then too).
        const d = planDefer(steps, i, nowMs + NO_CARD_RETRY_MS, S, T.cat);
        if ("skip" in d) { await skip(d.skip); continue; }
        delete ctx._pass;
        return await write(wait(d.at, d.back));
      }
      if ("defer" in g) {
        const d = planDefer(steps, i, g.defer, S, T.cat);
        if ("skip" in d) { await skip(d.skip); continue; }
        delete ctx._pass;   // a window gone back over is checked again then
        return await write(wait(d.at, d.back));
      }
      if ("skip" in g) { await skip(g.skip); continue; }
      const c = await claimCustomer(sb, run, a, st, f, g.keys, S, nowMs);
      if ("capped" in c) { await skip("already contacted today"); continue; }
      if ("done" in c) { i++; continue; }   // claimed before (a retry): never twice
      let r: Exec;
      try { r = await execute(sb, st, fresh, f, T, nowMs, g.to); }
      catch (e) { r = { status: "failed", reason: clip(String((e as Error).message || e), 200) }; }
      await sb.from("automation_log").update({ status: r.status, reason: r.reason ? clip(r.reason, 200) : null, recipient: r.recipient || g.to, ref_id: r.ref || null }).eq("id", c.id);
      if (r.status === "queued") T.counts.queued++; else if (r.status === "sent") T.counts.sent++; else if (r.status === "skipped") T.counts.skipped++;
      i++; continue;
    }
    const logId = await claimLog(sb, run, a, st, f, "sending", null, nowMs);
    if (!logId) { i++; continue; }   // already done (or started) before: never twice
    let r: Exec;
    try { r = await execute(sb, st, a, f, T, nowMs, ""); }
    catch (e) { r = { status: "failed", reason: clip(String((e as Error).message || e), 200) }; }
    await sb.from("automation_log").update({ status: r.status, reason: r.reason ? clip(r.reason, 200) : null, recipient: r.recipient || null, ref_id: r.ref || null }).eq("id", logId);
    if (r.status === "sent") T.counts.sent++; else if (r.status === "queued") T.counts.queued++; else if (r.status === "skipped") T.counts.skipped++;
    i++;
  }
  return await write(end("done", null));
}

// Starts the runs of the automations that are ON for these events (once each: unique automation + event key).
export const ENQUEUE_MAX = 200;
// deno-lint-ignore no-explicit-any
export async function enqueue(sb: any, events: Ev[], automations: any[], nowMs: number, T: TickCtx): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const a of automations) {
    if (a.enabled !== true || !a.armed_at || (a.business_id && a.business_id !== BUSINESS_ID)) continue;
    if (validateAutomation(a, T.cat).length) continue;
    const t = obj(a.trigger), trig = TRIGGERS[t.type];
    for (const e of events) {
      if (e.type !== t.type || !trig.match(obj(t.params), e, nowMs, T.S.timezone)) continue;
      if (Date.parse(e.at) < Date.parse(a.armed_at)) continue;   // it happened before the automation was switched on (or last changed)
      if (trig.settleMs && nowMs - Date.parse(e.at) < trig.settleMs) continue;   // too fresh: the app's Undo may still take it back
      out.push({
        business_id: BUSINESS_ID, automation_id: a.id, automation_version: a.version, event_key: e.key, event_type: e.type, event_at: e.at,
        record_kind: e.recordKind, record_id: e.recordId, contact_id: e.contactId, status: "waiting", step_index: 0, anchor_at: e.at, due_at: e.at, context: e.ctx,
      });
    }
  }
  if (!out.length) return [];
  // Only the pairs that have no run yet, oldest first, at most ENQUEUE_MAX a call: the rest come next minute (the same
  // first 200 duplicates are never sent again and again while later events wait).
  const have = new Set<string>(), ids = [...new Set(out.map((r) => String(r.automation_id)))];
  const oldest = iso(Math.min(...out.map((r) => Date.parse(r.event_at))));
  for (let page = 0; page < 10; page++) {
    const got = await rows(sb.from("automation_runs").select("automation_id, event_key").in("automation_id", ids).gte("event_at", oldest).order("id").range(page * 1000, page * 1000 + 999));
    // deno-lint-ignore no-explicit-any
    got.forEach((r: any) => have.add(`${r.automation_id}|${r.event_key}`));
    if (got.length < 1000) break;
  }
  const list = out.filter((r) => !have.has(`${r.automation_id}|${r.event_key}`)).sort((x, y) => Date.parse(x.event_at) - Date.parse(y.event_at)).slice(0, ENQUEUE_MAX);
  if (!list.length) return [];
  const { data, error } = await sb.from("automation_runs").upsert(list, { onConflict: "automation_id,event_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(String(error.message || error));
  // deno-lint-ignore no-explicit-any
  return (data || []).map((r: any) => String(r.id));
}

// The emails handed to the info@ mailbox: sent → 'sent'. One the mailbox has not sent by the time the customer hours close
// (or within a day) is WITHDRAWN from the mailbox (its row stops being 'queued', only if it still is) and logged 'failed':
// a mailbox that comes back at 2 am never sends it then, and the log never says 'failed' for an email that went.
// deno-lint-ignore no-explicit-any
export async function reconcile(sb: any, nowMs: number, S: Settings = DEFAULT_SETTINGS, hoursCat: any = {}) {
  const list = await rows(sb.from("automation_log").select("id, ref_id, at").eq("business_id", BUSINESS_ID).eq("status", "queued").lte("at", iso(nowMs - 2 * 60e3)).order("at").limit(50));
  // deno-lint-ignore no-explicit-any
  const refs = list.map((l: any) => l.ref_id).filter(Boolean);
  if (!refs.length) return;
  const msgs = await rows(sb.from("lead_messages").select("id, status").in("id", refs));
  const open = inWindow(nowMs, customerHours(S), S.timezone, hoursCat);
  for (const l of list) {
    if (!l.ref_id) continue;
    // deno-lint-ignore no-explicit-any
    const m = msgs.find((x: any) => String(x.id) === String(l.ref_id));
    if (m && m.status === "sent") { await sb.from("automation_log").update({ status: "sent" }).eq("id", l.id); continue; }
    const tooOld = Date.parse(l.at) < nowMs - DAY;
    if (m && m.status === "queued" && open && !tooOld) continue;   // the mailbox still has time
    let reason = !m ? "the email is gone from the thread" : tooOld ? "not picked up by the mailbox" : "not sent within the customer hours (withdrawn)";
    if (m && m.status === "queued") {
      const { data: took } = await sb.from("lead_messages").update({ status: "failed" }).eq("id", m.id).eq("status", "queued").select("id");
      if (!took || !took.length) {
        // The mailbox took it a moment ago: it went (or is going) out.
        const { data: now } = await sb.from("lead_messages").select("status").eq("id", m.id).maybeSingle();
        if (now && now.status === "sent") { await sb.from("automation_log").update({ status: "sent" }).eq("id", l.id); continue; }
        reason = "the mailbox did not confirm it";
      }
    } else if (m) reason = `the mailbox marked it ${clip(m.status, 40)}`;
    await sb.from("automation_log").update({ status: "failed", reason }).eq("id", l.id);
  }
}
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== WAITS (stage 2, design §2.3, §3.5): when each wait card lets the run go on. Pure timing; a wait never sends.
// Times are in the business's time zone; days keep the wall-clock time across daylight saving (planWait).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A held wait whose moment can move (a record's date) or that waits for something to happen is looked at again at most
// this long after the last look (the "heartbeat"); such rechecks are claimed last (design §3.2).
export const HEARTBEAT_MS = 60 * 60e3;
// The window of a recurring wait in window mode ({ use, days, from, until }) as the phase-4 "Only on" window that
// inWindow / nextAllowed / nextAt / nextInBoth read.
// deno-lint-ignore no-explicit-any
export function wfWindow(w: any): any {
  const x = obj(w);
  if (x.use === "office" || x.use === "outsideOffice") return { mode: x.use };
  return { days: Array.isArray(x.days) ? x.days : [], from: x.from, until: x.until };
}
// "For a set period of time": the end of the wait counted from anchor (phase-4 planWait), then, with an advance window
// (resume: { days, from, until }), the first moment inside it. A window that never opens leaves the plain end.
// deno-lint-ignore no-explicit-any
export function periodUntil(anchorMs: number, cfg: any, tz: string, hoursCat: any): number {
  const c = obj(cfg), n = Number(c.n) || 0;
  const until = c.unit === "seconds" ? anchorMs + n * 1000 : planWait(anchorMs, { n, unit: c.unit }, tz);
  const r = obj(c.resume);
  if (!Array.isArray(r.days) || !r.days.length) return until;
  const next = nextAllowed(until, { days: r.days, from: r.from, until: r.until }, tz, hoursCat);
  return next === null ? until : next;
}
const lastDayOf = (day: string) => { const [y, m] = day.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const leapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// Is this business day one of a recurring wait's days ("times" mode)? weekly: its week days; monthly: its days of the
// month (-1 = the last day) or its nth week days (nth -1 = the last one of the month), only in its months when set;
// yearly: its date "MM-DD" (29 Feb is 28 Feb in a year without it).
// deno-lint-ignore no-explicit-any
export function recurrenceDay(day: string, cfg: any): boolean {
  const c = obj(cfg), [y, m, d] = day.split("-").map(Number), last = lastDayOf(day), dow = dowOf(day);
  const list = (x: unknown) => (Array.isArray(x) ? x : []) as number[];
  if (c.freq === "weekly") return list(c.days).includes(dow);
  if (c.freq === "monthly") {
    if (list(c.months).length && !list(c.months).includes(m)) return false;
    if (list(c.monthDays).length) return list(c.monthDays).includes(d) || (list(c.monthDays).includes(-1) && d === last);
    return list(c.days).includes(dow) && (list(c.nth).includes(Math.ceil(d / 7)) || (list(c.nth).includes(-1) && d + 7 > last));
  }
  if (c.freq === "yearly") {
    const mm = /^(\d{2})-(\d{2})$/.exec(String(c.date ?? "")); if (!mm) return false;
    const wm = Number(mm[1]), wd = Number(mm[2]);
    return m === wm && (d === wd || (wm === 2 && wd === 29 && !leapYear(y) && d === 28));
  }
  return false;
}
// "Until a recurring window opens" in times mode: the first occurrence at or after ms (its time 'at' on one of its
// days, business time zone), looking at most 400 days ahead; null when it never comes.
// deno-lint-ignore no-explicit-any
export function nextRecurrence(ms: number, cfg: any, tz: string): number | null {
  const at = hm(obj(cfg).at); if (at === null || at >= 1440) return null;
  const today = zoneParts(ms, tz).day;
  for (let k = 0; k <= 400; k++) {
    const day = shiftDay(today, k);
    if (!recurrenceDay(day, cfg)) continue;
    const t = zoneToUtc(day, Math.floor(at / 60), at % 60, tz);
    if (t >= ms) return t;
  }
  return null;
}
// A record's date value as a moment: a date-only value at dayTime (default 09:00), a timestamp as it is; else null.
export function dateValueMs(v: unknown, dayTime: unknown, tz: string): number | null {
  if (typeof v !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const t = hm(dayTime) ?? 540; return zoneToUtc(v, Math.floor(t / 60), t % 60, tz); }
  return okTime(v) ? Date.parse(v) : null;
}
// "Until a specific date/time" / "Until a scheduled date/time": the moment waited for, read from fresh facts (a
// record's date can move while the run waits), with on / at, before or after an offset (days keep the wall-clock time).
// null = there is no date (treated as passed).
// deno-lint-ignore no-explicit-any
export async function waitTarget(node: any, f: any, sb: any, tz: string): Promise<number | null> {
  const n = obj(node), c = obj(n.config);
  let t: number | null = null;
  const at = n.type === "date" && typeof c.at === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(c.at) : null;
  if (at) t = zoneToUtc(at[1], Number(at[2]), Number(at[3]), tz);
  else t = dateValueMs(await factValue(f, sb, { field: n.type === "date" ? c.ref : c.anchor }), c.dayTime, tz);
  if (t === null) return null;
  const off = obj(c.offset), k = Number(off.n) || 0;
  if ((c.when === "before" || c.when === "after") && k > 0) t = planWait(t, { n: c.when === "before" ? -k : k, unit: off.unit }, tz);
  return t;
}
// What a held wait listens for (automation_wake sets the run due when one of these events comes): a reply wait the
// replies, a date wait the events that move its date. Goals ahead and Stop on response are added by the executor.
// deno-lint-ignore no-explicit-any
export function waitWatch(node: any): string[] {
  const n = obj(node), c = obj(n.config), e = nodeEntry(n.kind, n.type);
  const field = n.type === "date" ? c.ref : n.type === "scheduled" ? c.anchor : null;
  return [...new Set([...((e && e.wakeOn) || []), ...(typeof field === "string" && WF_FIELDS[field] ? WF_FIELDS[field].wakeOn : [])])];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ==== EXECUTOR (stage 2, design §3.4–§3.8, §3.14): advanceV2 moves one run through the step tree. One executor, two
// adapters: realFx writes (log rows, claims, records, the run) and sends; simFx (the dry run, "Test workflow") records
// every write instead, previews every action and runs on a read-only client, so the path it shows is the path a real
// run takes. The phase-4 guard rails are the same code: customerGuard, the claim per (run, step, loop), planDefer (as
// planDeferTree), max_late_hours, the NO_CARD wait, the stage-move gate, the version / armed_at / switched-off checks.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Per advance call at most `budget` steps, then the run yields (waiting, due now); at most `perDay` steps a business day
// and `loopVisits` visits of one step without a hold in between, else the run fails "loop guard"; a dry run lists at
// most `pathEntries` rows.
export const WF_RUN_LIMITS = { budget: 50, perDay: 200, loopVisits: 10, pathEntries: 200 };
// The status of a run's last ("exit") log row, by how the run ended (automation_log has no "cancelled").
export const WF_EXIT_STATUS: Record<string, string> = nul({ done: "finished", skipped: "skipped", cancelled: "removed", failed: "failed", removed: "removed", stopped: "stopped" });
// The phase-4 channel words a migrated action keeps in the log (and in the cap's counts); others by their registry channel.
const V1_CHANNEL: Record<string, string> = nul({ internal_notification: "push", add_task: "task", send_email: "email", send_sms: "text" });
const V1_TYPE_OF: Record<string, string> = nul(Object.fromEntries(Object.entries(V1_ACTIONS).map(([v1, v2]) => [v2, v1])));
// deno-lint-ignore no-explicit-any
export function wfLogChannel(n: any): string {
  const t = String(obj(n).type ?? ""), e = has(WF_ACTIONS, t) ? WF_ACTIONS[t] : null;
  if (has(V1_CHANNEL, t)) return V1_CHANNEL[t];
  const ch = e && e.channel ? String(e.channel) : "record";
  return ch === "sms" ? "text" : ch;
}
// deno-lint-ignore no-explicit-any
const wfLogAudience = (n: any) => (has(WF_ACTIONS, obj(n).type) && WF_ACTIONS[obj(n).type].audience === "customer" ? "customer" : "team");
// deno-lint-ignore no-explicit-any
export const wfStepName = (n: any) => { const x = obj(n), e = nodeEntry(x.kind, x.type); return clip(String(x.name || (e ? e.label : x.type) || ""), LIMITS.name); };
// A migrated action in the phase-4 shape that execute / messageOf / the preview read ({ id, type: push|task|email|text, ... }).
// deno-lint-ignore no-explicit-any
export function v1Step(id: string, n: any): any { const x = obj(n), t = String(x.type ?? ""); return { ...obj(x.config), id, kind: "action", type: has(V1_TYPE_OF, t) ? V1_TYPE_OF[t] : t }; }

// The doc a row runs and its settings: the stored definition (schema 2), else its phase-4 trigger + steps through
// upgradeV1 (compat mode, ids kept), cached per row object (rows are read once per tick).
// deno-lint-ignore no-explicit-any
type RunDoc = { doc: any; settings: WfSettings; v1: boolean; idMap: Record<string, string>; C: Compiled; v1Ids: string[] };
const RUN_DOCS = new WeakMap<object, RunDoc>();
// deno-lint-ignore no-explicit-any
export function runDocOf(a: any): RunDoc {
  const hit = a && typeof a === "object" ? RUN_DOCS.get(a) : undefined;
  if (hit) return hit;
  const def = obj(a && a.definition);
  let r: RunDoc;
  if (def.schema === 2) r = { doc: def, settings: normWfSettings(obj(a).settings, obj(a).settings), v1: false, idMap: {}, C: compile(def), v1Ids: [] };
  else {
    const u = upgradeV1(a && a.trigger, a && a.steps);
    r = { doc: u.doc, settings: normWfSettings(u.settings, u.settings), v1: true, idMap: u.idMap, C: compile(u.doc), v1Ids: [] };
  }
  // the node id of each phase-4 step (a migrated row keeps its steps for 30 days: in-flight runs still point at them)
  // deno-lint-ignore no-explicit-any
  r.v1Ids = (Array.isArray(a && a.steps) ? a.steps : []).map((s: any) => { const id = String(obj(s).id ?? ""); return r.idMap[id] || id; });
  if (a && typeof a === "object") RUN_DOCS.set(a, r);
  return r;
}
// Where a run started by phase 4 (no cursor_step yet) is: steps[step_index] as its node id; past the last step = the
// end (null); no phase-4 steps = undefined (the run starts at its trigger's first step).
// deno-lint-ignore no-explicit-any
export function legacyCursor(run: any, v1Ids: string[]): string | null | undefined {
  const i = Number(obj(run).step_index);
  if (!v1Ids.length || !Number.isInteger(i) || i < 0) return undefined;
  return i >= v1Ids.length ? null : v1Ids[i];
}
// The phase-4 run checks, with the soft delete: → { text (the run's reason, phase-4 words), code (exit_reason) } | null.
// deno-lint-ignore no-explicit-any
export function staleV2(x: any, run: any): { text: string; code: string } | null {
  if (!x || x.deleted_at) return { text: "automation deleted", code: "deleted" };
  if (x.enabled !== true) return { text: "switched off", code: "switched_off" };
  if (Number(x.version) !== Number(run.automation_version)) return { text: "automation changed", code: "automation_changed" };
  // Switched off and on again since this event (armed_at moved): what happened before the switch-on never fires it.
  if (!x.armed_at || Date.parse(run.event_at) < Date.parse(x.armed_at)) return { text: "switched off and on again since then", code: "switched_off" };
  return null;
}

// The record and its lead card, read fresh (phase-4 loadFacts + the lead card's dates, tasks, contactless kinds).
// null = the record is gone. A run with no record of its own (inbound webhook, scheduler; suppliers and employees until
// their triggers come) gets the lead card when the run has one, else no card.
const CONTACT_COLS_V2 = CONTACT_COLS + ", booked_for, next_follow_up, lost_reason, estimated_value";
const TASK_COLS = "id, title, status, due, contact_id, assignees, priority, created_at";
// deno-lint-ignore no-explicit-any
export async function loadFactsV2(sb: any, run: any, T: TickCtx, nowMs: number, triggerId: string | null = null): Promise<any | null> {
  // deno-lint-ignore no-explicit-any
  const one = async (table: string, cols: string, id: unknown): Promise<any> => {
    const { data, error } = await sb.from(table).select(cols).eq("id", id).maybeSingle();
    if (error) throw new Error(String(error.message || error));
    return data || null;
  };
  // deno-lint-ignore no-explicit-any
  const f: any = { kind: run.record_kind, type: run.event_type, contact: null, job: null, call: null, chat: null, task: null, ctx: obj(run.context), eventAt: run.event_at,
    S: T.S, cat: T.cat, company: T.company, nowMs, agent: T.agent, triggerId };
  const kind = String(run.record_kind || ""), id = run.record_id;
  if (kind === "contact") { f.contact = await one("contacts", CONTACT_COLS_V2, id); return f.contact ? f : null; }
  const table = ({ job: "jobs", call: "calls", chat: "chat_sessions", task: "tasks" } as Record<string, string>)[kind];
  if (!table) { if (run.contact_id) f.contact = await one("contacts", CONTACT_COLS_V2, run.contact_id); return f; }
  const row = await one(table, kind === "job" ? JOB_COLS : kind === "call" ? CALL_COLS : kind === "chat" ? CHAT_COLS : TASK_COLS, id);
  if (!row) return null;
  f[kind] = row;
  if (row.contact_id) f.contact = await one("contacts", CONTACT_COLS_V2, row.contact_id);
  return f;
}

// Goals (design §3.6) come with G2.2: a goal type → is it met for these facts? Until an entry exists here no goal is
// ever met, and goalAhead never jumps.
// deno-lint-ignore no-explicit-any
export const WF_GOAL_MET: Record<string, (node: any, f: any, sb: any) => boolean | Promise<boolean>> = nul({});
// A met goal ahead of cur (out edges only, never through a Go to) → its id, else null.
// deno-lint-ignore no-explicit-any
async function goalAhead(C: Compiled, cur: string, f: any, sb: any): Promise<string | null> {
  for (const g of C.downstreamGoals(cur)) {
    const n = obj(C.nodes[g]), met = has(WF_GOAL_MET, n.type) ? WF_GOAL_MET[n.type] : null;
    if (met && await met(n, f, sb)) return g;
  }
  return null;
}

// planDefer (phase 4) on the node map (design §3.8): where a customer message that can't go now (customer hours) waits
// and from which step the run goes on then. It walks back from the action over the actions and If / else steps just
// above it (checked again then; an action that already ran never runs twice) and, when an "Only on" window (a recurring
// wait in window mode) comes before them, over that window too: the new time is the first moment inside both the window
// and the customer hours, or the message is skipped when the window says "end" or the two never meet. Never back past
// another wait, a Split or a Goal. No step limit (phase 4 has none): the walk ends at the top or at a node it has already
// seen (parents form a forest; the seen set only guards a broken map). On a phase-4 workflow it gives planDefer's
// { at, back } exactly.
// deno-lint-ignore no-explicit-any
export function planDeferTree(C: Compiled, cur: string, deferMs: number, S: Settings, hoursCat: any): { at: number; back: string } | { skip: string } {
  let back = cur;
  // deno-lint-ignore no-explicit-any
  let win: any = null;
  const seen = new Set<string>([cur]);
  for (;;) {
    const p = C.parent[back]; if (!p || seen.has(p.from)) break;
    seen.add(p.from);
    const pn = obj(C.nodes[p.from]);
    if (pn.kind === "action" || pn.kind === "if_else") { back = p.from; continue; }
    if (pn.kind === "wait" && pn.type === "recurring" && obj(pn.config).mode === "window") { back = p.from; win = obj(obj(pn.config).window); }
    break;
  }
  if (!win) return { at: deferMs, back };
  const w = wfWindow(win);
  if (inWindow(deferMs, w, S.timezone, hoursCat)) return { at: deferMs, back };
  if (win.outside === "end") return { skip: "outside the allowed days and hours (customer hours)" };
  const both = nextInBoth(deferMs, w, customerHours(S), S.timezone, hoursCat);
  return both === null ? { skip: "the window and the customer hours never meet" } : { at: both, back };
}

// ── the two adapters ──
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
export type ClaimArgs = { run: Row; a: Row; stepId: string; channel: string; contact: Row; keys: string[]; S: Settings; nowMs: number; loop: number };
export type Fx = {
  sim: boolean;
  readAutomation: (id: string) => Promise<Row | null>;
  log: (row: Row, wantId?: boolean) => Promise<string | null>;   // null = an action claim that already exists (never twice)
  updateLog: (id: string, patch: Row) => Promise<void>;
  priorAction: (runId: string, stepId: string, loop: number) => Promise<boolean>;
  claimCustomer: (p: ClaimArgs) => Promise<{ id: string } | { capped: true } | { done: true }>;
  // deno-lint-ignore no-explicit-any
  execute: (n: Row, st: Row, a: Row, f: any, T: TickCtx, nowMs: number, to: string) => Promise<Exec>;
  apply: (p: Row) => Promise<unknown>;        // automation_apply (G2.3 record actions)
  enroll: (p: Row) => Promise<unknown>;       // automation_enroll (G2.2 Add to workflow)
  removeRuns: (p: { contactId: string; automationId?: string | null }) => Promise<number>;   // G2.2 Remove from workflow
  writeRun: (run: Row, patch: Row) => Promise<void>;
  now: () => number;
};
// The automation_claim_customer_v2 contract (SQL Part 1, G1.3): the phase-4 parameters + p_loop. Same per-customer
// advisory locks; 'done' when an ACTION row of (run, step, loop) exists; the cap counts action rows only; the claimed
// row is row_kind 'action' with that loop. → 'claimed:<log id>' | 'capped' | 'done'.
const claimArgsOf = (p: ClaimArgs) => ({
  p_business: BUSINESS_ID, p_run: p.run.id, p_step: p.stepId, p_automation: p.a.id, p_name: clip(p.a.name || "automation", LIMITS.name), p_channel: p.channel,
  p_record_kind: p.run.record_kind, p_record_id: p.run.record_id, p_contact: p.contact.id, p_recipients: p.keys, p_since: iso(p.nowMs - DAY), p_cap: p.S.customer_daily_cap,
  p_now: iso(p.nowMs), p_loop: p.loop,
});
// deno-lint-ignore no-explicit-any
export function realFx(sb: any): Fx {
  return {
    sim: false,
    readAutomation: (id) => readAutomation(sb, id),
    log: async (row, wantId = true) => {
      const q = sb.from("automation_log").insert(row);
      const { data, error } = wantId ? await q.select("id").single() : await q;
      if (error) { if (String(error.code) === "23505") return null; throw new Error(String(error.message || error)); }
      return data ? String(data.id) : wantId ? null : "";
    },
    updateLog: async (id, patch) => { await sb.from("automation_log").update(patch).eq("id", id); },
    priorAction: async (runId, stepId, loop) => {
      const { data } = await sb.from("automation_log").select("id").eq("run_id", runId).eq("step_id", stepId).eq("row_kind", "action").eq("loop", loop).limit(1);
      return !!(data && data.length);
    },
    claimCustomer: async (p) => {
      const { data, error } = await sb.rpc("automation_claim_customer_v2", claimArgsOf(p));
      if (error) throw new Error(String(error.message || error));
      const r = String(data || "");
      if (r === "capped") return { capped: true };
      if (r.startsWith("claimed:")) return { id: r.slice(8) };
      return { done: true };
    },
    execute: (n, st, a, f, T, nowMs, to) => executeV2(sb, n, st, a, f, T, nowMs, to),
    apply: async (p) => { const { data, error } = await sb.rpc("automation_apply", p); if (error) throw new Error(String(error.message || error)); return data; },
    enroll: async (p) => { const { data, error } = await sb.rpc("automation_enroll", p); if (error) throw new Error(String(error.message || error)); return data; },
    removeRuns: async (p) => {
      let q = sb.from("automation_runs").update({ status: "removed", exit_reason: "removed_by_external_action", active_lock: null, finished_at: iso(io.now()) })
        .eq("business_id", BUSINESS_ID).eq("contact_id", p.contactId).eq("status", "waiting");
      if (p.automationId) q = q.eq("automation_id", p.automationId);
      const { data, error } = await q.select("id");
      if (error) throw new Error(String(error.message || error));
      return (data || []).length;
    },
    // only while it is still this call's run (a Remove from workflow or a cancel in between wins)
    writeRun: async (run, patch) => { await sb.from("automation_runs").update(patch).eq("id", run.id).eq("status", "running"); },
    now: () => io.now(),
  };
}
// The actions the v2 engine can run today: the four phase-4 ones (the same execute). G2.3 adds the record actions.
// deno-lint-ignore no-explicit-any
export async function executeV2(sb: any, n: Row, st: Row, a: Row, f: any, T: TickCtx, nowMs: number, to: string): Promise<Exec> {
  if (has(V1_TYPE_OF, obj(n).type)) return await execute(sb, st, a, f, T, nowMs, to);
  return { status: "failed", reason: "unknown action" };
}
// What an action would do (the dry run's execute): the filled message, recipients, board, subject and signature —
// read-only, the same words and people execute would use.
// deno-lint-ignore no-explicit-any
export async function previewAction(sb: any, n: Row, st: Row, a: Row, f: any, T: TickCtx, nowMs: number, to: string): Promise<Exec> {
  const known = fieldsFor(f.type), vars = mergeVars(f, a), fill = (x: unknown) => fillMerge(String(x ?? ""), vars, known);
  if (st.type === "push") {
    const r = await pushRecipients(sb, st);
    return { status: "would", recipient: clip(r.names.join(", "), 200), detail: { title: clip(fill(st.title), 500), body: clip(fill(st.body || ""), 500) } };
  }
  if (st.type === "task") {
    const names = await taskPeople(sb, st);
    const profiles = await rows(sb.from("profiles").select("id, full_name, role, technician_name"));
    const employees = names.length ? await rows(sb.from("employees").select("name, roles").eq("name", names[0])) : [];
    return { status: "would", recipient: clip(names.join(", ") || "office board", 200), detail: { board: boardFor(names, profiles, employees), title: clip(fill(st.title), LIMITS.title),
      notes: clip(fill(st.notes || ""), 500), due: st.due_days == null ? null : shiftDay(zoneParts(nowMs, T.S.timezone).day, Number(st.due_days)) } };
  }
  if (st.type === "email") {
    const author = emailAuthor(T.S, a);
    if (!author) return { status: "skipped", reason: "no email signer set" };
    return { status: "would", recipient: to, detail: { subject: fill(st.subject), body: clip(emailBody(fill(messageOf(st, T.cat) || ""), T.S), 500), signature: signatureOf(author, bizOf(T.company, T.cat)) } };
  }
  if (st.type === "text") return { status: "waiting_phone", reason: "waiting for the business phone", recipient: to };
  void n;
  return { status: "failed", reason: "unknown action" };
}
// A write the dry run's read-only client refused: the dry run answers { ok: false, reason: "internal: write attempted" },
// never a step verdict.
export class SimulationWriteError extends Error {
  constructor(what: string) { super("internal: write attempted (" + what + ")"); this.name = "SimulationWriteError"; }
}
// Stable read-only RPCs a dry run may call (none needed yet).
export const SIM_READ_RPCS: string[] = [];
// A select-only view of the client: insert / update / upsert / delete and every RPC not on the list throw.
// deno-lint-ignore no-explicit-any
export function readOnlySb(sb: any): any {
  const WRITES = ["insert", "update", "upsert", "delete"];
  return {
    from: (table: string) => {
      const q = sb.from(table);
      // deno-lint-ignore no-explicit-any
      return new Proxy(q, { get: (t: any, p: string | symbol) => (typeof p === "string" && WRITES.includes(p)) ? () => { throw new SimulationWriteError(`${table}.${p}`); } : (typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    },
    rpc: (name: string, args: unknown) => { if (!SIM_READ_RPCS.includes(name)) throw new SimulationWriteError("rpc " + name); return sb.rpc(name, args); },
  };
}
// The dry run's adapter: every write is recorded (rows = the log rows the run would write, writes = everything else),
// every action previewed. The daily cap counts the database's messages (read-only) plus the ones this dry run "sent".
// deno-lint-ignore no-explicit-any
export function simFx(ro: any, a: Row): Fx & { rows: Row[]; writes: Row[] } {
  const rows: Row[] = [], writes: Row[] = [];
  let k = 0;
  const isAct = (r: Row, run: unknown, step: unknown, loop: unknown) => r.row_kind === "action" && r.run_id === run && r.step_id === step && (Number(r.loop) || 0) === (Number(loop) || 0);
  const add = (row: Row) => { const id = `sim-${++k}`; rows.push({ id, ...row }); return id; };
  return {
    sim: true, rows, writes,
    readAutomation: async () => a,
    log: async (row) => (row.row_kind === "action" && rows.some((r) => isAct(r, row.run_id, row.step_id, row.loop)) ? null : add(row)),
    updateLog: async (id, patch) => { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); },
    priorAction: async (runId, stepId, loop) => rows.some((r) => isAct(r, runId, stepId, loop)),
    claimCustomer: async (p) => {
      if (rows.some((r) => isAct(r, p.run.id, p.stepId, p.loop))) return { done: true };
      const since = p.nowMs - DAY, cap = Math.max(Number(p.S.customer_daily_cap) || 1, 1);
      const mine = rows.filter((r) => r.row_kind === "action" && r.audience === "customer" && !["skipped", "failed"].includes(r.status) && Date.parse(r.at) >= since
        && ((p.contact.id && r.contact_id === p.contact.id) || p.keys.includes(r.recipient))).length;
      if (mine + await recentAutoMessages(ro, p.contact, p.keys, p.nowMs, cap) >= cap) return { capped: true };
      return { id: add({ business_id: BUSINESS_ID, run_id: p.run.id, step_id: p.stepId, row_kind: "action", loop: p.loop, status: "sending", channel: p.channel, audience: "customer",
        automation_id: p.a.id, automation_name: clip(p.a.name || "automation", LIMITS.name), record_kind: p.run.record_kind, record_id: p.run.record_id, contact_id: p.contact.id,
        recipient: p.keys[0] || null, at: iso(p.nowMs) }) };
    },
    execute: (n, st, a2, f, T, nowMs, to) => previewAction(ro, n, st, a2, f, T, nowMs, to),
    apply: async (p) => { writes.push({ op: "apply", ...p }); return "would"; },
    enroll: async (p) => { writes.push({ op: "enroll", ...p }); return "would"; },
    removeRuns: async (p) => { writes.push({ op: "removeRuns", ...p }); return 0; },
    writeRun: async (_run, patch) => { writes.push({ op: "run", status: patch.status, due_at: patch.due_at, cursor_step: patch.cursor_step }); },
    now: () => io.now(),
  };
}

// Moves one run as far as it can go now through its workflow's step tree, writes where it got to (the run row) and
// returns that patch. A v1 row runs through upgradeV1 with the phase-4 words, order and checks (compat mode, design
// §3.16): the same log rows for actions, the same run reasons and due_at. Every log row carries row_kind, seq (= the
// run's steps so far), loop (= the Go to passes so far: one action claim per run, step and loop), version, revision,
// trigger_id, step_type and step_name; a run that ends writes one "exit" row.
// deno-lint-ignore no-explicit-any
export async function advanceV2(sb: any, run: any, T: TickCtx, nowMs: number, fx: Fx = realFx(sb)): Promise<Record<string, unknown>> {
  const nowIso = iso(nowMs), S = T.S, tz = S.timezone, today = zoneParts(nowMs, tz).day;
  const ctx: Row = { ...obj(run.context) };
  let anchor = Date.parse(run.anchor_at), dueAt = Date.parse(run.due_at);
  if (Number.isNaN(anchor)) anchor = Date.parse(run.event_at);
  let loop = Number(run.loop) || 0, stepsDone = Number(run.steps_done) || 0, stepsToday = run.steps_day === today ? Number(run.steps_today) || 0 : 0;
  let visits: Record<string, number> = { ...obj(run.visits) };
  let firstSentAt: string | null = run.first_sent_at || null;
  // deno-lint-ignore no-explicit-any
  let a: any = null, R: RunDoc | null = null, f: any = null, trigId: string | null = run.trigger_id || null;
  let started = false, cur: string | null = null, lastNode: string | null = run.cursor_step || null;
  const stepIndex = () => {
    if (!started || !R || !R.v1Ids.length) return Number(run.step_index) || 0;
    if (cur === null) return R.v1Ids.length;
    const i = R.v1Ids.indexOf(cur);
    return i >= 0 ? i : Number(run.step_index) || 0;
  };
  const base = () => ({
    step_index: stepIndex(), anchor_at: iso(anchor), lease_until: null, updated_at: nowIso, context: ctx,
    cursor_step: started ? cur : (run.cursor_step ?? null), loop, visits, steps_done: stepsDone, steps_today: stepsToday, steps_day: today,
    ...(firstSentAt ? { first_sent_at: firstSentAt } : {}),
  });
  // The id a log row, a claim and the window pass of a phase-4 row carry: its phase-4 step id (G1.4 compat). upgradeV1
  // gives a step whose id is not a valid v2 id a fresh node id; the claims and pass marks phase 4 wrote (and a rollback
  // build reads) use the old one, so an action claimed on one side of the switch is never claimed again on the other.
  let v1IdOf: Record<string, string> = {};
  const sid = (id: string) => (has(v1IdOf, id) ? v1IdOf[id] : id);
  // deno-lint-ignore no-explicit-any
  const rowBase = (id: string, n: any): Row => ({
    business_id: BUSINESS_ID, run_id: run.id, step_id: sid(id), automation_id: (a && a.id) || run.automation_id, automation_name: clip((a && a.name) || "automation", LIMITS.name),
    record_kind: run.record_kind, record_id: run.record_id, contact_id: (f && f.contact && f.contact.id) || run.contact_id || null, at: nowIso,
    step_type: n ? String(obj(n).type ?? "") || null : null, step_name: n ? wfStepName(n) : null, loop, seq: stepsDone,
    version: a ? a.version ?? null : null, revision: a ? a.revision ?? null : null, trigger_id: trigId,
  });
  // a step row never stops the run (an action claim does: it is the never-twice guard)
  // deno-lint-ignore no-explicit-any
  const stepRow = async (id: string, n: any, status: string, x: Row = {}) => {
    try { await fx.log({ ...rowBase(id, n), row_kind: "step", status, reason: null, channel: null, audience: null, ...x }, false); }
    catch (e) { console.error("automation step log failed:", clip(String((e as Error).message || e), 200)); }
  };
  // deno-lint-ignore no-explicit-any
  const claim = (id: string, n: any, status: string, reason: string | null, recipient: string | null = null) =>
    fx.log({ ...rowBase(id, n), row_kind: "action", status, reason, channel: wfLogChannel(n), audience: wfLogAudience(n), recipient });
  const end = async (status: string, reason: string | null, code: string) => {
    const patch = { ...base(), status, reason: reason ? clip(reason, 200) : null, due_at: run.due_at, finished_at: nowIso, exit_reason: code, watch: null, recheck: false };
    await fx.writeRun(run, patch);
    const at = (started ? cur : null) ?? lastNode;
    try {
      await fx.log({ ...rowBase(at || "end", at && R ? R.C.nodes[at] : null), row_kind: "exit", status: WF_EXIT_STATUS[status] || "finished", reason: clip(has(WF_REASONS, code) ? WF_REASONS[code] : (reason || code), 200),
        channel: null, audience: null, detail: { exit_reason: code, run_reason: reason } }, false);
    } catch (e) { console.error("automation exit log failed:", clip(String((e as Error).message || e), 200)); }
    return patch;
  };
  const hold = async (until: number, at: string | null, o: { watch: string[]; recheck?: boolean; keepVisits?: boolean }) => {
    T.counts.deferred++;
    cur = at;
    if (!o.keepVisits) visits = {};
    const patch = { ...base(), status: "waiting", reason: null, due_at: iso(until), attempts: 0, watch: o.watch, recheck: !!o.recheck };
    await fx.writeRun(run, patch);
    return patch;
  };

  if (!T.autos.has(run.automation_id)) T.autos.set(run.automation_id, await fx.readAutomation(run.automation_id));
  a = T.autos.get(run.automation_id);
  const gone = staleV2(a, run);
  if (gone) return await end("cancelled", gone.text, gone.code);
  R = runDocOf(a);
  if (R.v1) v1IdOf = nul(Object.fromEntries(Object.entries(R.idMap).map(([old, node]) => [node, old])));
  const C = R.C, settings = R.settings;
  if (!trigId) trigId = (R.doc.triggers && R.doc.triggers[0] && R.doc.triggers[0].id) || null;
  // A v1 row is checked with the phase-4 rules (the same refusals and words); a doc with the structure validator
  // (availability never fails a run: an unavailable step only skips).
  const problems = R.v1 ? validateAutomation(a, T.cat) : validateStructure(R.doc, { maxSteps: wfMaxSteps(T.cat) }).filter((i) => i.severity === "error").map((i) => `${i.path || "/"}: ${i.text}`);
  if (problems.length) return await end("failed", "invalid: " + problems.slice(0, 3).join("; "), "invalid");
  f = await loadFactsV2(sb, run, T, nowMs, trigId);
  if (!f) return await end("cancelled", "record deleted", "record_deleted");
  if (Number(run.attempts) > 5) return await end("failed", "kept failing", "kept_failing");
  T.counts.processed++;

  // where the run is: its cursor, else (started by phase 4) its step_index, else its trigger's first step. A phase-4 row's
  // cursor counts only while it agrees with step_index (this engine keeps the two together): a run phase 4 moved on
  // after a rollback and a redeploy goes on from step_index, never from an old cursor (G1.4 compat).
  const cursorOk = typeof run.cursor_step === "string" && !!run.cursor_step && !(R.v1 && R.v1Ids.includes(run.cursor_step) && R.v1Ids.indexOf(run.cursor_step) !== Number(run.step_index));
  if (cursorOk) cur = run.cursor_step;
  else { const l = legacyCursor(run, R.v1Ids); cur = l === undefined ? C.first(trigId) : l; }
  started = true;
  if (cur !== null && !has(C.nodes, cur)) { const lost = cur; cur = null; lastNode = null; return await end("failed", `invalid: the step ${lost} is gone`, "invalid"); }
  const avail = T.avail || availCtxOf({}, T.cat);
  // the trigger's own run-time gates (phase 4): the stage move still stands, the chat is still unanswered
  const implicit = has(TRIGGERS, run.event_type) ? TRIGGERS[run.event_type].implicit : [];
  const condEnv: CondEnv = { nowMs, tz, list: (field) => { const s = has(WF_FIELDS, field) ? WF_FIELDS[field].source : undefined; return s && s.startsWith("catalog.") ? catList(T.cat, s.slice(8)) : []; } };
  // deno-lint-ignore no-explicit-any
  const evalC = (cond: any) => evalCondition(cond, (r) => factValue(f, sb, r), condEnv);
  const implicitOk = async () => implicit.length ? await evalC({ match: "all", segments: [{ match: "all", rules: implicit }] }) : { ok: true, failed: null, conds: [] as CondDetail[] };
  const stopWatch = settings.stopOnResponse ? ["customer_replied"] : [];
  const watchFor = (id: string, own: string[] = []) => [...new Set([...own, ...C.downstreamGoals(id).flatMap((g) => { const e = nodeEntry("goal", obj(C.nodes[g]).type); return (e && e.wakeOn) || []; }), ...stopWatch])];
  // deno-lint-ignore no-explicit-any
  const portOf = (n: any, port: string): string | null => { const t = obj(obj(n).out)[port]; return typeof t === "string" && has(C.nodes, t) ? t : null; };
  // deno-lint-ignore no-explicit-any
  type Res = { go: string | null } | { done: Record<string, unknown> };
  // the step already counted: the cursor of a run that has made steps (a new run enrolled at its start step, or one
  // phase 4 started, has counted nothing yet)
  let at: string | null = cursorOk && stepsDone > 0 ? run.cursor_step : null;
  // a jump (a goal reached ahead; a date wait's "go to", which starts a new pass like a Go to step: the steps it comes
  // back to claim again under the next loop number); the target always counts as a move
  // deno-lint-ignore no-explicit-any
  const jump = async (from: string, n: any, to: string, detail: Row, newPass: boolean): Promise<string> => {
    await stepRow(from, n, "jumped", { detail: { to, ...detail } });
    if (newPass) loop++;
    at = null;
    return to;
  };

  // ── waits (§3.5) ──
  // deno-lint-ignore no-explicit-any
  const waitNode = async (id: string, n: any): Promise<Res> => {
    const c = obj(n.config), w = obj(ctx._w), first = !(w.id === id && Number(w.loop) === loop);
    if (ctx._skipComms && ctx._skipComms !== id) delete ctx._skipComms;   // "messages skipped until the next wait"
    const release = async (outcome: string, port = "next", x: Row = {}): Promise<Res> => {
      await stepRow(id, n, "wait_finished", { detail: { outcome, resumed_by: first ? "now" : "timer", ...x } });
      delete ctx._w;
      return { go: portOf(n, port) };
    };
    const holdAt = async (until: number, target: number, recheck = false): Promise<Res> => {
      // the waiting row once; the moment itself follows the record (a date wait's date can move)
      if (first) { ctx._w = { id, loop, startedAt: nowIso, until: iso(target) }; await stepRow(id, n, "waiting", { next_at: iso(target) }); }
      else ctx._w = { ...w, until: iso(target) };
      return { done: await hold(until, id, { watch: watchFor(id, waitWatch(n)), recheck }) };
    };
    if (n.type === "period") {
      const until = periodUntil(anchor, c, tz, T.cat);
      if (nowMs < until) return await holdAt(until, until);
      anchor = until; dueAt = until;
      return await release("time");
    }
    if (n.type === "recurring" && c.mode === "window") {
      // phase-4 "Only on" (the same logic and words)
      const x = obj(c.window), win = wfWindow(x);
      // The pass mark lets the run through only once the hold it set is due: a run woken early (automation_wake: a watched
      // event) looks at the window again and holds again. A mark without this hold's time (written by phase 4) is trusted.
      const passed = ctx._pass === sid(id) && (first || !okTime(w.until) || nowMs >= Date.parse(String(w.until)));
      if (passed || inWindow(nowMs, win, tz, T.cat)) { delete ctx._pass; anchor = nowMs; return await release("time"); }
      if (x.outside === "end") { await stepRow(id, n, "wait_finished", { detail: { outcome: "passed", resumed_by: "now" } }); return { done: await end("skipped", "outside the allowed days and hours", "outside_hours") }; }
      const next = x.outside === "at" ? nextAt(nowMs, win, x.at, tz, T.cat) : nextAllowed(nowMs, win, tz, T.cat);
      if (next === null) return { done: await end("skipped", "the window never opens", "window_never_opens") };
      ctx._pass = sid(id);
      return await holdAt(next, next);
    }
    if (n.type === "recurring") {
      const until = first ? nextRecurrence(nowMs, c, tz) : Date.parse(String(w.until));
      if (until === null || Number.isNaN(until)) return { done: await end("skipped", "the window never opens", "window_never_opens") };
      if (nowMs < until) return await holdAt(until, until);
      anchor = until; dueAt = until;
      return await release("time");
    }
    if (n.type === "date" || n.type === "scheduled") {
      const target = await waitTarget(n, f, sb, tz);
      if (target !== null && (target > nowMs || !first)) {
        if (target > nowMs) return await holdAt(Math.min(target, nowMs + HEARTBEAT_MS), target, target > nowMs + HEARTBEAT_MS);
        anchor = target; dueAt = target;
        return await release("time");
      }
      // passed (or no date): "If the date has passed"
      anchor = nowMs; dueAt = nowMs;
      const how = c.ifPassed, detail = { target: target === null ? null : iso(target) };
      if (how === "end") { await stepRow(id, n, "wait_finished", { detail: { outcome: "passed", resumed_by: "now", ...detail } }); delete ctx._w; return { done: await end("skipped", "the date has passed", "date_passed") }; }
      if (how === "goto" && typeof c.gotoStep === "string" && has(C.nodes, c.gotoStep)) { await release("passed", "next", detail); return { go: await jump(id, n, c.gotoStep, { why: "date passed" }, true) }; }
      if (how === "skip_comms") { const r = await release("passed", "next", detail); ctx._skipComms = id; return r; }
      return await release("passed", "next", detail);
    }
    return { done: await end("failed", `not supported yet: wait ${String(n.type)}`, "unsupported") };
  };

  // ── If / else (§3.6; a migrated phase-4 "if" is a gate: an empty None ends the run skipped) ──
  // deno-lint-ignore no-explicit-any
  const ifNode = async (id: string, n: any): Promise<Res> => {
    const c = obj(n.config), imp = await implicitOk();
    if (!imp.ok) return { done: await end("skipped", "condition: " + (imp.failed || "not met"), "condition") };
    // deno-lint-ignore no-explicit-any
    let chosen: any = null, failed: string | null = null, conds: CondDetail[] = [];
    for (const b of (Array.isArray(c.branches) ? c.branches : []).map(obj)) {
      const r = await evalC(b.when); conds = r.conds;
      if (r.ok) { chosen = b; break; }
      failed = r.failed;
    }
    const port = chosen ? String(chosen.id) : "none", to = portOf(n, port);
    await stepRow(id, n, "branch", { detail: { branch_id: port, branch_name: chosen ? String(chosen.name || "Branch") : String(c.noneName || "None"),
      conds: conds.map((x) => ({ label: x.label, received: Array.isArray(x.received) ? x.received.slice(0, 10) : typeof x.received === "string" ? clip(x.received, 100) : x.received, expected: x.expected, ok: x.ok })) } });
    if (!chosen && c.gate === true && to === null) return { done: await end("skipped", "condition: " + (failed || "not met"), "condition") };
    return { go: to };
  };

  // ── actions (§3.8; phase-4 order: the trigger's gates, too late, claimed before, then the customer guard) ──
  // deno-lint-ignore no-explicit-any
  const actionNode = async (id: string, n: any): Promise<Res> => {
    const e = has(WF_ACTIONS, n.type) ? WF_ACTIONS[n.type] : null;
    if (!e) return { done: await end("failed", `not supported yet: action ${String(n.type)}`, "unsupported") };
    const st = v1Step(id, n), next: Res = { go: portOf(n, "next") };
    const skip = async (reason: string): Promise<Res> => { if (await claim(id, n, "skipped", reason)) T.counts.skipped++; return next; };
    if (implicit.length) { const imp = await implicitOk(); if (!imp.ok) return { done: await end("skipped", "condition: " + (imp.failed || "not met"), "condition") }; }
    if (nowMs - dueAt > S.max_late_hours * HOUR) return await skip("too late");
    if (await fx.priorAction(run.id, sid(id), loop)) return next;   // this action already ran (or was skipped) in an earlier pass
    // a text keeps the phase-4 path (guard, claim, "waiting_phone"); any other unavailable step only skips
    if (n.type !== "send_sms") { const av = e.available(avail); if (!av.ok) return await skip("unavailable: " + (av.reason || "not available")); }
    if (ctx._skipComms && e.outbound) return await skip(WF_REASONS.skip_comms);
    if (e.audience === "customer") {
      // Double guard: the automation is read again right before anything goes to a customer.
      const fresh = await fx.readAutomation(a.id);
      const why = staleV2(fresh, run);
      if (why) return { done: await end("cancelled", why.text, why.code) };
      const channel = n.type === "send_email" ? "email" : n.type === "send_sms" ? "text" : "";
      if (!channel) return await skip("unavailable: not in this engine yet");
      if (channel === "email" && !emailAuthor(S, fresh)) return await skip("no email signer set");
      const vars = mergeVars(f, a), known = fieldsFor(f.type);
      const texts = channel === "email" ? [fillMerge(st.subject, vars, known), fillMerge(messageOf(st, T.cat) ?? "{template}", vars, known)] : [fillMerge(messageOf(st, T.cat) ?? "{template}", vars, known)];
      const g = await customerGuard(sb, S, f, channel, nowMs, fresh, texts, T.cat);
      const defer = async (ms: number): Promise<Res> => {
        const d = planDeferTree(C, id, ms, S, T.cat);
        if ("skip" in d) return await skip(d.skip);
        delete ctx._pass;   // a window gone back over is checked again then
        return { done: await hold(d.at, d.back, { watch: watchFor(d.back) }) };
      };
      // Not linked to a card yet: look again in a moment (the conditions are checked again then too).
      if ("skip" in g && g.skip === "no customer card" && nowMs - Date.parse(run.event_at) < NO_CARD_WAIT_MS) return await defer(nowMs + NO_CARD_RETRY_MS);
      if ("defer" in g) return await defer(g.defer);
      if ("skip" in g) return await skip(g.skip);
      const cl = await fx.claimCustomer({ run, a, stepId: sid(id), channel, contact: f.contact, keys: g.keys, S, nowMs, loop });
      if ("capped" in cl) return await skip("already contacted today");
      if ("done" in cl) return next;   // claimed before (a retry): never twice
      let r: Exec;
      try { r = await fx.execute(n, st, fresh, f, T, nowMs, g.to); }
      catch (err) { if (err instanceof SimulationWriteError) throw err; r = { status: "failed", reason: clip(String((err as Error).message || err), 200) }; }
      await fx.updateLog(cl.id, { status: r.status, reason: r.reason ? clip(r.reason, 200) : null, recipient: r.recipient || g.to, ref_id: r.ref || null, ...(r.detail ? { detail: r.detail } : {}),
        step_type: n.type, step_name: wfStepName(n), seq: stepsDone, version: a.version ?? null, revision: a.revision ?? null, trigger_id: trigId });
      if (r.status === "queued") T.counts.queued++; else if (r.status === "sent") T.counts.sent++; else if (r.status === "skipped") T.counts.skipped++;
      if (["queued", "sent", "would"].includes(r.status) && !firstSentAt) firstSentAt = nowIso;
      return next;
    }
    const logId = await claim(id, n, "sending", null);
    if (!logId) return next;   // already done (or started) before: never twice
    let r: Exec;
    try { r = await fx.execute(n, st, a, f, T, nowMs, ""); }
    catch (err) { if (err instanceof SimulationWriteError) throw err; r = { status: "failed", reason: clip(String((err as Error).message || err), 200) }; }
    await fx.updateLog(logId, { status: r.status, reason: r.reason ? clip(r.reason, 200) : null, recipient: r.recipient || null, ref_id: r.ref || null, ...(r.detail ? { detail: r.detail } : {}) });
    if (r.status === "sent") T.counts.sent++; else if (r.status === "queued") T.counts.queued++; else if (r.status === "skipped") T.counts.skipped++;
    return next;
  };

  let moves = 0;
  while (cur !== null) {
    const g = await goalAhead(C, cur, f, sb);
    if (g) {
      if (obj(ctx._w).id === cur) delete ctx._w;
      const up = C.ancestors(g);   // the steps passed over: from just below cur down to the goal
      cur = await jump(cur, C.nodes[cur], g, { goal: true, skipped: up.slice(0, Math.max(0, up.indexOf(cur))).reverse() }, false);
      continue;
    }
    const id: string = cur, n = obj(C.nodes[id]);
    if (id !== at) {
      // a new step: the counters move (never on a recheck of the same held wait)
      at = id; lastNode = id; stepsDone++; stepsToday++; visits[id] = (visits[id] || 0) + 1; moves++;
      // A phase-4 row (compat) can't loop, and its customer-hours deferrals walk back over the same steps: phase 4 had no
      // such guard, so it never stops one (differential gate, design §8.3).
      if (!(R && R.v1Ids.length) && (stepsToday > WF_RUN_LIMITS.perDay || visits[id] > WF_RUN_LIMITS.loopVisits)) return await end("failed", "loop guard", "loop_guard");
      if (moves > WF_RUN_LIMITS.budget) return await hold(nowMs, id, { watch: watchFor(id), keepVisits: true });   // yield: the rest next call
    }
    if (n.disabled === true) { await stepRow(id, n, "skipped", { reason: WF_REASONS.paused_step }); cur = portOf(n, "next"); continue; }
    let r: Res;
    if (n.kind === "wait") r = await waitNode(id, n);
    else if (n.kind === "if_else") r = await ifNode(id, n);
    else if (n.kind === "action") r = await actionNode(id, n);
    else r = { done: await end("failed", `not supported yet: ${String(n.kind)} ${String(n.type)}`, "unsupported") };
    if ("done" in r) return r.done;
    cur = r.go;
  }
  return await end("done", null, "end_of_workflow");
}

// The path a run took, from its log rows in the order they were written (the dry run and a real run give the same).
export function wfPathOfRows(list: Row[]): Row[] {
  return list.map((r) => {
    const d = obj(r.detail);
    return { stepId: r.step_id, rowKind: r.row_kind ?? "action", type: r.step_type ?? null, status: r.status, reason: r.reason ?? null, at: r.at,
      ...(r.next_at ? { until: r.next_at } : {}), ...(d.branch_id ? { branchId: d.branch_id } : {}), ...(d.outcome ? { outcome: d.outcome } : {}), ...(d.to ? { target: d.to } : {}),
      ...(r.recipient ? { to: r.recipient } : {}), ...(r.row_kind === "action" && Object.keys(d).length ? { preview: d } : {}) };
  });
}
// The dry run core (design §3.14; step:"test" around it comes with G6.1): runs the workflow for one record with simFx
// on a read-only client, the clock jumping to each hold's moment. The workflow is treated as published (a Draft can be
// tested). → { ok, ended, reason, path, rows, writes } | { ok: false, reason: "internal: write attempted" }.
// deno-lint-ignore no-explicit-any
export async function dryRunV2(sb: any, automation: Row, runIn: Row, T: TickCtx, nowMs: number, maxEntries = WF_RUN_LIMITS.pathEntries) {
  const ro = readOnlySb(sb);
  const run: Row = { id: "dry-run", automation_id: automation.id, automation_version: automation.version ?? 1, event_key: "dry-run", status: "running", attempts: 1,
    context: {}, anchor_at: runIn.event_at, due_at: runIn.event_at, step_index: 0, cursor_step: null, ...runIn };
  const a = { ...automation, enabled: true, deleted_at: null, version: run.automation_version, armed_at: run.event_at };
  const T2: TickCtx = { ...T, autos: new Map([[String(run.automation_id), a]]), counts: newCounts() };
  const fx = simFx(ro, a);
  let clock = nowMs, ended = "";
  try {
    for (let k = 0; k < 2000; k++) {
      Object.assign(run, await advanceV2(ro, run, T2, clock, fx));
      if (fx.rows.length > maxEntries) { ended = "step_limit"; break; }
      if (run.status !== "waiting") { ended = run.exit_reason === "loop_guard" ? "loop_guard" : String(run.status); break; }
      const w = obj(obj(run.context)._w), next = w.id === run.cursor_step && okTime(w.until) ? Date.parse(w.until) : Date.parse(run.due_at);
      clock = Math.max(clock, next);
      run.status = "running"; run.attempts = 1;
    }
    if (!ended) ended = "step_limit";
  } catch (e) {
    if (e instanceof SimulationWriteError) return { ok: false, reason: "internal: write attempted" };
    throw e;
  }
  return { ok: true, ended, reason: run.reason ?? null, path: wfPathOfRows(fx.rows), rows: fx.rows, writes: fx.writes, run };
}

// Once a day: finished runs older than 90 days and log rows older than 180 days go.
// deno-lint-ignore no-explicit-any
async function prune(sb: any, nowMs: number, tz: string) {
  const today = zoneParts(nowMs, tz).day;
  const { data } = await sb.from("automation_state").select("pruned_on").eq("business_id", BUSINESS_ID).maybeSingle();
  if (data && data.pruned_on === today) return false;
  await sb.from("automation_runs").delete().eq("business_id", BUSINESS_ID).lt("finished_at", iso(nowMs - 90 * DAY));
  await sb.from("automation_log").delete().eq("business_id", BUSINESS_ID).lt("at", iso(nowMs - 180 * DAY));
  await sb.from("automation_state").update({ pruned_on: today }).eq("business_id", BUSINESS_ID);
  return true;
}

// ==== COMPAT (stage 2 phase 1, design §3.16 and §7 G1.4): the compat switch. Until the event store comes (G2.1) the
// timer and "look now" keep phase 4's scanners + enqueue (the same events, the same five event-key formats, so nothing
// fires again) and run every claimed run with advanceV2 (io.advance; a phase-4 row through upgradeV1). Before SQL
// Part 1 is applied there is no automation_state.phase4_compat column and nowhere for the v2 rows to go: phase 4's own
// advance runs then, so this build is safe on either side of Part 1. Any other failure of the read stops this tick (the
// next minute tries again); it never guesses. Phase 7 removes this section with advance / enqueue.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// v2 = the v2 executor runs the runs; compat = the phase-4 scanners + enqueue start them (always, until G2.1 adds the
// event store and reads phase4_compat = false as "use it"); why = the line written to the function's log on a change.
export type EngineMode = { v2: boolean; compat: boolean; why: string };
// PostgREST's answers for a column that does not exist (Postgres 42703; the schema cache's PGRST204)
const NO_COLUMN = new Set(["42703", "PGRST204"]);
let ENGINE_SAID = "";
// deno-lint-ignore no-explicit-any
export async function engineMode(sb: any): Promise<EngineMode> {
  const { data, error } = await sb.from("automation_state").select("phase4_compat").eq("business_id", BUSINESS_ID).maybeSingle();
  let m: EngineMode;
  if (error) {
    const msg = String(error.message || error);
    if (!NO_COLUMN.has(String(error.code)) && !/phase4_compat.*(does not exist|could not find)|(does not exist|could not find).*phase4_compat/i.test(msg)) throw new Error("automation_state not read: " + clip(msg, 200));
    m = { v2: false, compat: true, why: "phase-4 executor (stage 2 SQL Part 1 not applied yet)" };
  } else if (data && data.phase4_compat === false) m = { v2: true, compat: true, why: "v2 executor; phase4_compat is off but this build has no event store yet: phase-4 scanners + enqueue kept" };
  else m = { v2: true, compat: true, why: "v2 executor in compat mode (phase-4 scanners + enqueue, runs by advanceV2)" };
  if (m.why !== ENGINE_SAID) { ENGINE_SAID = m.why; console.log("automations engine: " + m.why); }
  return m;
}
// The executor of a mode: advanceV2 through the io seam (the tests swap it), else phase 4's advance.
// deno-lint-ignore no-explicit-any
export const executorOf = (m: EngineMode): ((sb: any, run: any, T: TickCtx, nowMs: number) => Promise<Record<string, unknown>>) => (m.v2 ? io.advance : advance);

// The timer, every minute.
// deno-lint-ignore no-explicit-any
export async function tick(sb: any, nowMs: number) {
  const nowIso = iso(nowMs);
  const { data: got, error: lockErr } = await sb.rpc("automation_tick_lock", { p_business: BUSINESS_ID, p_now: nowIso, p_seconds: 55 });
  if (lockErr) throw new Error(String(lockErr.message || lockErr));
  if (!got) return { ok: true, busy: true };
  const started = io.now();
  try {
    const mode = await engineMode(sb), exec = executorOf(mode);
    const T = await loadContext(sb, nowMs);
    // the stored public holidays, worked out again when they run short or the region changed (never stops the run)
    try { const h = await refreshHolidays(sb, T.cat, nowMs); if (h && h !== "off" && h !== "tried") console.log(`automations: public holidays worked out again (${h})`); }
    catch (e) { console.error("automations: public holidays not worked out:", clip(String((e as Error).message || e), 200)); }
    const autos = await enabledAutomations(sb);
    for (const a of autos) T.autos.set(String(a.id), a);
    const valid = autos.filter((a) => !validateAutomation(a, T.cat).length);
    if (valid.length) {
      const sinceMs = nowMs - T.S.lookback_hours * HOUR;
      const events: Ev[] = [];
      for (const type of [...new Set(valid.map((a) => String(obj(a.trigger).type)))]) {
        // One trigger's table failing (e.g. before its SQL is run) does not stop the others.
        try { events.push(...await TRIGGERS[type].scan(sb, sinceMs, nowMs, T.S)); }
        catch (e) { console.error(`automations scan ${type} failed:`, clip(String((e as Error).message || e), 200)); }
      }
      T.counts.events = events.length;
      T.counts.enqueued = (await enqueue(sb, events, valid, nowMs, T)).length;
    }
    const { data: due, error: claimErr } = await sb.rpc("automation_claim_due", { p_business: BUSINESS_ID, p_now: nowIso, p_limit: 25, p_lease_seconds: 120 });
    if (claimErr) throw new Error(String(claimErr.message || claimErr));
    const claimed = due || [];
    for (let k = 0; k < claimed.length; k++) {
      const run = claimed[k];
      if (io.now() - started > 40e3) {
        // Out of time: the rest go back to the queue as they were (this claim does not count as a try).
        for (const r of claimed.slice(k)) await sb.from("automation_runs").update({ status: "waiting", lease_until: null, attempts: Math.max(0, Number(r.attempts) - 1) }).eq("id", r.id).eq("status", "running");
        break;
      }
      // A crash in one run leaves it 'running' until its lease ends; it is tried again then (at most 5 times).
      try { await exec(sb, run, T, nowMs); } catch (e) { console.error("automation run failed:", clip(String((e as Error).message || e), 200)); }
    }
    await reconcile(sb, nowMs, T.S, T.cat);
    await prune(sb, nowMs, T.S.timezone);
    return { ok: true, engine: mode.v2 ? "v2-compat" : "phase4", ...T.counts };
  } finally {
    await sb.from("automation_state").update({ tick_lease_until: null }).eq("business_id", BUSINESS_ID);
  }
}

// ── the app's "look now" (an event it has just saved) ──
// deno-lint-ignore no-explicit-any
export function canEmit(me: any, type: string): boolean {
  if (!me || !TRIGGERS[type]) return false;
  if (me.role === "owner" || me.role === "manager") return true;
  return me.role === "va" && !!obj(me.permissions)[TRIGGERS[type].permission];
}
const isOffice = (me: { role?: string } | null) => !!me && (me.role === "owner" || me.role === "manager");

// deno-lint-ignore no-explicit-any
async function eventStep(sb: any, body: any, me: any, nowMs: number) {
  const type = String(body.type || ""), id = String(body.id ?? "").trim();
  if (!TRIGGERS[type] || !id || id.length > 100) return { status: 400, body: { ok: false, reason: "unknown event" } };
  if (!canEmit(me, type)) return { status: 403, body: { ok: false, reason: "not allowed" } };
  const trig = TRIGGERS[type];
  const { data: row, error } = await sb.from(trig.table).select(trig.cols).eq("id", id).maybeSingle();
  if (error || !row) return { status: 404, body: { ok: false, reason: "not found" } };
  const T = await loadContext(sb, nowMs);
  const e = trig.fromRecord(row, T.S);
  if (!e) return { status: 200, body: { ok: true, runs: 0, reason: "no event" } };
  if (Date.parse(e.at) < nowMs - T.S.lookback_hours * HOUR) return { status: 200, body: { ok: true, runs: 0, reason: "old" } };
  if (trig.settleMs && nowMs - Date.parse(e.at) < trig.settleMs) return { status: 200, body: { ok: true, runs: 0, reason: "settling" } };   // the timer takes it once it settled
  const autos = await enabledAutomations(sb);
  for (const a of autos) T.autos.set(String(a.id), a);
  const exec = executorOf(await engineMode(sb));
  const ids = await enqueue(sb, [e], autos, nowMs, T);
  const statuses: string[] = [];
  for (const rid of ids.slice(0, 10)) {
    // Taken only if still waiting (a tick may have it already).
    const { data: mine } = await sb.from("automation_runs").update({ status: "running", lease_until: iso(nowMs + 120e3), attempts: 1, updated_at: iso(nowMs) }).eq("id", rid).eq("status", "waiting").select("*");
    if (!mine || !mine[0]) continue;
    const p = await exec(sb, mine[0], T, nowMs);
    statuses.push(String(p.status));
  }
  return { status: 200, body: { ok: true, runs: ids.length, statuses } };
}

// ── preview: what an automation would do for one record (writes nothing, sends nothing) ──
// deno-lint-ignore no-explicit-any
async function previewStep(sb: any, body: any, me: any, nowMs: number) {
  if (!isOffice(me)) return { status: 403, body: { ok: false, reason: "owners and managers only" } };
  const T = await loadContext(sb, nowMs);
  // deno-lint-ignore no-explicit-any
  let a: any = body.automation && typeof body.automation === "object" ? body.automation : null;
  if (!a && body.automation_id) a = await readAutomation(sb, String(body.automation_id));
  if (!a) return { status: 404, body: { ok: false, reason: "automation not found" } };
  a = { id: a.id || "preview", name: String(a.name || ""), enabled: a.enabled === true, trigger: obj(a.trigger), steps: a.steps, version: a.version || 1,
    created_by_name: String(a.created_by_name || (body.automation ? me.full_name : "") || "") };
  const problems = validateAutomation(a, T.cat);
  if (problems.length) return { status: 200, body: { ok: false, problems, steps: [] } };
  const rec = obj(body.record), kind = String(rec.kind || ""), rid = String(rec.id || "");
  const trig = TRIGGERS[a.trigger.type];
  // deno-lint-ignore no-explicit-any
  let e: Ev | null = null;
  if (kind === trig.recordKind && rid) {
    const { data: row } = await sb.from(trig.table).select(trig.cols).eq("id", rid).maybeSingle();
    if (row) e = trig.fromRecord(row, { ...T.S, ignore_test_records: false });
  }
  const run = { record_kind: kind, record_id: rid, event_type: a.trigger.type, event_at: e ? e.at : iso(nowMs), context: e ? e.ctx : {} };
  const f = ["contact", "job", "call", "chat"].includes(kind) && rid ? await loadFacts(sb, run, T, nowMs) : null;
  if (!f) return { status: 200, body: { ok: false, problems: ["record not found"], steps: [] } };
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  const tz = T.S.timezone, vars = mergeVars(f, a), known = fieldsFor(f.type);
  let at = nowMs, stopped = "";
  for (const st of a.steps) {
    if (stopped) { out.push({ id: st.id, kind: st.kind, would: "not reached" }); continue; }
    if (st.kind === "wait") { at = planWait(at, st, tz); out.push({ id: st.id, kind: "wait", would: "wait", until: iso(at) }); continue; }
    if (st.kind === "window") {
      if (inWindow(at, st, tz, T.cat)) { out.push({ id: st.id, kind: "window", would: "go on" }); continue; }
      if (st.outside === "skip") { stopped = "outside the allowed days and hours"; out.push({ id: st.id, kind: "window", would: "skip", reason: stopped }); continue; }
      const next = st.outside === "at" ? nextAt(at, st, st.at, tz, T.cat) : nextAllowed(at, st, tz, T.cat);
      if (next === null) { stopped = "the window never opens"; out.push({ id: st.id, kind: "window", would: "skip", reason: stopped }); continue; }
      at = next; out.push({ id: st.id, kind: "window", would: "wait", until: iso(at) }); continue;
    }
    if (st.kind === "if") {
      const imp = trig.implicit.length ? await evalConds(sb, f, trig.implicit, "all") : { ok: true, failed: null };
      const r = imp.ok ? await evalConds(sb, f, st.conds, st.match) : imp;
      if (!r.ok) stopped = "condition: " + (r.failed || "not met");
      out.push({ id: st.id, kind: "if", would: r.ok ? "go on" : "skip", reason: r.ok ? undefined : stopped });
      continue;
    }
    const act = ACTIONS[st.type];
    if (st.type === "push") {
      const r = await pushRecipients(sb, st);
      out.push({ id: st.id, kind: "action", type: "push", would: "send", to: r.names, title: fillMerge(st.title, vars, known), body: fillMerge(st.body || "", vars, known) });
    } else if (st.type === "task") {
      const names = await taskPeople(sb, st);
      const profiles = await rows(sb.from("profiles").select("id, full_name, role, technician_name"));
      const employees = names.length ? await rows(sb.from("employees").select("name, roles").eq("name", names[0])) : [];
      out.push({ id: st.id, kind: "action", type: "task", would: "add", board: boardFor(names, profiles, employees), assignees: names, title: fillMerge(st.title, vars, known), notes: fillMerge(st.notes || "", vars, known),
        due: st.due_days == null ? null : shiftDay(zoneParts(at, tz).day, Number(st.due_days)) });
    } else {
      const msg = messageOf(st, T.cat);
      const texts = st.type === "email" ? [fillMerge(st.subject, vars, known), fillMerge(msg ?? "{template}", vars, known)] : [fillMerge(msg ?? "{template}", vars, known)];
      const author = st.type === "email" ? emailAuthor(T.S, a) : "";
      const g = st.type === "email" && !author ? { skip: "no email signer set" } : await customerGuard(sb, T.S, f, st.type, at, { ...a, enabled: true }, texts, T.cat);
      const verdict = "defer" in g ? { would: "wait", until: iso(g.defer) } : "skip" in g ? { would: "skip", reason: g.skip } : { would: st.type === "text" ? "wait for the business phone" : "queue", to: g.to };
      out.push({ id: st.id, kind: "action", type: st.type, audience: act.audience, ...verdict, ...(st.type === "email" ? { subject: texts[0], body: emailBody(texts[1], T.S), signature: author ? signatureOf(author, bizOf(T.company, T.cat)) : "" } : { body: texts[0] }),
        ...(a.enabled ? {} : { note: "this automation is off: nothing is sent" }) });
    }
  }
  return { status: 200, body: { ok: true, problems: [], steps: out } };
}

// The lists the builder shows (labels only: no code, no secrets).
export function registry() {
  return {
    triggers: Object.entries(TRIGGERS).map(([type, t]) => ({ type, label: t.label, recordKind: t.recordKind, params: t.params, implicit: t.implicit, fields: fieldsFor(type) })),
    conditions: Object.entries(CONDITIONS).map(([field, c]) => ({ field, label: c.label, ops: c.ops, valueSource: c.valueSource, appliesTo: c.appliesTo, ...(c.n ? { n: c.n } : {}), ...(c.gate ? { gate: true } : {}) })),
    actions: Object.entries(ACTIONS).map(([type, x]) => ({ type, label: x.label, audience: x.audience, available: x.available, needs: x.needs })),
    mergeFields: Object.entries(MERGE_FIELDS).map(([key, m]) => ({ key, label: m.label, events: m.events })),
    stepKinds: STEP_KINDS, waitUnits: Object.entries(WAIT_UNITS).map(([unit, u]) => ({ unit, max: u.max })), windowModes: ["office", "outsideOffice"], outside: ["next", "skip", "at"],
    limits: LIMITS, maxSteps: 30,
  };
}

// me = { id, full_name, role, permissions } of the signed-in caller, or null. secretOk = the timer's header matched.
// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, me: any, secretOk: boolean) {
  const step = String((body && body.step) || "");
  const nowMs = io.now();
  if (step === "tick") {
    if (!secretOk) return { status: 401, body: { ok: false, reason: "unauthorized" } };
    io.waitUntil(tick(sb, nowMs).catch((e) => { console.error("automations tick failed:", clip(String((e as Error).message || e), 300)); }));
    return { status: 202, body: { ok: true } };
  }
  if (!me) return { status: 401, body: { ok: false, reason: "unauthorized" } };
  if (step === "event") return await eventStep(sb, body, me, nowMs);
  if (step === "preview") return await previewStep(sb, body, me, nowMs);
  if (step === "registry") return isOffice(me) ? { status: 200, body: { ok: true, ...registry() } } : { status: 403, body: { ok: false, reason: "owners and managers only" } };
  return { status: 400, body: { ok: false, reason: "unknown step" } };
}

// The signed-in person (profile), or null.
// deno-lint-ignore no-explicit-any
async function caller(sb: any, req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role, permissions").eq("id", u.user.id).single();
  return p || null;
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__AUTO_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "Could not parse request body" }, 400); }
    try {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const secretOk = sameSecret(String(req.headers.get("x-automations-secret") || ""), env("AUTOMATIONS_CRON_SECRET"));
      const me = body && body.step === "tick" ? null : await caller(sb, req);
      const r = await handle(sb, body, me, secretOk);
      return json(r.body, r.status);
    } catch (e) {
      // Only the message: never secrets or the body.
      console.error("automations failed:", clip(String((e as Error).message || e), 300));
      return json({ ok: false, reason: "server" }, 500);
    }
  });
}
