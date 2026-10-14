// contractor-sign: a contractor reads and signs their subcontractor agreement on the phone (Ofek 13 Oct, approved
// mockup). Public, no login: the signing link's token is the only key, and it opens one agreement only.
//   POST { step: "get", t, preview? }  → the agreement to read (the contractor's first look marks it "opened" on
//        their card; "See what they see" in the app sends preview: true and changes nothing)
//   POST { step: "sign", t, name, agree: true, signature: "data:image/png;base64,…" }
//        → saves the signature with the name, the time, the IP address and the device, once.
// The agreement text itself is made in the app (Resources → Contractors) and kept in contractor_private.agreement,
// which only owners and managers can read; this function reaches it with the service role, by the token.
// Deploy with "Verify JWT" off (the contractor is not signed in).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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

export const tokenOk = (t: unknown) => /^[A-Za-z0-9_-]{24,64}$/.test(String(t || ""));
// What the link can still do: "ok" (read and sign), "signed" (read the signed copy), "expired", or "missing".
// deno-lint-ignore no-explicit-any
export function linkState(priv: any, nowMs: number): "ok" | "signed" | "expired" | "missing" {
  if (!priv || !priv.agreement || !priv.agreement.html) return "missing";
  if (priv.agreement.state === "signed") return "signed";
  const exp = priv.sign_token_expires ? Date.parse(priv.sign_token_expires) : NaN;
  if (!Number.isFinite(exp) || exp <= nowMs) return "expired";
  return "ok";
}
// A signature is a PNG drawn on the page; a name of 2–80 characters; and the "I agree" tick.
export function signError(name: unknown, agree: unknown, sig: unknown): string | null {
  const n = String(name || "").trim();
  if (n.length < 2 || n.length > 80) return "name";
  if (agree !== true) return "agree";
  const s = String(sig || "");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) || s.length < 200 || s.length > 400000) return "signature";
  return null;
}
// What the contractor's page gets: the text and the deal line, never the bank details or the token. tz = the business's
// time zone (Region and format), for the dates the page shows. biz = the business's names (Business details): the page
// shows the names the agreement was made under (agreement.ours), else today's (round 3, T1.9).
// deno-lint-ignore no-explicit-any
export function publicView(sup: any, priv: any, state: string, tz = REGION_DEFAULTS.timeZone, biz: { name?: string; legalName?: string } = {}) {
  const a = priv.agreement || {}, ours = a.ours && typeof a.ours === "object" ? a.ours : {};
  return {
    ok: true, state, tz, company: String(sup.name || ""), person: String(sup.contact_person || ""), html: String(a.html || ""), dealLine: String(a.dealLine || ""),
    dealNote: String(a.dealNote || ""), version: Number(a.version) || 1, madeOn: String(a.made_at || "").slice(0, 10), ourSigner: String(a.made_by || ""),
    ourName: String(ours.name || biz.name || ""), ourLegalName: String(ours.legalName || biz.legalName || biz.name || ""),
    ...(state === "signed" && a.signed ? { signedAt: a.signed.at, signer: a.signed.name, signature: a.signed.signature } : {}),
  };
}

// The business's time zone and names, in one read; Sydney and no names when the settings can't be read (the page still works).
// deno-lint-ignore no-explicit-any
export async function businessInfo(sb: any): Promise<{ tz: string; name: string; legalName: string }> {
  try {
    const { data, error } = await sb.from("settings").select("catalog, company_name, legal_name").limit(1);
    const s = (!error && data && data[0]) || {};
    return { tz: bizTzOf(s.catalog), name: String(s.company_name || "").trim(), legalName: String(s.legal_name || "").trim() };
  } catch { return { tz: REGION_DEFAULTS.timeZone, name: "", legalName: "" }; }
}

// Changes are made only while the row still has this link and is not signed yet, so a new agreement made in the app
// at the same moment, or a second signature, never overwrites what is there.
const OPEN_STATES = ["ready", "sent", "opened"];

// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, ip: string, ua: string, nowMs: number): Promise<{ status: number; body: unknown }> {
  const step = String(body?.step || ""), t = String(body?.t || "");
  if (!tokenOk(t)) return { status: 400, body: { ok: false, reason: "link" } };
  const read = () => sb.from("contractor_private").select("supplier_id, agreement, sign_token_expires, updated_at").eq("sign_token", t).limit(1);
  const pq = await read();
  if (pq.error) return { status: 500, body: { ok: false, reason: "server" } };
  const priv = (pq.data || [])[0];
  const state = linkState(priv, nowMs);
  if (state === "missing") return { status: 404, body: { ok: false, reason: "link" } };
  // The settings are read once, only for a real link (an unknown link learns nothing about the business).
  let infoP: Promise<{ tz: string; name: string; legalName: string }> | null = null;
  const info = () => infoP || (infoP = businessInfo(sb));
  if (state === "expired") { const b = await info(), ours = priv.agreement.ours || {}; return { status: 410, body: { ok: false, reason: "expired", ourName: String(ours.name || b.name || "") } }; }
  const sq = await sb.from("suppliers").select("id, name, contact_person, agreement_status").eq("id", priv.supplier_id).limit(1);
  const sup = (sq.data || [])[0];
  if (!sup) return { status: 404, body: { ok: false, reason: "link" } };
  const at = new Date(nowMs).toISOString();
  if (step === "get") {
    // Only a link that was sent counts as opened (not someone in the office looking at it first).
    if (state === "ok" && body?.preview !== true && priv.agreement.state === "sent" && !priv.agreement.opened_at) {
      // Only if nothing changed since it was read (the office may be sending it again at this moment).
      const op = await sb.from("contractor_private").update({ agreement: { ...priv.agreement, opened_at: at, state: "opened" }, updated_at: at })
        .eq("supplier_id", sup.id).eq("sign_token", t).eq("agreement->>state", "sent").eq("updated_at", priv.updated_at).select("supplier_id");
      if (!op.error && (op.data || []).length === 1 && sup.agreement_status === "sent") {
        const so = await sb.from("suppliers").update({ agreement_status: "opened" }).eq("id", sup.id).eq("agreement_status", "sent");
        if (so.error) console.error("contractor-sign: card not marked opened", so.error.message);
      }
    }
    const b = await info();
    return { status: 200, body: publicView(sup, priv, state, b.tz, b) };
  }
  if (step === "sign") {
    if (state === "signed") return { status: 409, body: { ok: false, reason: "already_signed" } };
    const err = signError(body?.name, body?.agree, body?.signature);
    if (err) return { status: 400, body: { ok: false, reason: err } };
    const name = String(body.name).trim();
    const signed = { name, at, ip: ip.slice(0, 200), ua: ua.slice(0, 300), signature: String(body.signature) };
    // Saved only onto the row exactly as it was read. If it changed in between (the office sent it again), it is read
    // again and the signature goes onto the new copy; if it was signed or replaced meanwhile, nothing is saved.
    // deno-lint-ignore no-explicit-any
    let cur = priv, agreement: any = null;
    for (let i = 0; i < 3 && !agreement; i++) {
      const next = { ...cur.agreement, state: "signed", opened_at: cur.agreement.opened_at || at, signed };
      const up = await sb.from("contractor_private").update({ agreement: next, updated_at: at })
        .eq("supplier_id", sup.id).eq("sign_token", t).in("agreement->>state", OPEN_STATES).eq("updated_at", cur.updated_at).select("supplier_id");
      if (up.error) return { status: 500, body: { ok: false, reason: "server" } };
      if ((up.data || []).length === 1) { agreement = next; break; }
      const again = await read();
      if (again.error) return { status: 500, body: { ok: false, reason: "server" } };
      cur = (again.data || [])[0];
      const st = linkState(cur, nowMs);
      if (st === "signed") return { status: 409, body: { ok: false, reason: "already_signed" } };
      if (st !== "ok") return { status: 409, body: { ok: false, reason: st === "expired" ? "expired" : "link" } };
    }
    if (!agreement) return { status: 409, body: { ok: false, reason: "busy" } };
    const so = await sb.from("suppliers").update({ agreement_status: "signed", agreement_signed_at: at, agreement_signer: name }).eq("id", sup.id);
    // The signature itself is saved; the app sets the card from it the next time an owner or manager opens it.
    if (so.error) console.error("contractor-sign: card not marked signed", so.error.message);
    const b = await info();
    return { status: 200, body: publicView(sup, { ...cur, agreement }, "signed", b.tz, b) };
  }
  return { status: 400, body: { ok: false, reason: "step" } };
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__SIGN_TEST__) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "json" }, 400); }
  // The whole forwarded chain is kept (cut at 200 characters): the first address alone can be made up by the sender.
  const ip = (req.headers.get("x-forwarded-for") || "").trim();
  const out = await handle(createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!), body, ip, req.headers.get("user-agent") || "", Date.now());
  return json(out.body, out.status);
});
