// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ROLLBACK BUILD of the automations function (stage 2 phase 1, design §3.16 and §7 G1.4). NOT a function of its own:
// NEVER deploy this folder by name (no `supabase functions deploy automations-phase4-compat`, no "deploy all"). In a
// rollback, paste this file into the EXISTING `automations` function in the dashboard editor (Verify JWT OFF), then
// check the fingerprint — .claude/sql/stage2-part1-RUNBOOK.md, "Rollback".
//
// = the phase-4 engine exactly as live before stage 2 (commit a8c6d2d, supabase/functions/automations/index.ts: phase 4 with
//   stage 5's quiet imports and stage 3's vacations, live since 15 Oct) with
// three edits so it runs safely on the stage-2 schema (SQL Part 1 kept) AND on the phase-4 schema (Part 1 rolled back):
//   1. "already done" check (advance): only ACTION log rows count. The v2 engine also writes step / exit / enroll rows
//      into automation_log (row_kind), and a step row with the same step id must never stop an action. Read with
//      select("*") and filtered here, so the same code works where the row_kind column does not exist (a phase-4 row is
//      an action row).
//   2. a soft-deleted automation (deleted_at, stage 2) counts as deleted (no such column = nothing changes).
//   3. channel words: this build writes and reads the phase-4 words only (push / task / email / text), which Part 1's
//      automation_log_channel_v2 accepts; the cap and "asked lately" count customer rows by audience and status, never
//      by channel or row kind (step / exit / enroll rows have no audience). Nothing to map — kept as is, on purpose.
// Everything else (scanners, enqueue, guards, claims through automation_claim_customer — Part 1 keeps it as a wrapper
// with loop 0 —, reconcile, prune, preview) is byte for byte the phase-4 code. Its tests: tests.ts here (the phase-4
// suite + the rollback cases at the end), run by check_all.sh.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
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
//   • People on vacation (stage 3): a notification skips them and goes to their stand-in when chosen; a task for them goes
//     to the stand-in when they are not assignable.
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

