// voice: the business phone line on Twilio (Ofek, 1–2 Oct 2026). Replaces GHL's phone so the office can leave GHL.
//
// How a call is routed (set in the app: Settings → Phone, stored in settings.phone_routing):
//   • An office person (a VA) is "on shift" (Log In on their My Day; a shift only counts on the day it was started): their
//     browser phone rings first, 20 seconds.
//   • Not answered, or nobody in the office is on shift: the backup phones during their hours (set per weekday in Settings
//     → Phone; nothing saved = every day 08:00–20:00), split by service as set there — skipping anyone marked away (then
//     the others).
//   • Nobody answers, or it's outside those hours with nobody on shift: voicemail ("office closed" after hours), a text to
//     the caller, and a call-back item on the office's My Day with the recording.
//   • The service: a known customer goes by their card's division; a new caller hears a 3-option menu.
//   • Answered calls are recorded after a recording notice (Australian law requires notice).
//
// Twilio calls this function (webhooks, form-encoded, signed with X-Twilio-Signature); ?step= picks the step:
//   incoming, menu, after_office, after_owners, voicemail_done, voicemail, outbound, status, recording.
// The app calls ?step=token (browser-phone token) and ?step=play (stream a recording), signed in as office staff.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const ACCOUNT_SID = env("TWILIO_ACCOUNT_SID");
const AUTH_TOKEN = env("TWILIO_AUTH_TOKEN");
const API_KEY_SID = env("TWILIO_API_KEY_SID");
const API_KEY_SECRET = env("TWILIO_API_KEY_SECRET");
const TWIML_APP_SID = env("TWILIO_TWIML_APP_SID");
const BUSINESS_NUMBER = env("TWILIO_NUMBER");             // +61 4… the Twilio number: answers calls, sends the texts
const SELF_URL = env("VOICE_FUNCTION_URL");                // https://<project>.supabase.co/functions/v1/voice (signatures cover this exact URL)
const VOICE = `voice="Polly.Olivia" language="en-AU"`;
const NOTICE = "Thanks for calling {business_name}. This call may be recorded for quality and training.";
const CLOSED = "Thanks for calling {business_name}. Our office is closed right now. Please leave a short message after the tone with your name, your suburb and what you need, and we'll call you back first thing. We'll also send you a text.";
const MISSED = "Sorry, we couldn't get to the phone. Please leave a short message after the tone with your name, your suburb and what you need, and we'll call you back shortly. We'll also send you a text.";
// The words customers get, as edited in Settings → Message templates (settings.catalog.templates, Ofek 12 Oct). Read once
// per request; a template nobody has edited keeps the approved text below, word for word. {business_name} = the business
// name (settings.company_name, Business details; round 3, T1.9), read with them.
let TPL: Record<string, string> = {};
let BIZ = "";
// deno-lint-ignore no-explicit-any
// A failed read (supabase-js answers { data: null, error } without throwing) keeps what was read last (a warm instance):
// never "nothing saved", so a caller doesn't hear the greeting without the business's name because of one bad read.
export async function loadTemplates(sb: any) {
  try {
    const { data, error } = await sb.from("settings").select("catalog, company_name").limit(1);
    if (error || !Array.isArray(data)) throw new Error(error ? error.message : "no settings");
    useTemplates(data[0] && data[0].catalog, data[0] && data[0].company_name);
  } catch (e) { console.error("voice: settings not read:", (e as Error).message || e); }
}
// deno-lint-ignore no-explicit-any
export function useTemplates(catalog: any, company?: unknown) { const t = catalog && catalog.templates; TPL = t && typeof t === "object" ? t : {}; BIZ = String(company || "").trim(); }
// {business_name} filled the way review-requests' fillReview fills a blank: with no name it takes its loose comma or space
// with it ("Thanks for calling {business_name}." → "Thanks for calling.").
export function fillBiz(t: string): string {
  return String(t ?? "").replace(/\{business_name\}/g, () => BIZ || "\u0000")
    .replace(/,[ \t]*\u0000(?=[?!.])/g, "").replace(/[ \t]+\u0000(?=[,?!.])/g, "").replace(/[ \t]*\u0000/g, "").replace(/^[ \t]+/gm, "");
}
export function tpl(key: string, fallback: string): string { const v = TPL[key]; return fillBiz(typeof v === "string" && v.trim() ? v : fallback); }
const SMS_MISSED = "Hi, it's {business_name}. Sorry we missed your call! We'll call you back shortly. If it's easier, reply here with what you need and your suburb.";
const SMS_CLOSED = "Hi, it's {business_name}. Thanks for calling - our office is closed right now, we'll call you back first thing. If it's easier, reply here with what you need and your suburb.";
// The menu a new caller hears (Settings → Phone, phone_routing.menu, Ofek 13 Oct): the services in order, each with the
// words spoken for it. Nothing saved = the original three, so the caller hears exactly the same menu:
// "For air conditioning, press 1. For chimney, press 2. For pressure washing, press 3."
const DEFAULT_MENU = [{ key: "Aircon", say: "air conditioning" }, { key: "Chimney", say: "chimney" }, { key: "Pressure Washing", say: "pressure washing" }];
// deno-lint-ignore no-explicit-any
export function menuOf(r: any): { key: string; say: string }[] {
  // deno-lint-ignore no-explicit-any
  const m = Array.isArray(r && r.menu) ? r.menu.filter((x: any) => x && typeof x.key === "string" && x.key.trim() && typeof x.say === "string" && x.say.trim()).slice(0, 9) : [];
  // deno-lint-ignore no-explicit-any
  return m.length ? m.map((x: any) => ({ key: x.key.trim(), say: x.say.trim() })) : DEFAULT_MENU;
}
export const menuText = (menu: { say: string }[]) => menu.map((m, i) => `For ${m.say}, press ${i + 1}.`).join(" ");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });

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