// ── vacations (stage 3): ONE block, byte-identical in push, automations and voice (automations' tests check) ──
// A vacation is a row of employee_vacations (.claude/sql/stage3-vacation.sql). Who is away is worked out here the same way
// as the app (vacationOnDay) and SQL (vacation_in_force): options.autoBack is ON unless it is the boolean false, every other
// key only when it is the boolean true; starts_on = the first day away, ends_on = the last; in force on a day when not
// cancelled, from starts_on, before the business day it was ended on, and up to ends_on unless autoBack is off. The day is
// in the business time zone the caller passes (bizTzOf(catalog), the region block). A login is the employee whose name is
// its technician_name, else its full_name (the app's peopleList). FAIL-OPEN: no table, an error or a throw = nobody is
// away, and the log says "vacations not read: ..." (so a broken read is visible, never silent).
export const VAC_COLS = "id, employee_id, starts_on, ends_on, stand_in_id, options, ended_at, cancelled_at, reminded_at";
// deno-lint-ignore no-explicit-any
export type VacCtx = { day: string; tz: string; vacs: any[]; employees: any[]; profiles: any[] };
const vacIsDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
// deno-lint-ignore no-explicit-any
export function vacOpt(v: any, key: string): boolean {
  const o = v && v.options && typeof v.options === "object" ? v.options : {};
  return key === "autoBack" ? o.autoBack !== false : o[key] === true;
}
// deno-lint-ignore no-explicit-any
export function vacOnDay(v: any, day: string, tz: string): boolean {
  if (!v || v.cancelled_at || !vacIsDay(v.starts_on) || !vacIsDay(day) || v.starts_on > day) return false;
  if (v.ended_at) { const t = Date.parse(v.ended_at); if (isNaN(t) || !(day < bizParts(t, tz).day)) return false; }
  return !vacOpt(v, "autoBack") || (vacIsDay(v.ends_on) && day <= v.ends_on);
}
// deno-lint-ignore no-explicit-any
export function vacEmployeeOf(p: any, employees: any[]): any {
  if (!p) return null;
  return (p.technician_name && employees.find((e) => e.name === p.technician_name)) || (p.full_name && employees.find((e) => e.name === p.full_name)) || null;
}
// deno-lint-ignore no-explicit-any
export function vacProfilesOf(e: any, C: VacCtx): any[] {
  if (!e) return [];
  return C.profiles.filter((p) => { const x = vacEmployeeOf(p, C.employees); return !!x && x.id === e.id; });
}
// The vacation in force today for this employee with that option ticked (the latest start when two are), or null.
// deno-lint-ignore no-explicit-any
export function vacAway(C: VacCtx, employeeId: string, key: string): any {
  // deno-lint-ignore no-explicit-any
  let best: any = null;
  for (const v of C.vacs) if (v.employee_id === employeeId && vacOnDay(v, C.day, C.tz) && vacOpt(v, key) && (!best || v.starts_on > best.starts_on)) best = v;
  return best;
}
// deno-lint-ignore no-explicit-any
export function vacAwayProfile(C: VacCtx, profileId: string, key: string): any {
  const e = vacEmployeeOf(C.profiles.find((p) => p.id === profileId), C.employees);
  return e ? vacAway(C, e.id, key) : null;
}
// Who gets a notification: in order, once each. Away with "No notifications" → left out; away with "A stand-in gets their
// notifications" → the stand-in's logins too (an Active stand-in; one who is away too passes it on, at most 5 steps, never
// in a loop). A login with no employee card is always kept. roles: the roles that kind may go to (money and private
// details: ["owner"]); a stand-in's login with another role never gets it. Left out = any role.
export function vacRecipients(ids: string[], C: VacCtx, roles?: string[]): string[] {
  if (!C.vacs.length) return [...new Set(ids)];
  const out: string[] = [], seen = new Set<string>();
  const visit = (id: string, steps: number) => {
    if (!id || seen.has(id)) return;
    // deno-lint-ignore no-explicit-any
    if (steps && roles && !roles.includes(String((C.profiles.find((p: any) => p.id === id) || {}).role))) return;
    seen.add(id);
    const e = vacEmployeeOf(C.profiles.find((p) => p.id === id), C.employees);
    if (!e) { out.push(id); return; }
    if (!vacAway(C, e.id, "noNotify")) out.push(id);
    const v = vacAway(C, e.id, "standIn");
    if (!v || !v.stand_in_id || steps >= 5) return;
    const s = C.employees.find((x) => x.id === v.stand_in_id);
    if (!s || (s.status && s.status !== "Active")) return;
    for (const p of vacProfilesOf(s, C)) visit(p.id, steps + 1);
  };
  for (const id of ids) visit(id, 0);
  return out;
}
// The day n days after a 'YYYY-MM-DD' day.
export const vacShiftDay = (day: string, n: number): string => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// The vacations that can be in force from today to aheadDays on (started by then, and not over before today: ends_on from
// today on, or left open with autoBack off), and the people they need, read once. Nobody away = no more reads. A vacation
// that is over is never read again, so the table can grow without slowing a call down.
// tz: the business time zone (the caller's bizTzOf(catalog)).
// deno-lint-ignore no-explicit-any
export async function vacContext(sb: any, nowMs: number, tz: string, aheadDays = 0): Promise<VacCtx> {
  const empty: VacCtx = { day: bizParts(nowMs, tz).day, tz, vacs: [], employees: [], profiles: [] };
  // deno-lint-ignore no-explicit-any
  const why = (e: any) => (e && (e.message || e.code)) || String(e);
  try {
    const { data: vacs, error } = await sb.from("employee_vacations").select(VAC_COLS).is("cancelled_at", null).is("ended_at", null)
      .lte("starts_on", vacShiftDay(empty.day, aheadDays)).or(`ends_on.gte.${empty.day},options->>autoBack.eq.false`);
    if (error) { console.error("vacations not read: employee_vacations:", why(error)); return empty; }
    if (!Array.isArray(vacs) || !vacs.length) return empty;
    const [emps, profs] = await Promise.all([sb.from("employees").select("id, name, phone, status"), sb.from("profiles").select("id, full_name, technician_name, role")]);
    if (emps.error || profs.error) { console.error("vacations not read:", emps.error ? "employees: " + why(emps.error) : "profiles: " + why(profs.error)); return empty; }
    return { ...empty, vacs, employees: emps.data || [], profiles: profs.data || [] };
  } catch (e) {
    console.error("vacations not read:", why(e));
    return empty;
  }
}
// ── end vacations ──

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
const SCAN_CONTACT_COLS = "id, status, tags, created_at, reopened_at, stage_changed_at, linked_job_id, first_at:messages->0->>at, first_quiet:messages->0->>quiet, import_quiet";
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
// A card the MCP import made with automations off (the column import_quiet; older imports: quiet on its first thread
// entry): its arrival is not a new lead. A later reopen is a real new arrival and counts as usual. (mcp/index.ts importRow.)
// deno-lint-ignore no-explicit-any
export const quietArrival = (c: any): boolean => c.import_quiet === true || String(c.first_quiet ?? (Array.isArray(c.messages) && c.messages[0] ? c.messages[0].quiet : "") ?? "") === "true";
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
      if (!c.reopened_at && quietArrival(c)) return null;
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
// deno-lint-ignore no-explicit-any
export function applyOp(op: string, value: unknown, c: any, list: any[] = []): boolean {
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
  }
  return false;   // never reached for a valid automation (validateAutomation refuses unknown ops)
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
// The engine
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// deno-lint-ignore no-explicit-any
export type TickCtx = { S: Settings; cat: any; company: string; agent?: string; autos: Map<string, any>; counts: Record<string, number>; vac?: VacCtx };
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
// Who is on vacation, read once per tick (the vacations block; fail-open). A year ahead too: a task is checked against its
// due day, at most 365 days on.
// deno-lint-ignore no-explicit-any
async function vacOf(sb: any, T: TickCtx, nowMs: number): Promise<VacCtx> { return T.vac || (T.vac = await vacContext(sb, nowMs, bizTzOf(T.cat), 366)); }
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
// chosen: how many logins were picked before the vacations (all of them away = "skipped: on vacation", not "no device").
// deno-lint-ignore no-explicit-any
async function pushRecipients(sb: any, st: any, C: VacCtx): Promise<{ ids: string[]; names: string[]; chosen: number }> {
  const to = obj(st.to), people = (Array.isArray(to.people) ? to.people : []).map(String), roles = (Array.isArray(to.roles) ? to.roles : []).map(String);
  const list = await rows(sb.from("profiles").select("id, full_name, role"));
  // deno-lint-ignore no-explicit-any
  const chosen = list.filter((p: any) => people.includes(String(p.id)) || roles.includes(String(p.role)));
  // someone on vacation: skipped, or their stand-in instead (stage 3). A stand-in only gets it when their role could have
  // been picked: the roles chosen, or those of the people chosen (an owners-only message never reaches a technician).
  // deno-lint-ignore no-explicit-any
  const allowed = [...new Set([...roles, ...list.filter((p: any) => people.includes(String(p.id))).map((p: any) => String(p.role))])];
  // deno-lint-ignore no-explicit-any
  const ids = vacRecipients([...new Set(chosen.map((p: any) => String(p.id)))] as string[], C, allowed);
  // deno-lint-ignore no-explicit-any
  return { ids, names: ids.map((id) => (list.find((p: any) => String(p.id) === id) || {}).full_name || "").filter(Boolean), chosen: chosen.length };
}
// day: the task's due day ('YYYY-MM-DD'; today when it has none), as the app checks it (saveTaskModal, tm-due). moved: who
// was swapped for their stand-in (the task's note says so).
// deno-lint-ignore no-explicit-any
async function taskPeople(sb: any, st: any, C: VacCtx, day?: string): Promise<{ names: string[]; moved: VacMove[] }> {
  const ids = (Array.isArray(st.assignees) ? st.assignees : []).map(String), moved: VacMove[] = [];
  if (!ids.length) return { names: [], moved };
  const list = await rows(sb.from("employees").select("id, name, status").in("id", ids));
  // deno-lint-ignore no-explicit-any
  return { names: vacTaskPeople(ids.map((id: string) => list.find((e: any) => String(e.id) === id && e.status === "Active")).filter(Boolean), C, day, moved), moved };
}
export type VacMove = { from: string; to: string };
// A task for someone on vacation with "Not assignable" on its due day (today without one) goes to their stand-in (when
// chosen, Active and not away that day too); everyone else stays (in the app it is a warning, never a block). Names, once
// each, in order. moved (optional): filled with who was swapped for whom.
// deno-lint-ignore no-explicit-any
export function vacTaskPeople(emps: any[], C: VacCtx, day?: string, moved?: VacMove[]): string[] {
  const out: string[] = [], D: VacCtx = day && day !== C.day ? { ...C, day } : C;
  for (const e of emps) {
    const v = vacAway(D, e.id, "notAssignable");
    const s = v && vacOpt(v, "standIn") && v.stand_in_id ? D.employees.find((x) => x.id === v.stand_in_id) : null;
    const name = String(s && (!s.status || s.status === "Active") && !vacAway(D, s.id, "notAssignable") ? s.name : e.name);
    if (moved && name !== String(e.name)) moved.push({ from: String(e.name), to: name });
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
// The line a redirected task starts its notes with: who it was for.
export function vacMovedNote(moved: VacMove[]): string {
  return moved.map((m) => `For ${m.from} (on vacation): given to ${m.to}, the stand-in.`).join("\n");
}
type Exec = { status: string; reason?: string; recipient?: string; ref?: string };
// The actions themselves. A customer action only runs after customerGuard said ok.
// deno-lint-ignore no-explicit-any
export async function execute(sb: any, st: any, a: any, f: Facts, T: TickCtx, nowMs: number, to: string): Promise<Exec> {
  const known = fieldsFor(f.type), vars = mergeVars(f, a), fill = (x: unknown) => fillMerge(String(x ?? ""), vars, known);
  const recordId = String((f.contact && f.kind === "contact" ? f.contact.id : (f.job || f.call || f.chat || {}).id) || "");
  if (st.type === "push") {
    const r = await pushRecipients(sb, st, await vacOf(sb, T, nowMs));
    const payload = { title: fill(st.title), body: fill(st.body || ""), url: APP_URL + (DEEP_LINK[f.kind] || ""), tag: `auto-${String(a.id).slice(0, 8)}-${recordId}` };
    // everyone picked is away with "No notifications" (and no stand-in took it): nothing to send, and that's not a fault
    if (!r.ids.length && r.chosen) return { status: "skipped", reason: "on vacation" };
    const sent = await sendTo(sb, r.ids, payload, await vapidKeys(sb));
    return sent.sent > 0 ? { status: "sent", recipient: clip(r.names.join(", "), 200) } : { status: "failed", reason: "no device", recipient: clip(r.names.join(", "), 200) };
  }
  if (st.type === "task") {
    const due = st.due_days == null ? null : shiftDay(zoneParts(nowMs, T.S.timezone).day, Number(st.due_days));
    const { names, moved } = await taskPeople(sb, st, await vacOf(sb, T, nowMs), due || undefined);
    const profiles = await rows(sb.from("profiles").select("id, full_name, role, technician_name"));
    const employees = names.length ? await rows(sb.from("employees").select("name, roles").eq("name", names[0])) : [];
    const c = f.contact;
    const row = {
      board: boardFor(names, profiles, employees), title: clip(fill(st.title), LIMITS.title), status: "Not Started",
      due,
      notes: clip([vacMovedNote(moved), fill(st.notes || "")].filter(Boolean).join("\n\n"), LIMITS.notes), client: (c && c.full_name) || "", contact_id: c ? c.id : null,
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
    if (!x || x.deleted_at) return "automation deleted";   // ROLLBACK BUILD edit 2: a soft delete (stage 2) is a delete
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
    // ROLLBACK BUILD edit 1: only ACTION rows (no row_kind column = a phase-4 row = an action row)
    const { data: prior } = await sb.from("automation_log").select("*").eq("run_id", run.id).eq("step_id", st.id).limit(50);
    // deno-lint-ignore no-explicit-any
    if (prior && prior.some((l: any) => (l.row_kind ?? "action") === "action")) { i++; continue; }   // this action already ran (or was skipped) in an earlier pass
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

// The timer, every minute.
// deno-lint-ignore no-explicit-any
export async function tick(sb: any, nowMs: number) {
  const nowIso = iso(nowMs);
  const { data: got, error: lockErr } = await sb.rpc("automation_tick_lock", { p_business: BUSINESS_ID, p_now: nowIso, p_seconds: 55 });
  if (lockErr) throw new Error(String(lockErr.message || lockErr));
  if (!got) return { ok: true, busy: true };
  const started = io.now();
  try {
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
      try { await advance(sb, run, T, nowMs); } catch (e) { console.error("automation run failed:", clip(String((e as Error).message || e), 200)); }
    }
    await reconcile(sb, nowMs, T.S, T.cat);
    await prune(sb, nowMs, T.S.timezone);
    return { ok: true, ...T.counts };
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
  const ids = await enqueue(sb, [e], autos, nowMs, T);
  const statuses: string[] = [];
  for (const rid of ids.slice(0, 10)) {
    // Taken only if still waiting (a tick may have it already).
    const { data: mine } = await sb.from("automation_runs").update({ status: "running", lease_until: iso(nowMs + 120e3), attempts: 1, updated_at: iso(nowMs) }).eq("id", rid).eq("status", "waiting").select("*");
    if (!mine || !mine[0]) continue;
    const p = await advance(sb, mine[0], T, nowMs);
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
    // vacations on the day the action would run (after the waits and windows above), not today (stage 3)
    const vacAt = async (): Promise<VacCtx> => { const C = await vacOf(sb, T, nowMs); return { ...C, day: bizParts(at, C.tz).day }; };
    if (st.type === "push") {
      const r = await pushRecipients(sb, st, await vacAt());
      out.push({ id: st.id, kind: "action", type: "push", ...(!r.ids.length && r.chosen ? { would: "skip", reason: "on vacation" } : { would: "send" }), to: r.names, title: fillMerge(st.title, vars, known), body: fillMerge(st.body || "", vars, known) });
    } else if (st.type === "task") {
      const due = st.due_days == null ? null : shiftDay(zoneParts(at, tz).day, Number(st.due_days));
      const { names, moved } = await taskPeople(sb, st, await vacAt(), due || undefined);
      const profiles = await rows(sb.from("profiles").select("id, full_name, role, technician_name"));
      const employees = names.length ? await rows(sb.from("employees").select("name, roles").eq("name", names[0])) : [];
      out.push({ id: st.id, kind: "action", type: "task", would: "add", board: boardFor(names, profiles, employees), assignees: names, title: fillMerge(st.title, vars, known), notes: [vacMovedNote(moved), fillMerge(st.notes || "", vars, known)].filter(Boolean).join("\n\n"),
        due });
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