// ── phone numbers: E.164 (+61…); the last 9 digits are the key used everywhere in the CRM ──
function toE164(v: unknown): string {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : "";
  d = d.replace(/\D/g, "");
  if (/^1[38]00\d{6}$/.test(d)) return "+61" + d;               // 1300 / 1800
  if (d.startsWith("61")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return /^\d{9}$/.test(d) ? "+61" + d : "";
}
function phoneKey(v: unknown): string { const d = String(v || "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(-9) : ""; }
function pretty(e164: string): string {
  const d = e164.startsWith("+61") ? (/^\+611[38]00/.test(e164) ? e164.slice(3) : "0" + e164.slice(3)) : e164;
  if (/^04\d{8}$/.test(d)) return d.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  if (/^0\d{9}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3");
  if (/^1[38]00\d{6}$/.test(d)) return d.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  return d;
}
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stepUrl = (step: string, div?: string) => `${SELF_URL}?step=${step}${div ? `&div=${encodeURIComponent(div)}` : ""}`;

// ── business time (Settings → Region and format; read with the routing at the start of every call step) ──
let TZ = REGION_DEFAULTS.timeZone;
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };

// ── routing settings (Settings → Phone) ──
type Person = { name: string; mobile: string; available: boolean };
type BackupDay = { on?: boolean; from?: string; to?: string };
// Backup hours: per weekday since 13 Oct ({ days: { 0..6: { on, from, to } } }, Sunday = 0); before that one range for the
// ticked days ({ from, to, days: [0..6] }).
type BackupHours = { from?: string; to?: string; days?: number[] | Record<string, BackupDay> };
type Routing = { people: Record<string, Person>; divisions: Record<string, string[]>; backupHours: BackupHours; officeRingSeconds: number; backupRingSeconds: number; callerId: string; menu: { key: string; say: string }[] };
const ringSeconds = (v: unknown) => { const n = Math.round(Number(v)); return n >= 5 && n <= 60 ? n : 20; };
// The routing and, in the same read, the words (Settings → Message templates), so a call never waits on a second query.
// deno-lint-ignore no-explicit-any
async function routing(sb: any): Promise<Routing> {
  const { data, error } = await sb.from("settings").select("phone_routing, catalog, company_name").limit(1);
  const r = (data && data[0] && data[0].phone_routing) || {};
  // a failed read keeps the words and time zone read last (loadTemplates), never "nothing saved"
  if (!error && Array.isArray(data)) { useTemplates(data[0] && data[0].catalog, data[0] && data[0].company_name); TZ = bizTzOf(data[0] && data[0].catalog); }
  return {
    people: r.people || {}, divisions: r.divisions || {},
    backupHours: r.backupHours || { from: "08:00", to: "20:00", days: [0, 1, 2, 3, 4, 5, 6] },
    officeRingSeconds: ringSeconds(r.officeRingSeconds), backupRingSeconds: ringSeconds(r.backupRingSeconds),
    callerId: toE164(r.callerId) || BUSINESS_NUMBER, menu: menuOf(r),
  };
}
const BACKUP_DAY_DEFAULT = { on: true, from: "08:00", to: "20:00" };
// One day's backup window in minutes, or null when there is no backup that day. Reads both shapes (see BackupHours); the
// app reads them with the same rules (phoneBackupHours). A day missing from the per-day shape is on, 08:00–20:00.
export function backupDay(h: BackupHours, dow: number): { from: number; to: number } | null {
  if (!h || typeof h !== "object") return null;
  let x: BackupDay | null = null;
  if (Array.isArray(h.days)) x = h.days.map(Number).includes(dow) ? { on: true, from: h.from, to: h.to } : null;
  else if (h.days && typeof h.days === "object") {
    const d = { ...BACKUP_DAY_DEFAULT, ...((h.days as Record<string, BackupDay>)[String(dow)] || {}) };
    x = d.on ? d : null;
  }
  if (!x) return null;
  const from = hm(x.from || ""), to = hm(x.to || "");
  return from >= 0 && to > from ? { from, to } : null;
}
function backupOpen(R: Routing, nowMs: number): boolean {
  const t = bizParts(nowMs, TZ), w = backupDay(R.backupHours, t.dow);
  return !!w && t.minutes >= w.from && t.minutes < w.to;
}
// The owners' mobiles for a service: the ones set for it who aren't away; if all of them are away, anyone who isn't.
function ownersFor(R: Routing, division: string): string[] {
  const avail = (k: string) => !!(R.people[k] && R.people[k].available !== false && toE164(R.people[k].mobile));
  const set = (R.divisions[division] || R.divisions["Other"] || Object.keys(R.people)).filter(avail);
  const pick = set.length ? set : Object.keys(R.people).filter(avail);
  return [...new Set(pick.map((k) => toE164(R.people[k].mobile)))];
}
const identityFor = (profileId: string) => `office-${profileId}`;
// Browser phones on shift: VAs with CRM access who pressed "Start shift" today (a shift never carries over to the next day).
// deno-lint-ignore no-explicit-any
async function onShift(sb: any, nowMs: number): Promise<string[]> {
  const today = bizParts(nowMs, TZ).day;
  const { data } = await sb.from("profiles").select("id, role, permissions, on_duty, on_duty_date");
  // deno-lint-ignore no-explicit-any
  return (data || []).filter((p: any) => p.role === "va" && p.permissions && p.permissions.crm && p.on_duty && String(p.on_duty_date) === today).map((p: any) => identityFor(p.id));
}

// ── Twilio request signature (https://www.twilio.com/docs/usage/security#validating-requests) ──
async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}
async function twilioSignatureOk(url: string, params: Record<string, string>, signature: string): Promise<boolean> {
  if (!AUTH_TOKEN || !signature) return false;
  const expected = await hmacSha1Base64(AUTH_TOKEN, url + Object.keys(params).sort().map((k) => k + params[k]).join(""));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ── browser-phone token (Twilio Access Token, HS256 JWT with a Voice grant) ──
const b64url = (s: string | Uint8Array) => btoa(typeof s === "string" ? unescape(encodeURIComponent(s)) : String.fromCharCode(...s)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function voiceToken(identity: string, nowSec: number): Promise<string> {
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = { jti: `${API_KEY_SID}-${nowSec}`, iss: API_KEY_SID, sub: ACCOUNT_SID, iat: nowSec, exp: nowSec + 3600, grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: TWIML_APP_SID } } } };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(API_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body))))}`;
}

// ── CRM ──
// deno-lint-ignore no-explicit-any
async function findContact(sb: any, e164: string): Promise<any | null> {
  const key = phoneKey(e164);
  if (!key) return null;
  // deno-lint-ignore no-explicit-any
  let best: any = null;
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await sb.from("contacts").select("id, full_name, phone, division, created_at").order("id").range(from, from + 999);
    if (error) throw error;
    for (const c of data || []) if (phoneKey(c.phone) === key && (!best || String(c.created_at) > String(best.created_at))) best = c;
    if (!data || data.length < 1000) break;
  }
  return best;
}
// deno-lint-ignore no-explicit-any
async function addToCard(sb: any, contactId: string, text: string, unread = false) {
  const { data } = await sb.from("contacts").select("messages").eq("id", contactId).single();
  const msgs = Array.isArray(data?.messages) ? data.messages : [];
  const at = new Date().toISOString();
  msgs.push(unread ? { id: crypto.randomUUID(), kind: "message", direction: "in", auto: true, author: "Phone", text, at } : { id: crypto.randomUUID(), kind: "event", text, at });
  await sb.from("contacts").update({ messages: msgs }).eq("id", contactId);
}
type Caller = { id: string; name: string; division: string };
// deno-lint-ignore no-explicit-any
async function contactForCaller(sb: any, e164: string, nowMs: number): Promise<Caller | null> {
  if (!e164) return null;
  const c = await findContact(sb, e164);
  if (c) return { id: c.id, name: c.full_name || pretty(e164), division: String(c.division || "") };
  const row = {
    full_name: `Caller ${pretty(e164)}`, phone: pretty(e164), email: "", postcode: "", division: "Other", source: "Unknown", status: "New",
    created_at: bizDayStamp(bizParts(nowMs, TZ).day, TZ), job_description: "", tags: [],
    messages: [{ id: crypto.randomUUID(), kind: "event", text: "Lead created automatically from an incoming phone call", at: new Date(nowMs).toISOString() }],
  };
  const { data, error } = await sb.from("contacts").insert(row).select("id").single();
  if (error) throw error;
  return { id: data.id, name: row.full_name, division: "" };
}
async function sendSms(to: string, body: string): Promise<boolean> {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !BUSINESS_NUMBER || !/^\+614\d{8}$/.test(to)) return false;   // mobiles only
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: BUSINESS_NUMBER, Body: body }).toString(),
  });
  return res.ok;
}
const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
const recordAttrs = () => `record="record-from-answer-dual" recordingStatusCallback="${esc(stepUrl("recording"))}" recordingStatusCallbackEvent="completed"`;

// ── call building blocks (TwiML text, wrapped by xml() at the end) ──
function dialOffice(R: Routing, clients: string[], div: string, caller: Caller | null): string {
  const params = (caller ? `<Parameter name="contactId" value="${esc(caller.id)}"/><Parameter name="callerName" value="${esc(caller.name)}"/>` : "") + (div ? `<Parameter name="division" value="${esc(div)}"/>` : "");
  return `<Dial timeout="${R.officeRingSeconds}" answerOnBridge="true" ${recordAttrs()} action="${esc(stepUrl("after_office", div))}">` +
    clients.map((id) => `<Client><Identity>${esc(id)}</Identity>${params}</Client>`).join("") + `</Dial>`;
}
// The owners ring together and see the customer's number (Twilio allows the caller's own number when forwarding).
function dialOwners(R: Routing, mobiles: string[], div: string, from: string): string {
  return `<Dial timeout="${R.backupRingSeconds}" answerOnBridge="true" callerId="${esc(from || BUSINESS_NUMBER)}" ${recordAttrs()} action="${esc(stepUrl("after_owners", div))}">` +
    mobiles.map((n) => `<Number>${esc(n)}</Number>`).join("") + `</Dial>`;
}
// Voicemail: say why, take a message (up to 2 minutes), text the caller, and flag a call-back.
// deno-lint-ignore no-explicit-any
async function voicemail(sb: any, p: Record<string, string>, closed: boolean): Promise<string> {
  const from = toE164(p.From);
  await loadTemplates(sb);
  const smsOk = await sendSms(from, closed ? tpl("missedCallClosed", SMS_CLOSED) : tpl("missedCall", SMS_MISSED));
  await sb.from("calls").update({ status: "missed", missed: true, sms_sent: smsOk }).eq("call_sid", p.CallSid || "");
  const { data: call } = await sb.from("calls").select("contact_id").eq("call_sid", p.CallSid || "").single();
  if (call && call.contact_id) await addToCard(sb, call.contact_id, `📞 Missed call from ${pretty(from || p.From || "")}${closed ? " (office closed)" : ""}${smsOk ? " · we sent them a text" : ""}. Call them back.`, true);
  return `<Say ${VOICE}>${esc(closed ? tpl("phoneClosed", CLOSED) : tpl("phoneMissed", MISSED))}</Say>` +
    `<Record maxLength="120" playBeep="true" trim="trim-silence" action="${esc(stepUrl("voicemail_done"))}" recordingStatusCallback="${esc(stepUrl("voicemail"))}" recordingStatusCallbackEvent="completed"/>`;
}
// Where a call goes once we know the service.
// deno-lint-ignore no-explicit-any
async function route(sb: any, R: Routing, p: Record<string, string>, div: string, nowMs: number, caller: Caller | null): Promise<string> {
  const clients = await onShift(sb, nowMs);
  if (clients.length) return dialOffice(R, clients, div, caller);
  const open = backupOpen(R, nowMs);
  const owners = open ? ownersFor(R, div) : [];
  if (owners.length) return dialOwners(R, owners, div, toE164(p.From));
  return await voicemail(sb, p, !open);
}

// ── the call steps ──
// deno-lint-ignore no-explicit-any
export async function step(sb: any, name: string, p: Record<string, string>, q: Record<string, string> = {}, nowMs = Date.now()): Promise<Response> {
  const callSid = p.CallSid || "";
  const R = await routing(sb);
  if (name === "incoming") {
    const from = toE164(p.From);
    const caller = await contactForCaller(sb, from, nowMs);
    // A known customer's service counts only when it is one of the menu's services.
    const known = caller && R.menu.some((m) => m.key === caller.division) ? caller.division : "";
    await sb.from("calls").insert({ call_sid: callSid, direction: "inbound", from_number: from || p.From || "", to_number: toE164(p.To) || p.To || "", contact_id: caller ? caller.id : null, status: "ringing", division: known || null });
    // Nobody on shift and outside the owners' hours: straight to the "office closed" voicemail.
    if (!(await onShift(sb, nowMs)).length && !backupOpen(R, nowMs)) return xml(await voicemail(sb, p, true));
    const notice = `<Say ${VOICE}>${esc(tpl("phoneGreeting", NOTICE))}</Say>`;
    // A known customer goes by their service; a new caller picks one (no key pressed counts as "Other").
    if (caller && known) return xml(notice + await route(sb, R, p, known, nowMs, caller));
    return xml(notice + `<Gather input="dtmf" numDigits="1" timeout="6" action="${esc(stepUrl("menu"))}"><Say ${VOICE}>${esc(menuText(R.menu))}</Say></Gather><Redirect method="POST">${esc(stepUrl("menu"))}</Redirect>`);
  }
  if (name === "menu") {
    const pick = R.menu[Number(p.Digits || "0") - 1];
    const div = pick ? pick.key : "Other";
    await sb.from("calls").update({ division: div }).eq("call_sid", callSid);
    const { data: call } = await sb.from("calls").select("contact_id").eq("call_sid", callSid).single();
    let caller: Caller | null = null;
    if (call && call.contact_id) {
      const { data: c } = await sb.from("contacts").select("id, full_name, division").eq("id", call.contact_id).single();
      if (c) {
        caller = { id: c.id, name: c.full_name, division: div };
        if (div !== "Other" && (!c.division || c.division === "Other")) await sb.from("contacts").update({ division: div }).eq("id", c.id);
      }
    }
    return xml(await route(sb, R, p, div, nowMs, caller));
  }
  if (name === "after_office" || name === "after_owners") {
    const div = q.div || "Other";
    if (p.DialCallStatus === "completed") {
      await sb.from("calls").update({ status: "answered", answered_by: name === "after_office" ? "office" : "owner" }).eq("call_sid", callSid);
      return xml(`<Hangup/>`);
    }
    const open = backupOpen(R, nowMs);
    if (name === "after_office" && open) {
      const owners = ownersFor(R, div);
      if (owners.length) return xml(dialOwners(R, owners, div, toE164(p.From)));
    }
    return xml(await voicemail(sb, p, !open));
  }
  if (name === "voicemail_done") return xml(`<Say ${VOICE}>Thank you. Goodbye.</Say><Hangup/>`);
  if (name === "voicemail") {
    if (p.RecordingStatus && p.RecordingStatus !== "completed") return xml("");
    const dur = Number(p.RecordingDuration || 0) || 0;
    await sb.from("calls").update({ recording_sid: p.RecordingSid || null, recording_duration: dur, voicemail: dur > 1 }).eq("call_sid", callSid);
    const { data: call } = await sb.from("calls").select("contact_id").eq("call_sid", callSid).single();
    if (call && call.contact_id && dur > 1) await addToCard(sb, call.contact_id, `🎙 Voicemail left (${fmtDur(dur)}). Play it under Calls on this card.`, true);
    return xml("");
  }
  if (name === "outbound") {
    // Only our own browser phones may place calls, and only to real phone numbers. Customers see the business number.
    if (!/^client:office-/.test(p.From || "")) return xml(`<Reject/>`);
    const to = toE164(p.To);
    if (!to) return xml(`<Say ${VOICE}>That number is not valid.</Say><Hangup/>`);
    const c = await findContact(sb, to);
    await sb.from("calls").insert({ call_sid: callSid, direction: "outbound", from_number: R.callerId, to_number: to, contact_id: c ? c.id : null, status: "ringing", created_by: String(p.From).replace(/^client:/, "") });
    return xml(`<Dial callerId="${esc(R.callerId)}" answerOnBridge="true" ${recordAttrs()}><Number>${esc(to)}</Number></Dial>`);
  }
  if (name === "status") {
    if (!["completed", "no-answer", "busy", "failed", "canceled"].includes(p.CallStatus)) return xml("");
    const dur = Number(p.CallDuration || 0) || 0;
    const { data: call } = await sb.from("calls").select("*").eq("call_sid", callSid).single();
    if (!call) return xml("");
    const status = call.status === "missed" ? "missed" : call.status === "answered" ? "answered" : (call.direction === "outbound" ? (dur > 0 ? "answered" : "no answer") : call.status);
    await sb.from("calls").update({ status, duration: dur, ended_at: new Date(nowMs).toISOString() }).eq("call_sid", callSid);
    if (call.contact_id && status !== "missed") {
      await addToCard(sb, call.contact_id, `📞 ${call.direction === "outbound" ? "Outgoing" : "Incoming"} call ${status === "answered" ? `· ${fmtDur(dur)}` : `· ${status}`}`);
      if (status === "answered") await sb.from("contacts").update({ contacted_at: new Date(nowMs).toISOString() }).eq("id", call.contact_id).is("contacted_at", null);
    }
    // Calling a missed caller back (and getting through) clears their missed call.
    if (call.direction === "outbound" && status === "answered" && call.to_number) {
      await sb.from("calls").update({ callback_done_at: new Date(nowMs).toISOString() }).eq("missed", true).eq("from_number", call.to_number).is("callback_done_at", null);
    }
    return xml("");
  }
  if (name === "recording") {
    if (p.RecordingStatus && p.RecordingStatus !== "completed") return xml("");
    await sb.from("calls").update({ recording_sid: p.RecordingSid || null, recording_duration: Number(p.RecordingDuration || 0) || 0 }).eq("call_sid", callSid);
    return xml("");
  }
  return xml("");
}

// ── office users (token, play): a signed-in Supabase user with CRM access ──
// deno-lint-ignore no-explicit-any
async function officeUser(sb: any, req: Request): Promise<any | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, role, permissions").eq("id", u.user.id).single();
  if (!p) return null;
  return p.role === "owner" || p.role === "manager" || (p.role === "va" && p.permissions && p.permissions.crm) ? p : null;
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__VOICE_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const name = url.searchParams.get("step") || "";
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    try {
      if (name === "token") {
        const p = await officeUser(sb, req);
        if (!p) return json({ error: "unauthorized" }, 401);
        if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET || !TWIML_APP_SID) return json({ error: "phone not set up yet" }, 503);
        return json({ token: await voiceToken(identityFor(p.id), Math.floor(Date.now() / 1000)), identity: identityFor(p.id) });
      }
      if (name === "play") {
        const p = await officeUser(sb, req);
        if (!p) return json({ error: "unauthorized" }, 401);
        const { data: call } = await sb.from("calls").select("recording_sid").eq("id", url.searchParams.get("call") || "").single();
        if (!call || !call.recording_sid) return json({ error: "no recording" }, 404);
        const rec = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${call.recording_sid}.mp3`, { headers: { Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`) } });
        if (!rec.ok) return json({ error: "recording not available" }, 502);
        return new Response(rec.body, { headers: { ...CORS, "Content-Type": "audio/mpeg" } });
      }
      // Everything else is a Twilio webhook: form-encoded and signed.
      const params = Object.fromEntries(new URLSearchParams(await req.text()));
      if (!(await twilioSignatureOk(`${SELF_URL}${url.search}`, params, req.headers.get("x-twilio-signature") || ""))) return new Response("forbidden", { status: 403 });
      return await step(sb, name, params, Object.fromEntries(url.searchParams));
    } catch (e) {
      console.error("voice failed:", name, e);
      // Never leave a caller in silence.
      if (["incoming", "menu", "after_office", "after_owners"].includes(name)) return xml(`<Say ${VOICE}>${esc(tpl("phoneMissed", MISSED))}</Say><Record maxLength="120" playBeep="true" action="${esc(stepUrl("voicemail_done"))}"/>`);
      return json({ error: "failed" }, 500);
    }
  });
}
