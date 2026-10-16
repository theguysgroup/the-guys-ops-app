// mcp: the private connector (stage 5, Ofek 14 Oct). OPS as a read-only MCP server for each person's own AI assistant
// (Claude and other MCP clients), plus the management steps the app's Settings → Connectors page calls.
//
// Routes (one function):
//   POST /mcp, POST /mcp/t/<key>  Streamable HTTP MCP (JSON-RPC 2.0, plain JSON answers, no SSE, no session): initialize,
//                                 notifications/initialized (202), ping, tools/list, tools/call. The key is a personal
//                                 'ops_mcp_…' key, as `Authorization: Bearer <key>` or in the path (for clients that only
//                                 take a URL, like claude.ai custom connectors). GET / DELETE → 405.
//   POST /mcp/manage              { step, ... } with the signed-in person's Supabase token (like team): create_token,
//                                 revoke_token, set_mcp_settings, and the owner-only client steps below. Later groups
//                                 add their steps to MANAGE_STEPS (or a list of their own, like CLIENT_ACTIONS and
//                                 IMPORT_ACTIONS).
//   POST /mcp/cron                the hourly import timer (pg_cron 'mcp-import-hourly', header x-mcp-cron-secret).
//
// Guard rails:
//   • READ-ONLY. Every tool only reads, and only what that person can see in the app: the app's canViewSection /
//     filterForProfile are ported below (role scope) and tests compare them with the live app code on every run.
//     A technician never sees the business's money (stricter than the app where it matters, see the role scope).
//   • Keys are for owners and managers only (Ofek 15 Oct): create_token refuses anyone else, and a key whose person is
//     no longer an owner or manager stops working (authToken). There is no per-person switch.
//   • A key is stored only as its sha256; the key itself is shown once (create_token) and never logged. A key stops
//     working when it is revoked, when its person is no longer an owner or manager, or when their sign-in is switched off.
//   • Every tools/call, initialize and tools/list writes one mcp_access_log row (ok / denied / error / rate_limited); at
//     most catalog.mcp.rateLimitPerMin of them a minute per BUSINESS (all its keys together). Unauthenticated requests
//     are not logged (anyone could fill it).
//   • Reads are paged (.range, 1,000 rows a page), at most MAX_SCAN rows read and MAX_ROWS rows returned a call; dates
//     are in the business's time zone (settings.catalog.region.timeZone, read with the region block's bizTzOf).
//
// Client direction (owner only, POST /mcp/manage with the owner's Supabase token): OPS calls a business's own MCP
// server. save_server (name, https address, header name, write-only secret), delete_server, test_server (initialize +
// tools/list, the tool list is kept on the row) and call_tool (one tool, the answer shown as a short preview).
//   • Address rules (checked on save and again before every call): https only; no localhost, .local, .internal or
//     single-label hosts; no private, loopback, link-local, CGNAT, metadata, multicast, reserved or documentation IP,
//     whether typed as the address or answered by DNS; redirects are never followed; no port below 1024 except 443.
//     A host name is looked up once and the request connects to that checked address (no second lookup to rebind);
//     where names can't be looked up, host names are refused. Changing a server's host needs its secret typed again.
//   • At most 15 s a request and 45 s a step; an answer over 2 MB is refused. Only the MCP handshake, the tool name and
//     the arguments the owner typed are sent: no other OPS data ever leaves.
//   • The secret is read from Vault by the service role only for the outbound request; it is never returned, stored
//     outside Vault, or logged (anything the server echoes back is masked before it is kept or shown).
//
// Imports (owner only, POST /mcp/manage): a rule pulls a list from one of those servers into contacts, jobs or tasks.
//   save_rule        { rule: { id?, server_id, kind, name, tool, tool_args, items_path, mapping, dedupe, mode, enabled,
//                    run_automations } }: checked (validateRule), then written by the service role.
//   delete_rule      { id }: its runs stay (rule_id cleared, rule_name kept), so its imports can still be undone.
//   preview_import   { rule_id }: fetch → map → duplicate flags (new / duplicate / error). Writes nothing.
//   commit_import    { rule_id }: fetches again (the browser's preview is never trusted), inserts the new rows and
//                    records the run with exactly the ids it inserted. One running import per rule.
//   undo_import      { run_id }: deletes those ids (only those still there and not used by the team since: those are
//                    kept) with the import's own history entries, and marks the run undone.
//   POST /mcp/cron   the hourly timer (header x-mcp-cron-secret = env MCP_CRON_SECRET = Vault 'mcp_cron_secret'):
//                    answers 202 at once and runs the rules that are ON and hourly in the background.
//   • Insert only: an import never changes or deletes a record that was already there; undo deletes only the ids its
//     own run recorded. The tool gets exactly the arguments the owner saved: no OPS data is sent.
//   • run_automations is OFF unless the owner switches it on per rule. Off = the imported rows are 'quiet': every
//     imported contact, job and task carries the column import_quiet (true when quiet; the one marker the automations
//     engine and push read), and a quiet contact's first thread entry also carries quiet:true (for the app), so its
//     arrival is not a new lead for the automations engine or the phone notifications (push); a quiet job has
//     created_at null (the engine's jobClosed never sees it) and review_do_not_ask true (the review-requests auto-asker
//     skips it).
//   • "Date received" (contacts) dates the card: created_at and its first thread entry are that business day
//     (bizDayStamp), so imported history never shows as today's new leads. A date after the business's today is a
//     problem row ("Date received is in the future"), never clamped.
//
// Owner steps: run the M1-server, M2-client, M4-import and M5-review sections of .claude/sql/stage5-mcp.sql (then
// redeploy automations and push, which read the import_quiet column); in Vault add 'mcp_cron_secret' and
// 'mcp_project_url'; add the Edge Function secret MCP_CRON_SECRET (the same long random value as the Vault one); deploy
// with Verify JWT OFF (an MCP client carries an ops_mcp_ key, not a Supabase token; /manage checks the token itself).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MCP_CRON_SECRET, optional BUSINESS_ID ('default').

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : "") || "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const BUSINESS_ID = env("BUSINESS_ID") || "default";
const SELF_URL = SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/mcp";

export const TOKEN_RE = /^ops_mcp_[A-Za-z0-9_-]{43}$/;
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];   // the first is the latest
export const SERVER_INFO = { name: "ops-mcp", version: "1.0.0" };
export const MCP_DEFAULTS = { rateLimitPerMin: 60, logKeepDays: 90, importSource: "MCP import" };
export const MAX_ROWS = 500;              // rows returned per call
export const DEFAULT_LIMIT = 50;
export const NAME_CHUNK = 100;            // ids per .in() lookup (keeps the request address short)
export const MAX_RANGE_DAYS = 366;
export const MAX_TOKENS_PER_USER = 20;
export const MAX_RESULT_CHARS = 1_000_000;
export const LAST_USED_EVERY_MS = 60_000;
export const BAN_CACHE_MS = 60_000;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, x-mcp-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extra } });
}
// The clock, the random source, the network and DNS, swappable in tests. resolveDns answers null when this runtime
// can't look names up (then a host name is refused: see checkResolved). fetch gets the address checkResolved approved
// (ip): the connection goes to exactly that address (pinnedFetch), so a second DNS answer can't send it elsewhere.
export const io = {
  now: () => Date.now(),
  randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  fetch: (u: string, init: RequestInit, ip?: string | null) => (ip ? pinnedFetch(u, init, ip) : fetch(u, init)),
  resolveDns: async (host: string): Promise<string[] | null> => {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    if (!d || typeof d.resolveDns !== "function") return null;
    const out: string[] = [];
    for (const t of ["A", "AAAA"]) {
      // deno-lint-ignore no-explicit-any
      try { out.push(...(await d.resolveDns(host, t))); } catch (e) { if ((e as any)?.name !== "NotFound") throw e; }
    }
    return out;
  },
  // The timer answers at once (pg_net gives up after 10 s) and keeps working in the background. (As automations.)
  waitUntil: (p: Promise<unknown>) => {
    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(p);
  },
  // An import's one tool call on a saved server: the FULL result (2 MB cap, not call_tool's preview), or why not.
  // deno-lint-ignore no-explicit-any
  callTool: async (sb: any, server: any, tool: string, args: Record<string, unknown>): Promise<{ ok: true; result: any } | { ok: false; reason: string }> => {
    try { return { ok: true, result: (await remoteCall(sb, server.id, tool, args)).result }; } catch (e) {
      if (e instanceof ClientError) return { ok: false, reason: e.message };
      console.error("mcp import call failed:", clip((e as Error)?.message, 200));
      return { ok: false, reason: "OPS couldn't call the server." };
    }
  },
};

// ── small helpers ──
// The cron secret, compared without an early exit. Both must be set. (Copied from automations/index.ts.)
const enc = new TextEncoder();
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
export async function sha256Hex(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// A new personal key: 'ops_mcp_' + 32 random bytes as url-safe base64 without padding (always 43 characters).
export function newToken(): string {
  return "ops_mcp_" + btoa(String.fromCharCode(...io.randomBytes(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const tokenPrefix = (t: string) => t.slice(0, 12);
export const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export function isDay(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
}
export const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
// settings.catalog.mcp with the defaults for anything missing or out of range.
// deno-lint-ignore no-explicit-any
export function mcpSettings(catalog: any) {
  const m = catalog && catalog.mcp && typeof catalog.mcp === "object" && !Array.isArray(catalog.mcp) ? catalog.mcp : {};
  const intIn = (v: unknown, lo: number, hi: number, d: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : d);
  const src = typeof m.importSource === "string" ? m.importSource.trim().slice(0, 60) : "";
  return {
    rateLimitPerMin: intIn(m.rateLimitPerMin, 1, 600, MCP_DEFAULTS.rateLimitPerMin),
    logKeepDays: intIn(m.logKeepDays, 7, 3650, MCP_DEFAULTS.logKeepDays),
    importSource: src || MCP_DEFAULTS.importSource,
  };
}
// What the access log keeps of a call's arguments: only the tool's own fields, short. (A key is never a tool argument.)
// deno-lint-ignore no-explicit-any
export function summarizeArgs(args: any, schema: any): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const k of Object.keys((schema && schema.properties) || {})) {
    if (!(k in args) || args[k] === undefined) continue;
    const v = args[k];
    out[k] = typeof v === "string" ? clip(v, 60) : v && typeof v === "object" ? "[…]" : v;
  }
  return JSON.stringify(out).slice(0, 300);
}

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
// ── time zone: the business's (settings.catalog.region.timeZone, read with the region block's bizTzOf) ──
// A tool error: shown to the assistant as an isError result, never a JSON-RPC error.
export class ToolError extends Error {}
// A tool's from/to (days in tz) and the UTC instants around them: [fromIso, toIso). Default: the last `defaultDays`
// days ending with `to` (today when not given).
// deno-lint-ignore no-explicit-any
export function rangeOf(args: any, tz: string, nowMs: number, defaultDays = 30) {
  const today = bizParts(nowMs, tz).day;
  const to = args && args.to !== undefined ? args.to : today;
  if (!isDay(to)) throw new ToolError("'to' must be a date (YYYY-MM-DD).");
  const from = args && args.from !== undefined ? args.from : shiftDay(to, -(defaultDays - 1));
  if (!isDay(from)) throw new ToolError("'from' must be a date (YYYY-MM-DD).");
  if (from > to) throw new ToolError("'from' must be on or before 'to'.");
  if (dayDiff(from, to) + 1 > MAX_RANGE_DAYS) throw new ToolError(`Pick a range of at most ${MAX_RANGE_DAYS} days.`);
  return { from, to, fromIso: new Date(bizToUtc(from, 0, 0, tz)).toISOString(), toIso: new Date(bizToUtc(shiftDay(to, 1), 0, 0, tz)).toISOString() };
}

// ── shared: role scope + money (stage 8) BEGIN — ONE block, byte-identical in mcp and ai-gateway (ai-gateway's tests check); needs only the region block (bizParts) ──
export function shiftDay(day: string, n: number) { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
const dowOf = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
export const PAGE = 1000;                 // rows per .range() page
export const MAX_SCAN = 20000;            // rows read per call, all pages
// deno-lint-ignore no-explicit-any
export async function pageAll(build: (from: number, to: number) => any, max = MAX_SCAN): Promise<{ rows: any[]; truncated: boolean }> {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const to = Math.min(from + PAGE, max) - 1;
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message || "read failed");
    const got = data || [];
    rows.push(...got);
    if (got.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
// The app's built-in lists (index.html LEAD_DIVISIONS / LEAD_STATUSES / LEAD_SOURCES and their labels, parity-tested),
// used as the app's catalogList does: what the business saved, plus any built-in entry the saved list is missing.
export type CatalogSection = "services" | "stages" | "sources";
export const BASE_LISTS: Record<CatalogSection, string[]> = {
  services: ["Aircon", "Chimney", "Pressure Washing", "Other"],
  stages: ["New", "Chasing", "Quoted", "Follow-up", "Booked", "Won", "Lost"],
  sources: ["Google Ads", "Meta Ads", "Google Maps", "Organic", "Unknown"],
};
export const BASE_LABELS: Record<CatalogSection, Record<string, string>> = {
  services: {}, stages: { New: "New lead", Chasing: "Chasing", Quoted: "Quoted", "Follow-up": "Follow up", Booked: "Booked", Won: "Won", Lost: "Lost" }, sources: { Organic: "Organic web", "Phone Call": "Phone (old)" },   // "Phone Call": a legacy value on old rows only
};
export const STAGE_CORE = ["New", "Won", "Lost"];        // always on (index.html STAGE_CORE)
// The four built-in words a business can rename (their stage 2: settings.catalog.keys = { paid, done, won, lost }).
// Until then, and for any that is missing or not a plain short word, the app's own.
export const KEY_DEFAULTS = { paid: "Paid", done: "Done", won: "Won", lost: "Lost" };
export type CatalogKeys = typeof KEY_DEFAULTS;
// deno-lint-ignore no-explicit-any
export function catalogKeys(cat: any): CatalogKeys {
  const k = cat && typeof cat === "object" && cat.keys && typeof cat.keys === "object" && !Array.isArray(cat.keys) ? cat.keys : {};
  const word = (v: unknown, d: string) => (typeof v === "string" && /^[^",()\\<>]{1,40}$/.test(v.trim()) ? v.trim() : d);
  return { paid: word(k.paid, KEY_DEFAULTS.paid), done: word(k.done, KEY_DEFAULTS.done), won: word(k.won, KEY_DEFAULTS.won), lost: word(k.lost, KEY_DEFAULTS.lost) };
}
// A built-in word as the business calls it (a value that is not one of the four is itself).
export function renamedKey(keys: CatalogKeys | undefined, v: string): string {
  if (!keys) return v;
  for (const n of Object.keys(KEY_DEFAULTS) as (keyof CatalogKeys)[]) if (v === KEY_DEFAULTS[n]) return keys[n];
  return v;
}
export type CatalogLists = Record<CatalogSection, { key: string; label: string }[]>;
// The lists an import checks against: deleted and switched-off entries left out (New, Won and Lost are always on).
// deno-lint-ignore no-explicit-any
export function catalogLists(cat: any, keys: CatalogKeys = KEY_DEFAULTS): CatalogLists {
  // deno-lint-ignore no-explicit-any
  const out: any = {};
  for (const sec of Object.keys(BASE_LISTS) as CatalogSection[]) {
    const saved = cat && typeof cat === "object" && Array.isArray(cat[sec]) ? cat[sec] : [];
    // deno-lint-ignore no-explicit-any
    const list: any[] = saved.filter((x: any) => x && typeof x === "object" && typeof x.key === "string" && x.key.trim());
    BASE_LISTS[sec].forEach((k) => { if (!list.some((x) => x.key === k)) list.push({ key: k, label: BASE_LABELS[sec][k] || k }); });
    out[sec] = list
      .filter((x) => !x.deleted && (x.active !== false || (sec === "stages" && STAGE_CORE.includes(x.key))))
      .map((x) => { const key = sec === "stages" ? renamedKey(keys, x.key) : x.key; return { key, label: typeof x.label === "string" && x.label.trim() ? x.label.trim() : key }; });
  }
  return out as CatalogLists;
}
// A value matched to a list entry by its key or its label, any case: the entry's key, or null.
export function catalogMatch(list: { key: string; label: string }[], v: string): string | null {
  const s = v.trim().toLowerCase();
  const hit = list.find((x) => x.key.toLowerCase() === s) || list.find((x) => x.label.toLowerCase() === s);
  return hit ? hit.key : null;
}
// ── role scope: the app's canViewSection / filterForProfile (index.html), parity-tested ──
// Pure: a profile in the app's shape, rows in the database's shape. run_tests.sh extracts the live app functions and
// tests.ts checks every profile × section and every row filter against them.
// deno-lint-ignore no-explicit-any
export type Profile = { id: string; fullName: string; role: string; technicianName: string; permissions: Record<string, any> };
// deno-lint-ignore no-explicit-any
export function appProfile(row: any): Profile {
  return {
    id: row.id, fullName: row.full_name || "", role: row.role, technicianName: row.technician_name || "",
    permissions: row.permissions && typeof row.permissions === "object" && !Array.isArray(row.permissions) ? row.permissions : {},
  };
}
// Verbatim from index.html.
export function canViewSection(profile: Profile, section: string): boolean {
  if (section === "settings") return profile.role === "owner";
  // Dashboard: the whole-business summary (money, marketing, team) — owners/managers only, not grantable.
  if (section === "dashboard") return profile.role === "owner" || profile.role === "manager";
  // My Day: Ron's daily work list, built from the CRM — anyone who works the CRM gets it, nobody else.
  if (section === "myDay") return profile.role === "owner" || profile.role === "manager" || (profile.role === "va" && !!profile.permissions.crm);
  if (profile.role === "owner" || profile.role === "manager") return true;
  return !!profile.permissions[section];
}
// A task row's people as the app sees them: the app maps the row first (mapTaskRow: assignees || [], assigned_to → the
// legacy assignedTo), then reads either shape (assigneeNames).
// deno-lint-ignore no-explicit-any
export function assigneeNames(t: any): string[] {
  const assignees = t.assignees || [], assignedTo = t.assigned_to || "";
  if (Array.isArray(assignees)) return assignees;
  if (assignedTo) return [assignedTo];
  return [];
}
// deno-lint-ignore no-explicit-any
export function taskAssignedTo(t: any, p: Profile) { const names = assigneeNames(t); return names.includes(p.fullName) || (!!p.technicianName && names.includes(p.technicianName)); }
// Who may make and use keys: owners and managers only (Ofek 15 Oct). A permissions.mcp left on a profile from before
// means nothing.
export const canUseMcp = (p: Profile) => p.role === "owner" || p.role === "manager";
export type Scope = ReturnType<typeof scopeOf>;
// The conditions of filterForProfile (owners and managers see everything first, as the app).
export function scopeOf(p: Profile) {
  const P = p.permissions, isOM = p.role === "owner" || p.role === "manager", isTech = p.role === "technician";
  const canSeeJobs = isOM || !!P.jobs || !!P.finance || (isTech && !!P.payroll);
  return {
    p, isOM, isTech, techName: p.technicianName,
    canSeeJobs, canSeeEquip: canSeeJobs || !!P.closings,
    contacts: isOM || !!P.crm || !!P.crmOverview,
    tasks: isOM || !!P.tasks,
    closings: isOM || !!P.closings,
    payName: p.technicianName || p.fullName,
  };
}
// Row filters. For everyone but a technician they give exactly the app's rows. SERVER-ONLY STRICTER RULES for a
// technician (the "a technician never sees money" rule), so a technician gets a subset of the app's rows:
//   (a) closings: only their own (the app shows all closings to anyone with the Closings page);
//   (b) no technician name = no jobs or equipment (the app would match the unassigned rows);
//   (c) a contact's estimated and sales value are removed (redactForTech);
//   (d) money_summary, marketing_summary and list_outstanding are never offered, even when those pages are granted.
// deno-lint-ignore no-explicit-any
export const jobVisible = (s: Scope, row: any) => s.isOM || (s.canSeeJobs && (!s.isTech || (!!s.techName && row.technician === s.techName)));
// deno-lint-ignore no-explicit-any
export const equipVisible = (s: Scope, row: any) => s.isOM || (s.canSeeEquip && (!s.isTech || (!!s.techName && row.technician === s.techName)));
// deno-lint-ignore no-explicit-any
export const taskVisible = (s: Scope, row: any) => s.isOM || (s.tasks && (!s.isTech || taskAssignedTo(row, s.p) || (!!s.techName && row.board === s.techName)));
export const contactVisible = (s: Scope) => s.contacts;
// deno-lint-ignore no-explicit-any
export const closingVisible = (s: Scope, row: any) => s.isOM || (s.closings && (!s.isTech || (!!s.techName && row.technician_name === s.techName)));
// RLS-ONLY RULES: what the database itself lets the app read (the app asks no section for these, so the parity tests
// pin them to the policies, not to canViewSection):
//   ad_spend: owners, managers, and anyone with the Leads & Marketing (crmOverview) or Google Ads (adsGoogle) page;
//   ad_calls: owners and managers.
export const adSpendVisible = (s: Scope) => s.isOM || !!s.p.permissions.crmOverview || !!s.p.permissions.adsGoogle;
export const adCallsVisible = (s: Scope) => s.isOM;
// deno-lint-ignore no-explicit-any
export function redactForTech(s: Scope, row: any) {
  if (!s.isTech) return row;
  const { estimated_value: _e, sales_value: _s, ...rest } = row;
  return rest;
}
// ── end role scope ──

// ── calc: ported from index.html (parity-tested) ──
// The same names and formulas as the app, with an explicit context instead of STATE.data: d = { gstRate, catalog, tz,
// today, employees, rules, weekCache, jobs, equipmentSpend, payrollWeeks, payrollBonuses, salesLogs } (app-shaped rows).
// Dates are plain 'YYYY-MM-DD' strings with UTC math, so the answer never depends on the machine's time zone.
// deno-lint-ignore no-explicit-any
export type Calc = Record<string, any>;
export const PAYROLL_HOURLY_RATE = 10;
export const PAYROLL_BOOKING_BONUS = [{ min: 12, bonus: 25 }, { min: 8, bonus: 15 }, { min: 5, bonus: 10 }];
export function round2(n: unknown) { return Math.round((Number(n) || 0) * 100) / 100; }
// deno-lint-ignore no-explicit-any
const localDay = (d: Calc, ts: any) => { if (!ts) return ""; const s = String(ts); return s.length <= 10 ? s : bizParts(Date.parse(s), d.tz).day; };
// deno-lint-ignore no-explicit-any
export function weekRules(region: any) {
  const list = (region && Array.isArray(region.weeks) ? region.weeks : [])
    // deno-lint-ignore no-explicit-any
    .filter((x: any) => x && Number.isInteger(x.weekStart) && x.weekStart >= 0 && x.weekStart <= 6 && /^\d{4}-\d{2}-\d{2}$/.test(String(x.from || "")))
    // deno-lint-ignore no-explicit-any
    .map((x: any) => ({ weekStart: x.weekStart, from: x.from }))
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
    // deno-lint-ignore no-explicit-any
    .filter((x: any, i: number, a: any[]) => i === a.length - 1 || a[i + 1].from !== x.from);
  return [{ weekStart: 0, from: "" }, ...list];
}
// The business week a day falls in: { start, end, days } (the app's weekBounds, with UTC day math).
// deno-lint-ignore no-explicit-any
export function weekBounds(dateStr: string, rules: { weekStart: number; from: string }[], cache?: Map<string, any>) {
  const d = String(dateStr).slice(0, 10);
  if (cache && cache.has(d)) return cache.get(d);
  let i = rules.length - 1; while (i > 0 && rules[i].from > d) i--;
  const r = rules[i], next = rules[i + 1] ? rules[i + 1].from : null;
  const back = (x: string, w: number) => shiftDay(x, -((dowOf(x) - w + 7) % 7));
  let start = "", end = "";
  if (r.from) {
    const k = (r.weekStart - dowOf(r.from) + 7) % 7, first = shiftDay(r.from, k === 0 ? 7 : k >= 4 ? k : k + 7);
    if (d < first) { start = r.from; end = shiftDay(first, -1); }
  }
  if (!start) { start = back(d, r.weekStart); end = shiftDay(start, 6); }
  if (next && end >= next) end = shiftDay(next, -1);
  const out = { start, end, days: dayDiff(start, end) + 1 };
  if (cache) cache.set(d, out);
  return out;
}
export function payrollWeekOf(d: Calc, dateStr: string) { const b = weekBounds(dateStr, d.rules, d.weekCache); return { key: b.start, start: b.start, end: b.end }; }
// Walks real business weeks (not 7 days), so a short or long transition week is one step.
export function shiftPayrollWeek(d: Calc, weekKey: string, deltaWeeks: number) {
  let k = weekBounds(weekKey, d.rules, d.weekCache).start;
  const n = Math.trunc(Number(deltaWeeks) || 0);
  for (let i = 0; i < Math.abs(n); i++) k = n > 0 ? shiftDay(weekBounds(k, d.rules, d.weekCache).end, 1) : weekBounds(shiftDay(k, -1), d.rules, d.weekCache).start;
  return k;
}
// deno-lint-ignore no-explicit-any
export const jobPaidDate = (j: any) => j.datePaid || j.date;
// deno-lint-ignore no-explicit-any
export function jobGst(d: Calc, job: any) { return job.includesGST ? round2(job.amount * (d.gstRate / 100)) : 0; }
// deno-lint-ignore no-explicit-any
export function jobTotalCollected(d: Calc, job: any) { return round2(job.amount + jobGst(d, job)); }
// deno-lint-ignore no-explicit-any
const employeeByName = (d: Calc, name: string) => (d.employees || []).find((e: any) => e.name === name) || null;
export function commissionDeductsParts(d: Calc, techName: string) { const e = employeeByName(d, techName); return !(e && e.employmentType === "Independent Contractor"); }
// deno-lint-ignore no-explicit-any
export function jobCommissionBase(d: Calc, job: any) {
  const parts = commissionDeductsParts(d, job.technician) ? (Number(job.partsCost) || 0) : 0;
  return Math.max(0, (Number(job.amount) || 0) - parts);
}
// deno-lint-ignore no-explicit-any
export function jobCommissionAmount(d: Calc, job: any) { return round2(jobCommissionBase(d, job) * (Number(job.commissionPercent) || 0) / 100); }
// deno-lint-ignore no-explicit-any
export function payTiersOk(t: any) {
  if (!Array.isArray(t)) return null;
  return t.map((x) => ({ min: Math.round(Number(x && x.min)), bonus: Number(x && x.bonus) }))
    .filter((x) => x.min >= 1 && x.min <= 500 && Number.isFinite(x.bonus) && x.bonus >= 0 && x.bonus <= 10000)
    .sort((a, b) => b.min - a.min).filter((x, i, a) => !i || a[i - 1].min !== x.min);
}
export function payHourlyFor(d: Calc, day: string) {
  const dd = day || d.today;
  const pay = (d.catalog && d.catalog.pay) || {};
  const all = Array.isArray(pay.hourly) ? pay.hourly : [];
  // deno-lint-ignore no-explicit-any
  const v = all.filter((x: any) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.from) && x.from <= dd).sort((a: any, b: any) => a.from < b.from ? 1 : -1)[0];
  const rate = v ? Number(v.rate) : NaN, tiers = v ? payTiersOk(v.tiers) : null;
  return { rate: v && v.rate !== null && v.rate !== "" && Number.isFinite(rate) && rate >= 0 && rate <= 500 ? rate : PAYROLL_HOURLY_RATE, tiers: tiers || PAYROLL_BOOKING_BONUS, from: v ? v.from : null };
}
export function bookingBonus(d: Calc, bookings: number, day: string) { const t = payHourlyFor(d, day).tiers.find((t) => (Number(bookings) || 0) >= t.min); return t ? t.bonus : 0; }
// deno-lint-ignore no-explicit-any
export function salesLogBookings(l: any) { return (Number(l.bookingsAircon) || 0) + (Number(l.bookingsChimney) || 0) + (Number(l.bookingsPw) || 0); }
// deno-lint-ignore no-explicit-any
export function salesLogPay(d: Calc, l: any) { return round2((Number(l.hours) || 0) * payHourlyFor(d, l.date).rate + bookingBonus(d, salesLogBookings(l), l.date)); }
export function payrollStatus(d: Calc, weekKey: string, person: string) {
  // deno-lint-ignore no-explicit-any
  return (d.payrollWeeks || []).find((r: any) => r.weekKey === weekKey && r.person === person) || { weekKey, person, cashCollected: false, salaryPaid: false };
}
export function payrollBonusesFor(d: Calc, person: string, weekKey: string) {
  // deno-lint-ignore no-explicit-any
  const lines = (d.payrollBonuses || []).filter((b: any) => b.person === person && b.weekKey === weekKey).sort((a: any, b: any) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  // deno-lint-ignore no-explicit-any
  return { lines, total: round2(lines.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0)) };
}
export function materialsGst(d: Calc, amount: number) { const r = Number(d.gstRate) || 0; return round2((Number(amount) || 0) * r / (100 + r)); }
export function payrollMaterialItems(d: Calc, person: string) {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  // deno-lint-ignore no-explicit-any
  (d.equipmentSpend || []).forEach((e: any) => {
    if (e.paidBy !== person || !((Number(e.cost) || 0) > 0) || (e.reimbursed !== "Pending" && e.reimbursed !== "Reimbursed")) return;
    out.push({ kind: "equipment", id: e.id, bought: e.date, entered: e.createdAt ? localDay(d, e.createdAt) : e.date, amount: round2(e.cost), paid: e.reimbursed === "Reimbursed", paidWeek: e.reimbursedWeek || null });
  });
  // deno-lint-ignore no-explicit-any
  (d.jobs || []).forEach((j: any) => {
    if (j.partsPaidBy !== person || !((Number(j.partsCost) || 0) > 0) || (j.partsRefundStatus !== "Pending Refund" && j.partsRefundStatus !== "Refunded")) return;
    out.push({ kind: "parts", id: j.id, bought: j.date, entered: j.partsPendingAt ? localDay(d, j.partsPendingAt) : j.date, amount: round2(j.partsCost), paid: j.partsRefundStatus === "Refunded", paidWeek: j.partsRefundWeek || null });
  });
  return out;
}
// Week = the week it was entered; a week already marked paid takes nothing new (it goes to the next week not paid yet).
export function computePayrollMaterials(d: Calc, person: string, weekKey: string) {
  const weekPaid = !!payrollStatus(d, weekKey, person).salaryPaid;
  const weekFor = (entered: string) => { let wk = payrollWeekOf(d, entered).key; for (let i = 0; i < 104 && payrollStatus(d, wk, person).salaryPaid; i++) wk = shiftPayrollWeek(d, wk, 1); return wk; };
  const lines = payrollMaterialItems(d, person).filter((it) => it.paid ? it.paidWeek === weekKey : (!weekPaid && weekFor(it.entered) === weekKey))
    .sort((a, b) => a.entered.localeCompare(b.entered) || String(a.bought).localeCompare(String(b.bought)));
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { lines, total, gst: materialsGst(d, total) };
}
// A commission person's week: commission lands in the week the job was PAID; a job on hold ("Stuck") stays out.
export function computePayrollCommission(d: Calc, person: string, weekKey: string) {
  const wk = payrollWeekOf(d, weekKey);
  // deno-lint-ignore no-explicit-any
  const mine = (d.jobs || []).filter((j: any) => j.technician === person);
  // deno-lint-ignore no-explicit-any
  const paid = mine.filter((j: any) => j.paymentStatus === (d.paidKey || "Paid") && jobPaidDate(j) >= wk.start && jobPaidDate(j) <= wk.end);
  // deno-lint-ignore no-explicit-any
  const toLine = (j: any) => ({ job: j, commission: jobCommissionAmount(d, j) });
  // deno-lint-ignore no-explicit-any
  const lines = paid.filter((j: any) => j.paidToTechnician !== "Stuck").map(toLine);
  // deno-lint-ignore no-explicit-any
  const onHold = paid.filter((j: any) => j.paidToTechnician === "Stuck").map(toLine);
  // deno-lint-ignore no-explicit-any
  const unpaid = mine.filter((j: any) => j.paymentStatus !== (d.paidKey || "Paid") && j.date <= wk.end);
  // deno-lint-ignore no-explicit-any
  const cashJobs = paid.filter((j: any) => j.paymentMethod === "Cash");
  // deno-lint-ignore no-explicit-any
  const pctSource = lines.length ? lines.map((l: any) => l.job) : unpaid;
  // deno-lint-ignore no-explicit-any
  const pcts = Array.from(new Set(pctSource.map((j: any) => Number(j.commissionPercent) || 0)));
  // deno-lint-ignore no-explicit-any
  const total = round2(lines.reduce((s: number, l: any) => s + l.commission, 0));
  const materials = computePayrollMaterials(d, person, weekKey);
  const bonus = payrollBonusesFor(d, person, wk.key);
  return {
    person, week: { start: wk.start, end: wk.end }, total,
    materials: { total: materials.total, gst: materials.gst, count: materials.lines.length },
    bonus: { total: bonus.total }, grandTotal: round2(total + materials.total + bonus.total),
    // deno-lint-ignore no-explicit-any
    onHoldTotal: round2(onHold.reduce((s: number, l: any) => s + l.commission, 0)),
    // deno-lint-ignore no-explicit-any
    expected: round2(unpaid.reduce((s: number, j: any) => s + jobCommissionAmount(d, j), 0)),
    // deno-lint-ignore no-explicit-any
    cash: round2(cashJobs.reduce((s: number, j: any) => s + jobTotalCollected(d, j), 0)),
    paidJobs: lines.length, unpaidJobs: unpaid.length, percent: pcts.length === 1 ? pcts[0] : null,
  };
}
// An hourly person's week: hours × that day's rate + the day's booking bonus, plus the owners' bonuses.
export function computePayrollHourly(d: Calc, person: string, weekKey: string) {
  const wk = payrollWeekOf(d, weekKey);
  // deno-lint-ignore no-explicit-any
  const logs = (d.salesLogs || []).filter((l: any) => l.person === person && l.date >= wk.start && l.date <= wk.end);
  const days: { hours: number; bookings: number; bonus: number; pay: number }[] = [];
  // At most 13 days (the longest transition week), and nothing for a key that isn't a real date.
  for (let date = wk.start, i = 0; /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= wk.end && i < 13; date = shiftDay(date, 1), i++) {
    // deno-lint-ignore no-explicit-any
    const l = logs.find((x: any) => x.date === date) || null;
    const bookings = l ? salesLogBookings(l) : 0;
    days.push({ hours: l ? (Number(l.hours) || 0) : 0, bookings, bonus: l ? bookingBonus(d, bookings, date) : 0, pay: l ? salesLogPay(d, l) : 0 });
  }
  const extra = payrollBonusesFor(d, person, wk.key);
  return {
    person, week: { start: wk.start, end: wk.end },
    hours: round2(days.reduce((s, x) => s + x.hours, 0)),
    bookings: days.reduce((s, x) => s + x.bookings, 0),
    bonuses: days.reduce((s, x) => s + x.bonus, 0),
    total: round2(days.reduce((s, x) => s + x.pay, 0) + extra.total),
    extra: { total: extra.total },
  };
}
// deno-lint-ignore no-explicit-any
export function payrollCommissionPeople(d: Calc): string[] { return (d.employees || []).filter((e: any) => e.status === "Active" && e.roles.includes("Technician") && !e.roles.includes("Owner")).map((e: any) => e.name); }
// deno-lint-ignore no-explicit-any
export function payrollHourlyPeople(d: Calc): string[] { return (d.employees || []).filter((e: any) => e.status === "Active" && e.employmentType === "Hourly").map((e: any) => e.name); }
// The money part of the app's computeWeek (overview + remainingAfterTech) over any set of jobs and equipment. Not the
// paid-to-technician total, which needs the per-person payroll.
// deno-lint-ignore no-explicit-any
export function moneyOverview(d: Calc, jobs: any[], equip: any[]) {
  const overview = { cash: 0, bankTransfer: 0, creditCard: 0, gstCash: 0, gstOther: 0, paidCount: 0, unpaidCount: 0, paidTotal: 0, unpaidTotal: 0, partsTotal: 0, equipmentTotal: 0, commissionOwedTotal: 0 };
  jobs.forEach((j) => {
    const total = jobTotalCollected(d, j); const gst = jobGst(d, j);
    // Money in and GST collected count PAID jobs only.
    if (j.paymentStatus === (d.paidKey || "Paid")) {
      if (j.paymentMethod === "Cash") { overview.cash += total; overview.gstCash += gst; }
      else if (j.paymentMethod === "Bank Transfer") { overview.bankTransfer += total; overview.gstOther += gst; }
      else if (j.paymentMethod === "Credit Card") { overview.creditCard += total; overview.gstOther += gst; }
      overview.paidCount++; overview.paidTotal += j.amount;
    } else { overview.unpaidCount++; overview.unpaidTotal += j.amount; }
    overview.partsTotal += Number(j.partsCost) || 0;
    overview.commissionOwedTotal += jobCommissionAmount(d, j);
  });
  equip.forEach((e) => { overview.equipmentTotal += Number(e.cost) || 0; });
  const remainingAfterTech = jobs.reduce((s, j) => s + (Number(j.amount) || 0), 0) - overview.commissionOwedTotal - overview.partsTotal - overview.equipmentTotal;
  return { overview, remainingAfterTech };
}
// Database rows → the app's shapes (the app's mapJobRow / mapEquipSpendRow / mapPayrollRow / mapBonusRow /
// mapSalesLogRow, the fields the calc reads), with the same defaults so the numbers match.
// deno-lint-ignore no-explicit-any
export function jobFromRow(j: any) {
  return {
    id: j.id, customerName: j.customer_name, invoiceNumber: j.invoice_number || "", date: j.date,
    technician: j.technician, jobType: j.job_type, commissionPercent: j.commission_percent || 0,
    amount: j.amount || 0, includesGST: j.includes_gst, paymentStatus: j.payment_status,
    paymentMethod: j.payment_method || "", partsCost: j.parts_cost || 0, partsPaidBy: j.parts_paid_by || "",
    partsRefundStatus: j.parts_refund_status || "N/A", datePaid: j.date_paid, paidToTechnician: j.paid_to_technician,
    partsPendingAt: j.parts_pending_at || null, partsRefundWeek: j.parts_refund_week || null, contactId: j.contact_id || null,
  };
}
// deno-lint-ignore no-explicit-any
export function equipFromRow(e: any) {
  return { id: e.id, date: e.date, item: e.item, technician: e.technician, paidBy: e.paid_by || "", cost: e.cost || 0, reimbursed: e.reimbursed, createdAt: e.created_at || null, reimbursedWeek: e.reimbursed_week || null };
}
// deno-lint-ignore no-explicit-any
export function payrollFromRow(r: any) {
  return { id: r.id, weekKey: r.week_start, person: r.person, cashCollected: !!r.cash_collected, salaryPaid: !!r.salary_paid, salaryPaidAmount: r.salary_paid_amount === null || r.salary_paid_amount === undefined ? null : Number(r.salary_paid_amount) };
}
// deno-lint-ignore no-explicit-any
export function bonusFromRow(b: any) { return { id: b.id, weekKey: b.week_start, person: b.person, amount: Number(b.amount) || 0, reason: b.reason || "", createdAt: b.created_at }; }
// deno-lint-ignore no-explicit-any
export function salesLogFromRow(l: any) {
  return { id: l.id, person: l.person, date: l.date, hours: Number(l.hours) || 0, bookingsAircon: Number(l.bookings_aircon) || 0, bookingsChimney: Number(l.bookings_chimney) || 0, bookingsPw: Number(l.bookings_pw) || 0 };
}
// deno-lint-ignore no-explicit-any
export const employeeFromRow = (e: any) => ({ name: e.name, roles: e.roles || [], status: e.status, employmentType: e.employment_type || "" });
// ── end calc ──
// ── shared: role scope + money END ──

// ── data access (service role; every read pages and names its columns) ──
// The business's name, GST rate, catalog and time zone (settings.catalog.region.timeZone). Read per request (never cached across requests).
// deno-lint-ignore no-explicit-any
export async function loadBusiness(sb: any) {
  const { data: st, error } = await sb.from("settings").select("company_name, gst_rate_percent, catalog").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message || "settings");
  const catalog = st && st.catalog && typeof st.catalog === "object" && !Array.isArray(st.catalog) ? st.catalog : {};
  // Settings → Region and format (stage 1): the one time zone of the business, as every other function reads it.
  const tz = bizTzOf(catalog);
  const gst = st ? Number(st.gst_rate_percent ?? 10) : 10;
  return { companyName: (st && st.company_name) || "", gstRate: Number.isFinite(gst) ? gst : 10, catalog, tz, office: officeOf(catalog), mcp: mcpSettings(catalog) };
}
// The office's name (Settings → Phone, catalog.labels.office; nothing saved = "Office"), as the app's officeLabel() and
// automations' officeOf(). The office board's storage key stays 'ron'; nobody is ever shown that key.
// deno-lint-ignore no-explicit-any
export function officeOf(cat: any): string {
  const labels = cat && typeof cat === "object" && cat.labels && typeof cat.labels === "object" ? cat.labels : {};
  const v = String(labels.office || "").trim(); return v ? v.slice(0, 30) : "Office";
}
export type Biz = Awaited<ReturnType<typeof loadBusiness>>;
const JOB_COLS = "id, customer_name, invoice_number, date, technician, job_type, commission_percent, amount, includes_gst, payment_status, payment_method, parts_cost, parts_paid_by, parts_refund_status, date_paid, paid_to_technician, parts_pending_at, parts_refund_week, contact_id";
const EQUIP_COLS = "id, date, item, technician, paid_by, cost, reimbursed, created_at, reimbursed_week";
const CONTACT_COLS = "id, full_name, phone, email, postcode, division, source, status, created_at, next_follow_up, tags, estimated_value, sales_value";
const TASK_COLS = "id, title, board, status, due, heads_up, priority, assignees, assigned_to, client, category, notes, subtasks, contact_id";
const CALL_COLS = "id, direction, from_number, to_number, status, missed, answered_by, duration, voicemail, started_at, callback_done_at, contact_id";
// A job's payment status is not 'Paid' (a missing status counts as unpaid, as in the app).
// Jobs not paid yet: no status, or any status but the business's word for Paid (catalog.keys.paid, default "Paid").
const notPaid = (c: Ctx) => `payment_status.is.null,payment_status.neq."${catalogKeys(c.biz.catalog).paid}"`;
// The calc context for a tool: the business's numbers plus the employees (names, roles and pay type only).
// deno-lint-ignore no-explicit-any
async function calcCtx(c: Ctx, data: Record<string, any[]> = {}): Promise<Calc> {
  const { rows } = await pageAll((a, z) => c.sb.from("employees").select("name, roles, status, employment_type").order("name").range(a, z));
  return {
    gstRate: c.biz.gstRate, catalog: c.biz.catalog, tz: c.biz.tz, today: bizParts(c.nowMs, c.biz.tz).day, paidKey: catalogKeys(c.biz.catalog).paid,
    employees: rows.map(employeeFromRow), rules: weekRules(c.biz.catalog.region), weekCache: new Map(),
    jobs: [], equipmentSpend: [], payrollWeeks: [], payrollBonuses: [], salesLogs: [], ...data,
  };
}

// ── tools (all read-only; each declares who can use it, and is left out of tools/list for anyone else) ──
// deno-lint-ignore no-explicit-any
export type Ctx = { sb: any; s: Scope; biz: Biz; nowMs: number; token?: any };
// deno-lint-ignore no-explicit-any
export type Tool = { name: string; title: string; description: string; inputSchema: any; gate: (s: Scope) => boolean; run: (c: Ctx, args: any) => Promise<{ payload: any; rows: number }> };
export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// deno-lint-ignore no-explicit-any
const obj = (properties: Record<string, any>) => ({ type: "object", properties, additionalProperties: false });
const LIMIT = { type: "integer", minimum: 1, maximum: MAX_ROWS, default: DEFAULT_LIMIT, description: `How many rows at most (1–${MAX_ROWS}, default ${DEFAULT_LIMIT}).` };
const FROM = { type: "string", format: "date", description: "First day, YYYY-MM-DD in the business's time zone (default: 30 days before 'to')." };
const TO = { type: "string", format: "date", description: "Last day, YYYY-MM-DD (default: today)." };
// A list answer: the first `limit` rows, how many matched, and whether there are more than shown.
// deno-lint-ignore no-explicit-any
function listOf(all: any[], limit: number, scanTruncated: boolean, extra: Record<string, any> = {}) {
  const rows = all.slice(0, limit);
  return { payload: { rows, count: all.length, truncated: scanTruncated || all.length > limit, ...extra }, rows: rows.length };
}
// deno-lint-ignore no-explicit-any
function contactOut(c: Ctx, r: any) {
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {
    id: r.id, name: r.full_name || "", phone: r.phone || "", email: r.email || "", postcode: r.postcode || "", division: r.division || "",
    source: r.source || "", status: r.status || "", createdOn: r.created_at ? localDay({ tz: c.biz.tz }, r.created_at) : "",
    nextFollowUp: r.next_follow_up || null, tags: Array.isArray(r.tags) ? r.tags : [],
  };
  if ("estimated_value" in r) out.estimatedValue = round2(r.estimated_value);
  if ("sales_value" in r) out.salesValue = round2(r.sales_value);
  return out;
}
// The notes on a customer as the app shows them (leadNotes): contacts.customer_notes [{ id, text, by, at }] newest first,
// then a note written before those existed (the legacy contacts.notes) as the oldest. At most 20, each clipped.
// deno-lint-ignore no-explicit-any
export function customerNotesOut(r: any) {
  // deno-lint-ignore no-explicit-any
  const list = (Array.isArray(r.customer_notes) ? r.customer_notes : []).filter((n: any) => n && typeof n === "object" && n.text)
    // deno-lint-ignore no-explicit-any
    .sort((x: any, y: any) => String(y.at || "").localeCompare(String(x.at || "")))
    // deno-lint-ignore no-explicit-any
    .map((n: any) => ({ text: clip(n.text, 500), by: clip(n.by, 80), at: n.at || null }));
  if (r.notes) list.push({ text: clip(r.notes, 2000), by: "", at: null });
  return list.slice(0, 20);
}
// deno-lint-ignore no-explicit-any
function jobOut(d: Calc, row: any) {
  const j = jobFromRow(row);
  return {
    id: j.id, date: j.date, customerName: j.customerName || "", invoiceNumber: j.invoiceNumber, technician: j.technician || "", jobType: j.jobType || "",
    amount: round2(j.amount), gst: jobGst(d, j), total: jobTotalCollected(d, j), commission: jobCommissionAmount(d, j),
    paymentStatus: j.paymentStatus || "", paymentMethod: j.paymentMethod, datePaid: j.datePaid || null, partsCost: round2(j.partsCost), contactId: j.contactId,
  };
}
// deno-lint-ignore no-explicit-any
function taskOut(c: Ctx, t: any) {
  return {
    id: t.id, title: t.title || "", board: t.board === "ron" ? c.biz.office : (t.board || ""), status: t.status || "", due: t.due || null, headsUp: t.heads_up || null, priority: t.priority || "",
    assignees: assigneeNames(t), client: t.client || "", category: t.category || "", notes: clip(t.notes, 300), subtasks: Array.isArray(t.subtasks) ? t.subtasks.length : 0,
  };
}
// deno-lint-ignore no-explicit-any
const sumBy = (rows: any[], key: (r: any) => string, val: (r: any) => number = () => 1) => {
  const out: Record<string, number> = {};
  rows.forEach((r) => { const k = key(r) || "(none)"; out[k] = round2((out[k] || 0) + val(r)); });
  return out;
};
// deno-lint-ignore no-explicit-any
async function adSpendIn(c: Ctx, from: string, to: string) {
  const { rows, truncated } = await pageAll((a, z) => c.sb.from("ad_spend").select("id, date, channel, spend, leads_reported").gte("date", from).lte("date", to).order("date").range(a, z));
  return {
    // deno-lint-ignore no-explicit-any
    total: round2(rows.reduce((s: number, r: any) => s + (Number(r.spend) || 0), 0)),
    // deno-lint-ignore no-explicit-any
    byChannel: sumBy(rows, (r) => r.channel, (r: any) => Number(r.spend) || 0),
    // deno-lint-ignore no-explicit-any
    leadsReported: rows.reduce((s: number, r: any) => s + (Number(r.leads_reported) || 0), 0),
    truncated,
  };
}

// search_contacts' phone part: the query's last 8 digits in a row, whatever spaces, dashes or brackets sit between
// them in the stored number ('0491 570 006', '+61 491-570-006'), as a PostgREST regex (match). '' under 4 digits.
export function phoneClause(q: string): string {
  const digits = String(q || "").replace(/\D/g, "");
  return digits.length >= 4 ? `,phone.match."${digits.slice(-8).split("").join("[^0-9]*")}"` : "";
}

export const TOOLS: Tool[] = [
  {
    name: "whoami", title: "Who am I",
    description: "Who this key belongs to: name, role, business, time zone, today's date and the tools this person can use.",
    inputSchema: obj({}), gate: () => true,
    run: async (c) => {
      const p = c.s.p;
      return { payload: { name: p.fullName, role: p.role, technicianName: p.technicianName || null, business: c.biz.companyName, timeZone: c.biz.tz, today: bizParts(c.nowMs, c.biz.tz).day, tools: TOOLS.filter((t) => t.gate(c.s)).map((t) => t.name) }, rows: 1 };
    },
  },
  {
    name: "search_contacts", title: "Search contacts",
    description: "Find leads and customers by name, email, postcode or phone digits, newest first. Optional status filter.",
    inputSchema: obj({ query: { type: "string", maxLength: 60, description: "Part of a name, email, postcode or phone number." }, status: { type: "string", maxLength: 40, description: "Only this pipeline stage (exact)." }, limit: LIMIT }),
    gate: (s) => contactVisible(s),
    run: async (c, args) => {
      const q = String(args.query || "").replace(/[,()*%\\"':]/g, " ").trim();
      let b = c.sb.from("contacts").select(CONTACT_COLS);
      if (q) {
        b = b.or(`full_name.ilike.*${q}*,email.ilike.*${q}*,postcode.ilike.*${q}*` + phoneClause(q));
      }
      if (args.status) b = b.eq("status", args.status);
      // One more row than asked shows whether there are more.
      const { data, error } = await b.order("created_at", { ascending: false }).range(0, args.limit);
      if (error) throw new Error(error.message);
      // deno-lint-ignore no-explicit-any
      const all = (data || []).map((r: any) => contactOut(c, redactForTech(c.s, r)));
      return listOf(all.slice(0, args.limit), args.limit, all.length > args.limit);
    },
  },
  {
    name: "get_contact", title: "Get a contact",
    description: "One lead or customer in full: details, the notes on the customer (newest first, with who wrote them and when), the last 10 messages, their jobs, tasks and (with CRM access) the last 10 calls.",
    inputSchema: { ...obj({ id: { type: "string", format: "uuid", description: "The contact's id (from search_contacts)." } }), required: ["id"] },
    gate: (s) => contactVisible(s),
    run: async (c, args) => {
      const { data: row, error } = await c.sb.from("contacts").select(CONTACT_COLS + ", notes, customer_notes, followup_note, job_description, lost_reason, sub_source, messages").eq("id", args.id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) throw new ToolError("No contact with that id.");
      const r = redactForTech(c.s, row);
      const d = await calcCtx(c);
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      // deno-lint-ignore no-explicit-any
      const messages = msgs.slice(-10).map((m: any) => ({ at: (m && m.at) || null, kind: (m && m.kind) || "", direction: (m && m.direction) || "", author: (m && m.author) || "", text: clip(m && m.text, 500) }));
      const jobs = c.s.canSeeJobs ? (await pageAll((a, z) => c.sb.from("jobs").select(JOB_COLS).eq("contact_id", args.id).order("date", { ascending: false }).range(a, z), 2 * PAGE)).rows
        // deno-lint-ignore no-explicit-any
        .filter((j: any) => jobVisible(c.s, j)).map((j: any) => jobOut(d, j)) : [];
      const tasks = c.s.tasks ? (await pageAll((a, z) => c.sb.from("tasks").select(TASK_COLS).eq("contact_id", args.id).order("id").range(a, z), 2 * PAGE)).rows
        // deno-lint-ignore no-explicit-any
        .filter((t: any) => taskVisible(c.s, t)).map((t: any) => taskOut(c, t)) : [];
      let calls = null;
      if (canViewSection(c.s.p, "crm")) {
        const { data: cl, error: ce } = await c.sb.from("calls").select(CALL_COLS).eq("contact_id", args.id).order("started_at", { ascending: false }).range(0, 9);
        if (ce) throw new Error(ce.message);
        // deno-lint-ignore no-explicit-any
        calls = (cl || []).map((k: any) => callOut(k, null));
      }
      const payload = {
        ...contactOut(c, r), customerNotes: customerNotesOut(r), followupNote: clip(r.followup_note, 500), jobDescription: clip(r.job_description, 1000),
        lostReason: r.lost_reason || "", subSource: r.sub_source || "", messages, jobs, tasks, ...(calls ? { calls } : {}),
      };
      return { payload, rows: 1 };
    },
  },
  {
    name: "list_jobs", title: "List jobs",
    description: "Jobs between two days, newest first: amount before GST, GST, total, commission, payment status and method. A technician sees only their own jobs.",
    inputSchema: obj({ from: FROM, to: TO, technician: { type: "string", maxLength: 60, description: "Only this technician's jobs." }, unpaid_only: { type: "boolean", description: "Only jobs not paid yet." }, limit: LIMIT }),
    gate: (s) => s.canSeeJobs,
    run: async (c, args) => {
      const r = rangeOf(args, c.biz.tz, c.nowMs);
      if (c.s.isTech && args.technician !== undefined && args.technician !== c.s.techName) throw new ToolError("You can only see your own jobs.");
      const tech = c.s.isTech ? c.s.techName : args.technician;
      if (c.s.isTech && !tech) return listOf([], args.limit, false, { from: r.from, to: r.to });
      const { rows, truncated } = await pageAll((a, z) => {
        let b = c.sb.from("jobs").select(JOB_COLS).gte("date", r.from).lte("date", r.to);
        if (tech) b = b.eq("technician", tech);
        if (args.unpaid_only) b = b.or(notPaid(c));
        return b.order("date", { ascending: false }).order("id").range(a, z);
      });
      const d = await calcCtx(c);
      // deno-lint-ignore no-explicit-any
      const all = rows.filter((j: any) => jobVisible(c.s, j)).map((j: any) => jobOut(d, j));
      return listOf(all, args.limit, truncated, { from: r.from, to: r.to });
    },
  },
  {
    name: "list_closings", title: "List closings",
    description: "Closings (finished jobs posted with their payment) between two days, newest first. A technician sees only their own.",
    inputSchema: obj({ from: FROM, to: TO, limit: LIMIT }),
    gate: (s) => s.closings,
    run: async (c, args) => {
      const r = rangeOf(args, c.biz.tz, c.nowMs);
      if (c.s.isTech && !c.s.techName) return listOf([], args.limit, false, { from: r.from, to: r.to });
      const { rows, truncated } = await pageAll((a, z) => {
        let b = c.sb.from("closings").select("id, date, technician_name, customer_name, invoice_number, job_type, amount, includes_gst, payment_status, payment_method, parts_cost, posted_by, linked_job_id").gte("date", r.from).lte("date", r.to);
        if (c.s.isTech) b = b.eq("technician_name", c.s.techName);
        return b.order("date", { ascending: false }).order("id").range(a, z);
      });
      // deno-lint-ignore no-explicit-any
      const all = rows.filter((x: any) => closingVisible(c.s, x)).map((x: any) => ({
        id: x.id, date: x.date, technician: x.technician_name || "", customerName: x.customer_name || "", invoiceNumber: x.invoice_number || "", jobType: x.job_type || "",
        totalInclGst: round2(x.amount), includesGST: !!x.includes_gst, paymentStatus: x.payment_status || "", paymentMethod: x.payment_method || "",
        partsCost: round2(x.parts_cost), postedBy: x.posted_by || "", linkedJobId: x.linked_job_id || null,
      }));
      return listOf(all, args.limit, truncated, { from: r.from, to: r.to });
    },
  },
  {
    name: "list_outstanding", title: "Outstanding",
    description: "What is still open, as on the Outstanding page: customers who haven't paid (rows, oldest first, with days waiting), pending parts refunds and pending equipment refunds.",
    inputSchema: obj({ limit: LIMIT }),
    gate: (s) => !s.isTech && canViewSection(s.p, "outstanding"),
    run: async (c, args) => {
      const d = await calcCtx(c), today = bizParts(c.nowMs, c.biz.tz).day;
      const unpaid = await pageAll((a, z) => c.sb.from("jobs").select(JOB_COLS).or(notPaid(c)).order("date").order("id").range(a, z));
      const parts = await pageAll((a, z) => c.sb.from("jobs").select(JOB_COLS).eq("parts_refund_status", "Pending Refund").order("date").order("id").range(a, z));
      const equip = await pageAll((a, z) => c.sb.from("equipment_spend").select(EQUIP_COLS).eq("reimbursed", "Pending").order("date").order("id").range(a, z));
      // deno-lint-ignore no-explicit-any
      const rows = unpaid.rows.filter((j: any) => jobVisible(c.s, j)).map((j: any) => { const o = jobOut(d, j); return { id: o.id, date: o.date, customerName: o.customerName, invoiceNumber: o.invoiceNumber, technician: o.technician, totalInclGst: o.total, daysWaiting: dayDiff(o.date, today), paymentStatus: o.paymentStatus, contactId: o.contactId }; });
      // deno-lint-ignore no-explicit-any
      const partsRefunds = parts.rows.filter((j: any) => jobVisible(c.s, j)).slice(0, args.limit).map((j: any) => ({ id: j.id, date: j.date, customerName: j.customer_name || "", partsPaidBy: j.parts_paid_by || "", partsCost: round2(j.parts_cost) }));
      // deno-lint-ignore no-explicit-any
      const equipmentRefunds = equip.rows.filter((e: any) => equipVisible(c.s, e)).slice(0, args.limit).map((e: any) => ({ id: e.id, date: e.date, item: e.item || "", technician: e.technician || "", paidBy: e.paid_by || "", cost: round2(e.cost) }));
      return listOf(rows, args.limit, unpaid.truncated, { unpaidTotal: round2(rows.reduce((s, x) => s + x.totalInclGst, 0)), partsRefunds, equipmentRefunds });
    },
  },
  {
    name: "money_summary", title: "Money summary",
    description: "Money in a date range, as the dashboard: paid by cash / bank transfer / card (GST included), GST, paid and unpaid totals (before GST), parts, equipment, commission owed, what is left after technicians and (for those who can see ad spend) ad spend and what is left after ads.",
    inputSchema: obj({ from: FROM, to: TO }),
    gate: (s) => !s.isTech && (canViewSection(s.p, "dashboard") || !!s.p.permissions.finance),
    run: async (c, args) => {
      const r = rangeOf(args, c.biz.tz, c.nowMs);
      const jobs = await pageAll((a, z) => c.sb.from("jobs").select(JOB_COLS).gte("date", r.from).lte("date", r.to).order("date").order("id").range(a, z));
      const equip = await pageAll((a, z) => c.sb.from("equipment_spend").select(EQUIP_COLS).gte("date", r.from).lte("date", r.to).order("date").order("id").range(a, z));
      // deno-lint-ignore no-explicit-any
      const d = await calcCtx(c), J = jobs.rows.filter((j: any) => jobVisible(c.s, j)).map(jobFromRow), E = equip.rows.filter((e: any) => equipVisible(c.s, e)).map(equipFromRow);
      // Ad spend only for those the ad_spend RLS lets read it (Finance alone does not): anyone else gets no ad figures.
      const m = moneyOverview(d, J, E), ads = adSpendVisible(c.s) ? await adSpendIn(c, r.from, r.to) : null;
      const overview = Object.fromEntries(Object.entries(m.overview).map(([k, v]) => [k, k.endsWith("Count") ? v : round2(v)]));
      return {
        payload: {
          from: r.from, to: r.to, jobsCount: J.length, overview, remainingAfterTech: round2(m.remainingAfterTech),
          ...(ads ? { adSpend: { total: ads.total, byChannel: ads.byChannel }, remainingAfterTechAndAds: round2(m.remainingAfterTech - ads.total) } : {}),
          truncated: jobs.truncated || equip.truncated || !!(ads && ads.truncated),
        },
        rows: 1,
      };
    },
  },
  {
    name: "payroll_summary", title: "Payroll summary",
    description: "A business week's pay: commission (paid in the week the job was paid, on-hold jobs apart), equipment and materials paid back, bonuses, hourly pay and whether the week is marked paid. Owners and managers see everyone; anyone else only themselves.",
    inputSchema: obj({ week: { type: "string", format: "date", description: "Any day in the week (default: today)." } }),
    gate: (s) => canViewSection(s.p, "payroll"),
    run: async (c, args) => {
      const s = c.s, person = s.payName, wb = weekBounds(args.week || bizParts(c.nowMs, c.biz.tz).day, weekRules(c.biz.catalog.region));
      const d0 = { paidKey: catalogKeys(c.biz.catalog).paid };   // the business's word for Paid (catalog.keys)
      // Only the rows this week can use (the same answer as the app's computeWeek over the whole history): jobs paid in
      // the week, jobs not paid by its end (expected commission), refunds still pending or paid back this week, the
      // week's bonuses and daily logs, and the paid-week marks from the oldest pending refund on. Anyone but an owner
      // or manager: only their own rows.
      let truncated = false;
      // deno-lint-ignore no-explicit-any
      const sel = async (t: string, cols: string, own: string, f: (b: any) => any) => {
        const r = await pageAll((a, z) => { let b = f(c.sb.from(t).select(cols)); if (!s.isOM) b = b.eq(own, person); return b.order("id").range(a, z); });
        truncated = truncated || r.truncated;
        return r.rows;
      };
      const PW = "id, week_start, person, cash_collected, salary_paid, salary_paid_amount", BN = "id, week_start, person, amount, reason, created_at", SL = "id, person, date, hours, bookings_aircon, bookings_chimney, bookings_pw";
      const [paidOn, paidSameDay, unpaid, partsPending, partsDone, eqPending, eqDone, bonuses, logs] = await Promise.all([
        // deno-lint-ignore no-explicit-any
        sel("jobs", JOB_COLS, "technician", (q: any) => q.eq("payment_status", d0.paidKey).gte("date_paid", wb.start).lte("date_paid", wb.end)),
        // deno-lint-ignore no-explicit-any
        sel("jobs", JOB_COLS, "technician", (q: any) => q.eq("payment_status", d0.paidKey).is("date_paid", null).gte("date", wb.start).lte("date", wb.end)),
        // deno-lint-ignore no-explicit-any
        sel("jobs", JOB_COLS, "technician", (q: any) => q.or(notPaid(c)).lte("date", wb.end)),
        // deno-lint-ignore no-explicit-any
        sel("jobs", JOB_COLS, "parts_paid_by", (q: any) => q.eq("parts_refund_status", "Pending Refund")),
        // deno-lint-ignore no-explicit-any
        sel("jobs", JOB_COLS, "parts_paid_by", (q: any) => q.eq("parts_refund_status", "Refunded").eq("parts_refund_week", wb.start)),
        // deno-lint-ignore no-explicit-any
        sel("equipment_spend", EQUIP_COLS, "paid_by", (q: any) => q.eq("reimbursed", "Pending")),
        // deno-lint-ignore no-explicit-any
        sel("equipment_spend", EQUIP_COLS, "paid_by", (q: any) => q.eq("reimbursed", "Reimbursed").eq("reimbursed_week", wb.start)),
        // deno-lint-ignore no-explicit-any
        sel("payroll_bonuses", BN, "person", (q: any) => q.eq("week_start", wb.start)),
        // deno-lint-ignore no-explicit-any
        sel("sales_daily_log", SL, "person", (q: any) => q.gte("date", wb.start).lte("date", wb.end)),
      ]);
      // A pending refund lands in the first week not marked paid from the week it was entered: the marks from there on.
      const tzc = { tz: c.biz.tz };
      // deno-lint-ignore no-explicit-any
      const entered = [...partsPending.map((j: any) => localDay(tzc, j.parts_pending_at) || j.date), ...eqPending.map((e: any) => localDay(tzc, e.created_at) || e.date)].filter(isDay).sort();
      // deno-lint-ignore no-explicit-any
      const weeks = await sel("payroll_weeks", PW, "person", (q: any) => q.gte("week_start", shiftDay(entered[0] && entered[0] < wb.start ? entered[0] : wb.start, -13)).lte("week_start", wb.end));
      // deno-lint-ignore no-explicit-any
      const byId = (lists: any[][]) => { const m = new Map<string, any>(); lists.flat().forEach((r) => m.set(String(r.id), r)); return [...m.values()]; };
      const jobs = byId([paidOn, paidSameDay, unpaid, partsPending, partsDone]), equip = byId([eqPending, eqDone]);
      const d = await calcCtx(c, {
        // deno-lint-ignore no-explicit-any
        jobs: jobs.filter((j: any) => jobVisible(s, j)).map(jobFromRow), equipmentSpend: equip.filter((e: any) => equipVisible(s, e)).map(equipFromRow),
        payrollWeeks: weeks.map(payrollFromRow), payrollBonuses: bonuses.map(bonusFromRow), salesLogs: logs.map(salesLogFromRow),
      });
      const wk = payrollWeekOf(d, args.week || d.today);
      const commissionPeople = payrollCommissionPeople(d), hourlyPeople = payrollHourlyPeople(d);
      const people = s.isOM ? [...commissionPeople, ...hourlyPeople.filter((n) => !commissionPeople.includes(n))] : [person];
      const rows = people.map((name) => {
        // deno-lint-ignore no-explicit-any
        const emp = d.employees.find((e: any) => e.name === name);
        // deno-lint-ignore no-explicit-any
        const hasJobs = d.jobs.some((j: any) => j.technician === name), hasLogs = d.salesLogs.some((l: any) => l.person === name);
        const st = payrollStatus(d, wk.key, name);
        return {
          person: name, week: { start: wk.start, end: wk.end },
          ...(commissionPeople.includes(name) || hasJobs ? { commission: computePayrollCommission(d, name, wk.key) } : {}),
          ...((emp && emp.employmentType === "Hourly") || hasLogs ? { hourly: computePayrollHourly(d, name, wk.key) } : {}),
          status: { cashCollected: !!st.cashCollected, salaryPaid: !!st.salaryPaid },
        };
      });
      return { payload: { week: { start: wk.start, end: wk.end }, rows, count: rows.length, truncated }, rows: rows.length };
    },
  },
  {
    name: "marketing_summary", title: "Marketing summary",
    description: "Ad spend by channel in a date range, the ad phone calls (owners and managers) and the leads that came in by source and service, with the cost per lead.",
    inputSchema: obj({ from: FROM, to: TO }),
    gate: (s) => !s.isTech && adSpendVisible(s),
    run: async (c, args) => {
      const r = rangeOf(args, c.biz.tz, c.nowMs), ads = await adSpendIn(c, r.from, r.to);
      // deno-lint-ignore no-explicit-any
      const payload: Record<string, any> = { from: r.from, to: r.to, adSpend: { total: ads.total, byChannel: ads.byChannel, leadsReported: ads.leadsReported }, truncated: ads.truncated };
      // The ad calls are owners' and managers' only (as the database lets the app read them). By campaign, not by the
      // app's per-account split (an account number is one business's).
      if (adCallsVisible(c.s)) {
        const { rows, truncated } = await pageAll((a, z) => c.sb.from("ad_calls").select("id, date, status, duration_seconds, campaign").gte("date", r.from).lte("date", r.to).order("id").range(a, z));
        // deno-lint-ignore no-explicit-any
        const missed = rows.filter((x: any) => x.status === "MISSED").length;
        // deno-lint-ignore no-explicit-any
        payload.adCalls = { total: rows.length, answered: rows.length - missed, missed, over30s: rows.filter((x: any) => (Number(x.duration_seconds) || 0) >= 30).length, byCampaign: sumBy(rows, (x: any) => x.campaign) };
        payload.truncated = payload.truncated || truncated;
      }
      if (c.s.contacts && (canViewSection(c.s.p, "crmOverview") || canViewSection(c.s.p, "dashboard"))) {
        const { rows, truncated } = await pageAll((a, z) => c.sb.from("contacts").select("id, source, division, created_at").gte("created_at", r.fromIso).lt("created_at", r.toIso).order("id").range(a, z));
        // deno-lint-ignore no-explicit-any
        payload.leads = { count: rows.length, bySource: sumBy(rows, (x: any) => x.source), byDivision: sumBy(rows, (x: any) => x.division) };
        payload.costPerLead = rows.length && ads.total ? round2(ads.total / rows.length) : null;
        payload.truncated = payload.truncated || truncated;
      }
      return { payload, rows: 1 };
    },
  },
  {
    name: "list_tasks", title: "List tasks",
    description: "Tasks this person can see, earliest due first (no due date last). mine = only tasks assigned to me; status = only that status. count is how many matched among the tasks read (a lower bound when truncated).",
    inputSchema: obj({ mine: { type: "boolean", description: "Only tasks assigned to me." }, status: { type: "string", maxLength: 40, description: "Only this status (exact)." }, limit: LIMIT }),
    gate: (s) => s.tasks,
    run: async (c, args) => {
      // Read in the answer's own order (earliest due first, no due date last), the status filtered by the database,
      // page by page, and stopped as soon as one more task than asked is found: a business with thousands of tasks is
      // never read whole for a short list. Who sees which task stays the app's rule (taskVisible), applied here.
      // deno-lint-ignore no-explicit-any
      const found: any[] = [];
      let scanTruncated = false;
      for (let a = 0; ; a += PAGE) {
        if (a >= MAX_SCAN) { scanTruncated = true; break; }
        let b = c.sb.from("tasks").select(TASK_COLS);
        if (args.status !== undefined) b = b.eq("status", args.status);
        const { data, error } = await b.order("due", { ascending: true, nullsFirst: false }).order("id").range(a, a + PAGE - 1);
        if (error) throw new Error(error.message);
        // deno-lint-ignore no-explicit-any
        const rows: any[] = data || [];
        rows.forEach((t) => { if (taskVisible(c.s, t) && (!args.mine || taskAssignedTo(t, c.s.p))) found.push(t); });
        if (found.length > args.limit || rows.length < PAGE) break;
      }
      return listOf(found.map((t) => taskOut(c, t)), args.limit, scanTruncated);
    },
  },
  {
    name: "list_calls", title: "List phone calls",
    description: "Phone calls between two days, newest first, with the contact's name. missed_only = only missed calls. Also counts missed calls not called back yet.",
    inputSchema: obj({ from: FROM, to: TO, missed_only: { type: "boolean", description: "Only missed calls." }, limit: LIMIT }),
    gate: (s) => canViewSection(s.p, "crm"),
    run: async (c, args) => {
      const r = rangeOf(args, c.biz.tz, c.nowMs);
      const { rows, truncated } = await pageAll((a, z) => {
        let b = c.sb.from("calls").select(CALL_COLS).gte("started_at", r.fromIso).lt("started_at", r.toIso);
        if (args.missed_only) b = b.eq("missed", true);
        return b.order("started_at", { ascending: false }).order("id").range(a, z);
      });
      const shown = rows.slice(0, args.limit);
      // deno-lint-ignore no-explicit-any
      const ids = Array.from(new Set(shown.map((k: any) => k.contact_id).filter(Boolean)));
      const names: Record<string, string> = {};
      // The names in chunks of NAME_CHUNK ids, so the request address stays short.
      for (let k = 0; c.s.contacts && k < ids.length; k += NAME_CHUNK) {
        const { data, error } = await c.sb.from("contacts").select("id, full_name").in("id", ids.slice(k, k + NAME_CHUNK));
        if (error) throw new Error(error.message);
        // deno-lint-ignore no-explicit-any
        (data || []).forEach((x: any) => { names[x.id] = x.full_name || ""; });
      }
      // deno-lint-ignore no-explicit-any
      const all = rows.map((k: any, i: number) => (i < args.limit ? callOut(k, names) : k));
      return listOf(all, args.limit, truncated, {
        // deno-lint-ignore no-explicit-any
        from: r.from, to: r.to, total: rows.length, missed: rows.filter((k: any) => !!k.missed).length, missedOpen: rows.filter((k: any) => !!k.missed && !k.callback_done_at).length,
      });
    },
  },
];
// deno-lint-ignore no-explicit-any
function callOut(k: any, names: Record<string, string> | null) {
  return {
    id: k.id, direction: k.direction || "", from: k.from_number || "", to: k.to_number || "", status: k.status || "", missed: !!k.missed, answeredBy: k.answered_by || null,
    durationSeconds: Number(k.duration) || 0, voicemail: !!k.voicemail, startedAt: k.started_at || null, calledBackAt: k.callback_done_at || null, contactId: k.contact_id || null,
    ...(names ? { contactName: (k.contact_id && names[k.contact_id]) || null } : {}),
  };
}

// ── arguments ──
// A tool's arguments checked against its schema (the small part of JSON Schema the tools use), defaults filled in.
// deno-lint-ignore no-explicit-any
export function validateArgs(schema: any, args: any): { ok: boolean; value?: any; error?: string } {
  const bad = (e: string) => ({ ok: false, error: "Invalid arguments: " + e });
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return bad("expected an object.");
  const props = (schema && schema.properties) || {};
  for (const k of Object.keys(args)) if (!Object.prototype.hasOwnProperty.call(props, k)) return bad(`${clip(k, 40)} is not a field of this tool.`);
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const [k, p] of Object.entries(props) as [string, any][]) {
    const v = args[k];
    if (v === undefined || v === null) { if (p.default !== undefined) out[k] = p.default; continue; }
    if (p.type === "string") {
      if (typeof v !== "string") return bad(`${k} must be text.`);
      if (p.maxLength !== undefined && v.length > p.maxLength) return bad(`${k} is too long (at most ${p.maxLength} characters).`);
      if (p.format === "date" && !isDay(v)) return bad(`${k} must be a date (YYYY-MM-DD).`);
      if (p.format === "uuid" && !isUuid(v)) return bad(`${k} must be an id.`);
    } else if (p.type === "integer") {
      if (!Number.isInteger(v)) return bad(`${k} must be a whole number.`);
      if (p.minimum !== undefined && v < p.minimum) return bad(`${k} must be at least ${p.minimum}.`);
      if (p.maximum !== undefined && v > p.maximum) return bad(`${k} must be at most ${p.maximum}.`);
    } else if (p.type === "boolean") {
      if (typeof v !== "boolean") return bad(`${k} must be true or false.`);
    }
    out[k] = v;
  }
  for (const k of (schema && schema.required) || []) if (out[k] === undefined) return bad(`${k} is required.`);
  return { ok: true, value: out };
}

// ── MCP protocol (JSON-RPC 2.0 over plain JSON answers; stateless, no session id) ──
// deno-lint-ignore no-explicit-any
const rpcError = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
// deno-lint-ignore no-explicit-any
export type RpcOut = { status: number; body: any; headers?: Record<string, string> };
// deno-lint-ignore no-explicit-any
export async function handleRpc(msg: any, c: Ctx): Promise<RpcOut> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { status: 400, body: rpcError(null, -32600, "Invalid Request (batches are not supported)") };
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id"), id = hasId ? msg.id : null;
  if (hasId && id !== null && typeof id !== "string" && typeof id !== "number") return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
  // A JSON-RPC answer from the client (we never ask it anything): accepted, nothing to say.
  if (msg.jsonrpc === "2.0" && msg.method === undefined && ("result" in msg || "error" in msg)) return { status: 202, body: null };
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { status: 400, body: rpcError(id, -32600, "Invalid Request") };
  // Notifications (no id): notifications/initialized, notifications/cancelled, anything else → accepted, no answer.
  if (!hasId) return { status: 202, body: null };
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};
  const p = c.s.p;
  // initialize and tools/list count toward the rate limit too (a client looping on them is still load), logged as
  // their own rows. ping does not.
  if (msg.method === "initialize" || msg.method === "tools/list") {
    const base = { token_id: c.token.id, user_id: c.token.user_id, tool: msg.method, at: new Date(c.nowMs).toISOString(), args_summary: "", rows_returned: 0 };
    const logId = await openLog(c.sb, { ...base, status: "ok" });
    const limit = await overLimit(c, logId);
    if (limit !== null) {
      await logCall(c.sb, logId, { ...base, status: "rate_limited" });
      return { status: 429, headers: { "Retry-After": "60" }, body: rpcError(id, -32029, `Too many calls: at most ${limit} a minute. Try again in a minute.`) };
    }
  }
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO, title: (c.biz.companyName ? c.biz.companyName + " " : "") + "(OPS)" },
        instructions: `Read-only access to ${c.biz.companyName || "this business"} as ${p.fullName || "this person"} (${p.role}). Only what this person can see in the OPS app. Dates are in ${c.biz.tz}.`,
      });
    case "ping":
      return ok({});
    case "tools/list": {
      // The tax by the business's own name (Settings → Region: GST, VAT, Sales tax…); the fields keep their names.
      const tax = taxNameOf(c.biz.catalog);
      return ok({ tools: TOOLS.filter((t) => t.gate(c.s)).map((t) => ({ name: t.name, title: t.title, description: t.description.replace(/\bGST\b/g, tax), inputSchema: t.inputSchema, annotations: ANNOTATIONS })) });
    }
    case "tools/call": {
      const r = await callTool(c, params);
      return { status: r.status || 200, headers: r.headers, body: r.error ? { jsonrpc: "2.0", id, error: r.error } : { jsonrpc: "2.0", id, result: r.result } };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, "Method not found") };
  }
}

// A call's access-log row, written before anything else (status 'error' until it is finished), so the rate limit can
// count it. Its id, or null when the write failed. Never throws: a failed log write never fails the answer.
// deno-lint-ignore no-explicit-any
async function openLog(sb: any, row: Record<string, unknown>): Promise<number | null> {
  try {
    const { data, error } = await sb.from("mcp_access_log").insert({ business_id: BUSINESS_ID, ...row }).select("id").single();
    if (error || !data) { console.error("mcp log failed:", clip(error ? error.message : "no row", 300)); return null; }
    return data.id;
  } catch (e) { console.error("mcp log failed:", clip((e as Error).message, 300)); return null; }
}
// The call's outcome on its row (or a new row when openLog failed). Never throws.
// deno-lint-ignore no-explicit-any
async function logCall(sb: any, logId: number | null, row: Record<string, unknown>) {
  try {
    const { error } = logId === null ? await sb.from("mcp_access_log").insert({ business_id: BUSINESS_ID, ...row }) : await sb.from("mcp_access_log").update(row).eq("id", logId);
    if (error) console.error("mcp log failed:", clip(error.message, 300));
  } catch (e) { console.error("mcp log failed:", clip((e as Error).message, 300)); }
}
// The rate limit, per BUSINESS (every key of every person together; one business's calls share one budget): the rows
// of the last minute up to and including this request's own row (refused ones count too). Each request writes its row
// first and counts only the rows up to it, so requests sent at the same moment can't all slip under the limit (each
// sees the ones written before it). The limit when this request is over it, else null.
async function overLimit(c: Ctx, logId: number | null): Promise<number | null> {
  let q = c.sb.from("mcp_access_log").select("id", { count: "exact", head: true }).eq("business_id", BUSINESS_ID).gte("at", new Date(c.nowMs - 60_000).toISOString());
  if (logId !== null) q = q.lte("id", logId);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  const limit = c.biz.mcp.rateLimitPerMin;
  return (count || 0) > (logId !== null ? limit : limit - 1) ? limit : null;
}
// The payload made small enough to send: rows halved until it fits (and flagged truncated).
// deno-lint-ignore no-explicit-any
export function fitPayload(payload: any, max = MAX_RESULT_CHARS) {
  let text = JSON.stringify(payload);
  while (text.length > max && payload && Array.isArray(payload.rows) && payload.rows.length) {
    payload = { ...payload, rows: payload.rows.slice(0, Math.floor(payload.rows.length / 2)), truncated: true };
    text = JSON.stringify(payload);
  }
  return { payload, text };
}
// deno-lint-ignore no-explicit-any
export async function callTool(c: Ctx, params: any): Promise<{ status?: number; headers?: Record<string, string>; result?: any; error?: any }> {
  const name = String((params && params.name) || "");
  const tool = TOOLS.find((t) => t.name === name);
  const base = { token_id: c.token.id, user_id: c.token.user_id, tool: clip(name, 64) || "(none)", at: new Date(c.nowMs).toISOString() };
  // deno-lint-ignore no-explicit-any
  const rawArgs = params ? (params as any).arguments : undefined;
  const argsSummary = tool ? summarizeArgs(rawArgs, tool.inputSchema) : "";
  const allowed = !!tool && tool.gate(c.s);
  // (a) the rate limit first (overLimit: the business's requests in the last minute, this one's row written first).
  const logId = await openLog(c.sb, { ...base, args_summary: allowed ? argsSummary : "", rows_returned: 0, status: "error" });
  const limit = await overLimit(c, logId);
  if (limit !== null) {
    await logCall(c.sb, logId, { ...base, args_summary: argsSummary, rows_returned: 0, status: "rate_limited" });
    return { status: 429, headers: { "Retry-After": "60" }, error: { code: -32029, message: `Too many calls: at most ${limit} a minute. Try again in a minute.` } };
  }
  // (b) a tool this person can't use looks exactly like one that doesn't exist.
  if (!tool || !allowed) {
    await logCall(c.sb, logId, { ...base, args_summary: "", rows_returned: 0, status: "denied" });
    return { error: { code: -32602, message: `Unknown tool: ${clip(name, 64)}` } };
  }
  const failed = async (text: string) => {
    await logCall(c.sb, logId, { ...base, args_summary: argsSummary, rows_returned: 0, status: "error" });
    return { result: { content: [{ type: "text", text }], isError: true } };
  };
  // (c) the arguments.
  const v = validateArgs(tool.inputSchema, rawArgs);
  if (!v.ok) return await failed(v.error!);
  // (d) the tool.
  let out;
  try { out = await tool.run(c, v.value); } catch (e) {
    if (e instanceof ToolError) return await failed(e.message);
    console.error("mcp tool failed:", name, clip((e as Error).message, 300));
    return await failed("Something went wrong reading the data.");
  }
  // (e) the answer, as text and as structured content.
  const { payload, text } = fitPayload(out.payload);
  const rows = Array.isArray(payload.rows) ? payload.rows.length : out.rows;
  await logCall(c.sb, logId, { ...base, args_summary: argsSummary, rows_returned: rows, status: "ok" });
  return { result: { content: [{ type: "text", text }], structuredContent: payload } };
}

// ── keys ──
// Where a request goes: /mcp (optionally after /functions/v1), /mcp/t/<key>, /mcp/manage, /mcp/cron; anything else null.
export function routeOf(pathname: string): { kind: "mcp" | "manage" | "cron"; pathToken?: string } | null {
  const m = /^\/mcp(?:\/(.*))?$/.exec(pathname.replace(/^\/functions\/v1(?=\/)/, ""));
  if (!m) return null;
  const rest = (m[1] || "").replace(/\/+$/, "");
  if (rest === "") return { kind: "mcp" };
  if (rest.startsWith("t/")) { const tok = rest.slice(2); return { kind: "mcp", pathToken: TOKEN_RE.test(tok) ? tok : "" }; }
  if (rest === "manage") return { kind: "manage" };
  if (rest === "cron") return { kind: "cron" };
  return null;
}
// The key a request carries: the path key, else an 'ops_mcp_' bearer key ('' = none; a Supabase key is not one).
export function tokenFrom(req: Request, route: { pathToken?: string }): string {
  if (route.pathToken !== undefined) return route.pathToken;
  const h = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return TOKEN_RE.test(h) ? h : "";
}
// Whether someone's sign-in is switched off (People → access), remembered a minute per user.
const banCache = new Map<string, { at: number; banned: boolean }>();
// deno-lint-ignore no-explicit-any
async function isBanned(sb: any, userId: string, nowMs: number): Promise<boolean> {
  const hit = banCache.get(userId);
  if (hit && nowMs - hit.at < BAN_CACHE_MS) return hit.banned;
  const { data, error } = await sb.auth.admin.getUserById(userId);
  // An account that is gone is not let in; Auth failing to answer is an outage (a 500), not a bad key.
  if (error && Number(error.status) !== 404) throw new Error("auth: " + clip(error.message, 200));
  if (error || !data || !data.user) return true;
  const banned = !!(data.user.banned_until && Date.parse(data.user.banned_until) > nowMs);
  banCache.set(userId, { at: nowMs, banned });
  return banned;
}
// The key's row and its person, or null when the key is missing, wrong, revoked, of another business, or its person
// can't use MCP any more (no longer an owner or manager, profile gone, sign-in switched off). A database or Auth error
// throws instead (the request answers 500), so an outage never looks like a revoked key.
// deno-lint-ignore no-explicit-any
export async function authToken(sb: any, raw: string, nowMs: number): Promise<{ token: any; profile: Profile } | null> {
  if (!TOKEN_RE.test(raw)) return null;
  const hash = await sha256Hex(raw);
  const { data: row, error: te } = await sb.from("mcp_tokens").select("id, user_id, business_id, token_hash, revoked_at, last_used_at").eq("token_hash", hash).is("revoked_at", null).eq("business_id", BUSINESS_ID).maybeSingle();
  if (te) throw new Error("keys: " + clip(te.message, 200));
  if (!row || !sameSecret(row.token_hash, hash)) return null;
  const { data: prof, error: pe } = await sb.from("profiles").select("id, full_name, role, permissions, technician_name").eq("id", row.user_id).maybeSingle();
  if (pe) throw new Error("profiles: " + clip(pe.message, 200));
  if (!prof) return null;
  const profile = appProfile(prof);
  if (!canUseMcp(profile)) return null;
  if (await isBanned(sb, row.user_id, nowMs)) return null;
  if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) >= LAST_USED_EVERY_MS) {
    // Fire and forget (at most once a minute); a failure here never blocks the call.
    try { sb.from("mcp_tokens").update({ last_used_at: new Date(nowMs).toISOString() }).eq("id", row.id).then(() => {}, () => {}); } catch { /* ignored */ }
  }
  return { token: row, profile };
}

// ── management (POST /mcp/manage with the signed-in person's token) ──
// The signed-in person (profile), or null. (team's caller, with the fields the scope needs.)
// deno-lint-ignore no-explicit-any
async function caller(sb: any, req: Request): Promise<Profile | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_") || jwt.startsWith("ops_mcp_")) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role, permissions, technician_name").eq("id", u.user.id).maybeSingle();
  return p ? appProfile(p) : null;
}
// deno-lint-ignore no-explicit-any
type Step = { who: "any" | "mcp" | "owner"; run: (sb: any, body: any, me: Profile, nowMs: number) => Promise<{ status: number; body: any }> };
// The management steps. Later groups add theirs here (save_server, test_server, … and the imports).
export const MANAGE_STEPS: Record<string, Step> = {
  create_token: {
    who: "mcp",
    run: async (sb, body, me) => {
      const name = clip(body?.name, 60);
      if (!name) return { status: 400, body: { ok: false, reason: "Give the key a name." } };
      const { count, error: ce } = await sb.from("mcp_tokens").select("id", { count: "exact", head: true }).eq("user_id", me.id).eq("business_id", BUSINESS_ID).is("revoked_at", null);
      if (ce) throw new Error(ce.message);
      if ((count || 0) >= MAX_TOKENS_PER_USER) return { status: 409, body: { ok: false, reason: `You already have ${MAX_TOKENS_PER_USER} keys. Revoke one you no longer use first.` } };
      const token = newToken();
      const { data, error } = await sb.from("mcp_tokens").insert({ business_id: BUSINESS_ID, user_id: me.id, name, token_prefix: tokenPrefix(token), token_hash: await sha256Hex(token), scopes: ["read"] }).select("id").single();
      if (error || !data) throw new Error((error && error.message) || "insert failed");
      // The key itself is returned this once and is never stored or logged.
      return { status: 200, body: { ok: true, id: data.id, name, prefix: tokenPrefix(token), token, url: SELF_URL, pathUrl: SELF_URL + "/t/" + token } };
    },
  },
  revoke_token: {
    who: "any",
    run: async (sb, body, me, nowMs) => {
      const id = body?.id;
      if (!isUuid(id)) return { status: 400, body: { ok: false, reason: "That isn't a key id." } };
      const { data: row } = await sb.from("mcp_tokens").select("id, user_id, revoked_at").eq("id", id).eq("business_id", BUSINESS_ID).maybeSingle();
      if (!row) return { status: 404, body: { ok: false, reason: "No key with that id." } };
      if (row.user_id !== me.id && me.role !== "owner") return { status: 403, body: { ok: false, reason: "Only an owner can revoke someone else's key." } };
      if (row.revoked_at) return { status: 200, body: { ok: true, revokedAt: row.revoked_at } };
      const revokedAt = new Date(nowMs).toISOString();
      const { error } = await sb.from("mcp_tokens").update({ revoked_at: revokedAt, revoked_by: me.id }).eq("id", id).eq("business_id", BUSINESS_ID);
      if (error) throw new Error(error.message);
      return { status: 200, body: { ok: true, revokedAt } };
    },
  },
  set_mcp_settings: {
    who: "owner",
    run: async (sb, body) => {
      const b = body || {};
      const { data: st, error: se } = await sb.from("settings").select("catalog").eq("id", 1).maybeSingle();
      if (se) throw new Error(se.message);
      const merged = mcpSettings(st && st.catalog);
      if (b.rateLimitPerMin !== undefined) {
        if (!Number.isInteger(b.rateLimitPerMin) || b.rateLimitPerMin < 1 || b.rateLimitPerMin > 600) return { status: 400, body: { ok: false, reason: "The limit must be a whole number of calls a minute, from 1 to 600." } };
        merged.rateLimitPerMin = b.rateLimitPerMin;
      }
      if (b.logKeepDays !== undefined) {
        if (!Number.isInteger(b.logKeepDays) || b.logKeepDays < 7 || b.logKeepDays > 3650) return { status: 400, body: { ok: false, reason: "Keep the log for a whole number of days, from 7 to 3650." } };
        merged.logKeepDays = b.logKeepDays;
      }
      if (b.importSource !== undefined) {
        const s = typeof b.importSource === "string" ? b.importSource.trim() : "";
        if (!s || s.length > 60) return { status: 400, body: { ok: false, reason: "The source for imported leads needs 1 to 60 characters." } };
        merged.importSource = s;
      }
      // One atomic write of catalog.mcp only (mcp_set_catalog), so the rest of the catalog is never touched.
      const { error } = await sb.rpc("mcp_set_catalog", { p_mcp: merged });
      if (error) throw new Error(error.message);
      return { status: 200, body: { ok: true, mcp: merged } };
    },
  },
};
// deno-lint-ignore no-explicit-any
export async function handleManage(sb: any, body: any, me: Profile | null, nowMs: number): Promise<{ status: number; body: any }> {
  if (CLIENT_ACTIONS.includes(String(body?.step || ""))) return await clientAction(sb, body, me);
  if (IMPORT_ACTIONS.includes(String(body?.step || ""))) return await importAction(sb, body, me, nowMs);
  if (!me) return { status: 401, body: { ok: false, reason: "Sign in again." } };
  const step = MANAGE_STEPS[String(body?.step || "")];
  if (!step || !Object.prototype.hasOwnProperty.call(MANAGE_STEPS, String(body?.step))) return { status: 400, body: { ok: false, reason: "unknown step" } };
  if (step.who === "mcp" && !canUseMcp(me)) return { status: 403, body: { ok: false, reason: "Only owners and managers can make keys." } };
  if (step.who === "owner" && me.role !== "owner") return { status: 403, body: { ok: false, reason: "Only an owner can change this." } };
  return await step.run(sb, body, me, nowMs);
}

// ── client direction: OPS calls a business's own MCP server (owners only) ──
// Limits (an object, so tests can shrink them): a request, a whole step, the size of an answer, what is kept of it.
export const CLIENT = { timeoutMs: 15000, budgetMs: 45000, maxBytes: 2_000_000, previewChars: 20000, maxArgsBytes: 20000, maxTools: 200, maxToolPages: 5, toolDescChars: 500, toolSchemaBytes: 8000, maxSecret: 4096 };
export const CLIENT_PROTOCOL = "2025-06-18";
// No business name in it: nothing about the business is sent (and it stays the same for every business).
const CLIENT_INFO = { name: "ops-mcp-client", version: "1.0.0" };
export const TOOL_NAME = /^[A-Za-z0-9_.\/-]{1,128}$/;
const PRIVATE_REASON = "That address is private or local, so OPS won't call it.";
const FORMAT_REASON = "The server did not answer in MCP format.";

// SSRF guard. IPv4 ranges that are never a business's public server: this network, private, CGNAT (incl. Alibaba's
// metadata 100.100.100.200), loopback, link-local (incl. the 169.254.169.254 metadata address), IETF, documentation,
// 6to4 relay, benchmarking, multicast, reserved and broadcast, and Azure's 168.63.129.16.
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["168.63.129.16", 32],
];
function v4Parts(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}
const v4Num = (p: number[]) => ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
// An IPv6 address as its 8 groups ('::' and a dotted IPv4 tail allowed), or null when it can't be read (a zone id
// '%eth0' included, so it is blocked).
export function expandV6(s: string): number[] | null {
  if (!s || s.includes("%")) return null;
  let head = s;
  const tail: number[] = [];
  const last = s.lastIndexOf(":");
  if (last >= 0 && s.slice(last + 1).includes(".")) {
    const q = v4Parts(s.slice(last + 1));
    if (!q) return null;
    tail.push((q[0] << 8) | q[1], (q[2] << 8) | q[3]);
    head = s.slice(0, last + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const all = halves.map(groups);
  if (all.some((g) => g.some((x) => !/^[0-9a-f]{1,4}$/i.test(x)))) return null;
  const nums = all.map((g) => g.map((x) => parseInt(x, 16)));
  if (nums.length === 1) return nums[0].length + tail.length === 8 ? [...nums[0], ...tail] : null;
  const fill = 8 - tail.length - nums[0].length - nums[1].length;
  if (fill < 1) return null;
  return [...nums[0], ...new Array(fill).fill(0), ...nums[1], ...tail];
}
export function isBlockedIp(ip: string): boolean {
  let s = String(ip || "").trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) {
    const p = v4Parts(s);
    if (!p) return true;
    const n = v4Num(p);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((v4Num(v4Parts(base) as number[]) & mask) >>> 0);
    });
  }
  const g = expandV6(s);
  if (!g) return true;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return true;                                          // ::, ::1 and ::/96 (IPv4-compatible)
  if (zero(0, 5) && g[5] === 0xffff) return true;                       // ::ffff:0:0/96 (IPv4-mapped): always
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return true;         // ::ffff:0:0:0/96 (IPv4-translated)
  if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return true;   // NAT64 64:ff9b::/96, 64:ff9b:1::/48
  if (g[0] === 0x100 && zero(1, 4)) return true;                        // 100::/64 (discard)
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;   // Teredo 2001::/32, documentation 2001:db8::/32
  if (g[0] === 0x2002) return true;                                     // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                          // unique local fc00::/7 (incl. AWS fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;   // link-local, old site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                          // multicast
  return false;
}
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
export function isBlockedHostname(host: string): boolean {
  let h = String(host || "").trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if ((h.startsWith("[") && h.endsWith("]")) || h.includes(":") || v4Parts(h)) return isBlockedIp(h);
  if (!h || !h.includes(".") || h === "localhost") return true;
  return BLOCKED_SUFFIXES.some((x) => h.endsWith(x) || h === x.slice(1));
}
// An owner-typed address, checked and tidied (the #fragment dropped). The URL parser turns 2130706433, 0x7f.1 and 127.1
// into 127.0.0.1 first, so the dotted check catches those spellings too.
export function checkServerUrl(raw: unknown): { ok: true; url: string; host: string } | { ok: false; reason: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: false, reason: "Enter the server's https:// address." };
  if (s.length > 500) return { ok: false, reason: "That address is too long." };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: "That isn't a web address." }; }
  if (u.protocol !== "https:") return { ok: false, reason: "Use an https:// address." };
  if (u.username || u.password) return { ok: false, reason: "Put the key in the secret field, not in the address." };
  if (u.port !== "" && u.port !== "443" && Number(u.port) < 1024) return { ok: false, reason: "Use port 443 or a port above 1023." };
  if (isBlockedHostname(u.hostname)) return { ok: false, reason: PRIVATE_REASON };
  u.hash = "";
  if (u.href.length > 500) return { ok: false, reason: "That address is too long." };
  return { ok: true, url: u.href, host: u.hostname };
}
// The host and port of a saved address ('' when it can't be read).
export function hostOf(u: unknown): string { try { return new URL(String(u)).host.toLowerCase(); } catch { return ""; } }
// The host's DNS answers, checked at use time: every answer must be public, and the first one is the address the
// request then connects to (pinned, so a rebinding name can't answer differently the second time). An IP literal was
// checked by checkServerUrl and needs no lookup (ip null). Fails closed: a runtime that can't look names up refuses
// every host name.
export async function resolveChecked(host: string): Promise<{ ok: true; ip: string | null } | { ok: false; reason: string }> {
  const h = String(host || "");
  if (h.startsWith("[") || h.includes(":") || v4Parts(h)) return { ok: true, ip: null };   // an IP literal, already checked
  let ips: string[] | null;
  try { ips = await io.resolveDns(h); } catch { return { ok: false, reason: "OPS couldn't look up that address." }; }
  if (ips === null) return { ok: false, reason: "OPS can't check that address here, so it won't call it." };
  if (!ips.length) return { ok: false, reason: "That address doesn't exist." };
  if (ips.some((ip) => isBlockedIp(ip))) return { ok: false, reason: PRIVATE_REASON };
  return { ok: true, ip: ips[0] };
}
// The same check as a reason, or null when fine (save_server).
export async function checkResolved(host: string): Promise<string | null> {
  const r = await resolveChecked(host);
  return r.ok ? null : r.reason;
}

// ── client: a request pinned to the checked address ──
// One HTTP/1.1 exchange over TLS to `ip`, with the certificate and SNI checked for the URL's own host name (Deno.connect
// + Deno.startTls, as Postgres drivers use them on the edge runtime). No redirects, no keep-alive (Connection: close).
// Without those APIs it refuses (fails closed) rather than letting fetch look the name up again.
const MAX_HEAD_BYTES = 64 * 1024;
// A step that can't be cancelled (Deno.connect, Deno.startTls) raced against the signal: an abort answers at once
// ("aborted"), and a connection that opens after it is handed to onLate (closed) instead of being left open.
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, onLate: (v: T) => void): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    let lost = false;
    const stop = () => { lost = true; reject(new Error("aborted")); };
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", stop); if (!lost) resolve(v); else { try { onLate(v); } catch { /* already closed */ } } },
      (e) => { signal.removeEventListener("abort", stop); if (!lost) reject(e); },
    );
  });
}
// deno-lint-ignore no-explicit-any
const closeQuietly = (c: any) => { try { c && c.close(); } catch { /* already closed */ } };
export async function pinnedFetch(u: string, init: RequestInit, ip: string): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  if (!D || typeof D.connect !== "function" || typeof D.startTls !== "function") throw new Error("pinned connections are not available");
  const url = new URL(u), signal = init.signal || undefined;
  if (signal && signal.aborted) throw new Error("aborted");
  const headers = new Headers(init.headers || {});
  const body = typeof init.body === "string" ? enc.encode(init.body) : new Uint8Array(0);
  let head = `${init.method || "GET"} ${url.pathname || "/"}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n`;
  headers.forEach((v, k) => { if (!["host", "connection", "content-length"].includes(k)) head += `${k}: ${v}\r\n`; });
  // deno-lint-ignore no-explicit-any
  let conn: any = null;
  const close = () => { try { conn && conn.close(); } catch { /* already closed */ } conn = null; };
  const onAbort = () => close();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Neither step takes a signal: each is raced against it, so the client's time limit holds even while a server
    // never answers the connect or the TLS handshake.
    const tcp = await raceAbort(D.connect({ hostname: ip.replace(/^\[|\]$/g, ""), port: Number(url.port) || 443 }), signal, closeQuietly);
    conn = tcp;
    if (signal && signal.aborted) throw new Error("aborted");
    conn = await raceAbort(D.startTls(tcp, { hostname: url.hostname }), signal, closeQuietly);
    const out = new Uint8Array([...enc.encode(head + "\r\n"), ...body]);
    for (let n = 0; n < out.length;) n += await conn.write(out.subarray(n));
    return await readHttpResponse(conn.readable, () => { if (signal) signal.removeEventListener("abort", onAbort); close(); });
  } catch (e) {
    if (signal) signal.removeEventListener("abort", onAbort);
    close();
    throw e;
  }
}
// An HTTP/1.1 answer read from a byte stream: the status line and headers (1xx answers skipped), then the body as a
// stream (chunked, Content-Length, or until the connection closes), so an SSE answer can be read while it stays open.
// done() runs once the body is finished or cancelled.
export async function readHttpResponse(src: ReadableStream<Uint8Array>, done: () => void = () => {}): Promise<Response> {
  const reader = src.getReader();
  let buf = new Uint8Array(0);
  const more = async () => {
    const { done: d, value } = await reader.read();
    if (d) return false;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf); next.set(value, buf.length); buf = next;
    return true;
  };
  const take = (n: number) => { const out = buf.slice(0, n); buf = buf.slice(n); return out; };
  const findCrlf = (from = 0) => { for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i; return -1; };
  const line = async () => {
    let i: number;
    while ((i = findCrlf()) < 0) { if (buf.length > MAX_HEAD_BYTES || !(await more())) throw new Error("bad HTTP answer"); }
    const s = new TextDecoder().decode(take(i)); take(2); return s;
  };
  let status = 0;
  const headers = new Headers();
  try {
    for (;;) {
      const m = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(await line());
      if (!m) throw new Error("bad HTTP answer");
      status = Number(m[1]);
      const hs: [string, string][] = [];
      for (let size = 0; ;) {
        const l = await line();
        if (l === "") break;
        size += l.length;
        if (size > MAX_HEAD_BYTES) throw new Error("bad HTTP answer");
        const c = l.indexOf(":");
        if (c > 0) hs.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
      }
      if (status >= 100 && status < 200) continue;   // 100 Continue and the like: the real answer follows
      for (const [k, v] of hs) { try { headers.append(k, v); } catch { /* a header the platform won't take: skipped */ } }
      break;
    }
    if (status < 200 || status > 599) throw new Error("bad HTTP answer");
  } catch (e) { reader.cancel().catch(() => {}); done(); throw e; }
  const chunked = (headers.get("transfer-encoding") || "").toLowerCase().includes("chunked");
  const length = headers.get("content-length");
  let left = !chunked && length !== null && /^\d+$/.test(length) ? Number(length) : -1;   // -1 = until the connection closes
  let chunkLeft = 0, finished = false;
  const finish = (c: ReadableStreamDefaultController<Uint8Array>) => { if (!finished) { finished = true; c.close(); reader.cancel().catch(() => {}); done(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        if (chunked) {
          if (chunkLeft === 0) {
            const size = parseInt((await line()).split(";")[0].trim(), 16);
            if (!Number.isFinite(size) || size < 0) throw new Error("bad chunk");
            if (size === 0) { while ((await line()) !== "") { /* trailers */ } return finish(c); }
            chunkLeft = size;
          }
          if (!buf.length && !(await more())) throw new Error("cut short");
          const part = take(Math.min(chunkLeft, buf.length));
          chunkLeft -= part.length;
          if (chunkLeft === 0) await line();   // the CRLF after the chunk
          c.enqueue(part);
          return;
        }
        if (left === 0) return finish(c);
        if (!buf.length && !(await more())) { if (left > 0) throw new Error("cut short"); return finish(c); }
        const part = take(left > 0 ? Math.min(left, buf.length) : buf.length);
        if (left > 0) left -= part.length;
        c.enqueue(part);
        if (left === 0) finish(c);
      } catch (e) { if (!finished) { finished = true; c.error(e); reader.cancel().catch(() => {}); done(); } }
    },
    cancel() { if (!finished) { finished = true; reader.cancel().catch(() => {}); done(); } },
  });
  const nullBody = status === 204 || status === 205 || status === 304;
  if (nullBody) { body.cancel().catch(() => {}); }
  return new Response(nullBody ? null : body, { status, headers });
}

// ── client: the key (header name + write-only secret) and what is shown of a server ──
const RESERVED_HEADERS = ["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "te", "upgrade", "cookie", "user-agent", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
export function cleanAuthHeader(raw: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s) || RESERVED_HEADERS.includes(s.toLowerCase())) return { ok: false, reason: "That header name can't be used." };
  return { ok: true, value: s };
}
// A reason, or null when the secret can be saved. Printable ASCII only: a line break would let it add headers.
export function checkSecret(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.length) return "Enter the secret.";
  if (raw.length > CLIENT.maxSecret) return `The secret can be at most ${CLIENT.maxSecret} characters.`;
  if (!/^[\x20-\x7E]+$/.test(raw)) return "The secret can only contain plain characters (no line breaks).";
  return null;
}
// What goes in the header: an Authorization secret without a scheme word becomes 'Bearer <secret>'.
export function authHeaderValue(name: string, secret: string): string {
  return name.toLowerCase() === "authorization" && !/^[A-Za-z][A-Za-z0-9._~+-]*\s+\S/.test(secret) ? "Bearer " + secret : secret;
}
// Masks every copy of the secret (and its 'Bearer ' form) in text that came back from a server.
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = String(text ?? "");
  for (const sec of secrets) {
    if (!sec) continue;
    out = out.split("Bearer " + sec).join("•••").split(sec).join("•••");
  }
  return out;
}
// A server as the app may see it: whether a secret is saved, never the secret or its Vault id.
// deno-lint-ignore no-explicit-any
export function publicServer(row: any) {
  return {
    id: row.id, name: row.name, url: row.url, auth_header: row.auth_header ?? null, has_secret: !!row.secret_id, created_by: row.created_by ?? null,
    created_at: row.created_at ?? null, last_test_at: row.last_test_at ?? null, last_test_ok: row.last_test_ok ?? null, last_tools: row.last_tools ?? null,
  };
}

// ── client: reading MCP answers (pure) ──
// The JSON messages of a text/event-stream body (events end at a blank line; data lines are joined with '\n').
// deno-lint-ignore no-explicit-any
export function parseSse(text: string): any[] {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const ev of String(text || "").split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    if (!data.length) continue;
    try { out.push(JSON.parse(data.join("\n"))); } catch { /* not JSON: skipped */ }
  }
  return out;
}
// Only the complete events of a stream that is still being read.
const sseDone = (t: string) => { const m = /^[\s\S]*\r?\n\r?\n/.exec(t); return m ? m[0] : ""; };
// The answer to our request id. Server notifications and server→client requests (sampling, elicitation) are ignored.
// deno-lint-ignore no-explicit-any
export function pickResponse(msgs: any[], id: number): any | null {
  for (const m of (msgs || []).flat()) {
    if (m && typeof m === "object" && m.jsonrpc === "2.0" && m.id === id && ("result" in m || "error" in m)) return m;
  }
  return null;
}
// The tool list as it is kept on the row: capped, clipped, masked, and no huge schemas.
// deno-lint-ignore no-explicit-any
export function cleanTools(list: any[], secret: string | null) {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (out.length >= CLIENT.maxTools) break;
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name.trim()) continue;
    // deno-lint-ignore no-explicit-any
    const item: any = { name: clip(redact(t.name, [secret]), 128) };
    if (typeof t.title === "string" && t.title.trim()) item.title = clip(redact(t.title, [secret]), 200);
    item.description = clip(redact(typeof t.description === "string" ? t.description : "", [secret]), CLIENT.toolDescChars);
    let schema: unknown = { type: "object", note: "schema too large to store" };
    try {
      const js = JSON.stringify(t.inputSchema ?? { type: "object" });
      if (enc.encode(js).length <= CLIENT.toolSchemaBytes) schema = JSON.parse(redact(js, [secret]));
    } catch { /* unreadable: the note stays */ }
    item.inputSchema = schema;
    out.push(item);
  }
  return out;
}
// deno-lint-ignore no-explicit-any
function contentText(c: any): string {
  if (!c || typeof c !== "object") return JSON.stringify(c);
  if (c.type === "text") return String(c.text ?? "");
  if (c.type === "image" || c.type === "audio") return `[${c.type} ${c.mimeType || ""}]`.replace(" ]", "]");
  if (c.type === "resource") {
    const r = c.resource || {};
    return `[resource ${r.uri || ""}]` + (typeof r.text === "string" && r.text ? "\n" + r.text : "");
  }
  if (c.type === "resource_link") return `[link ${c.uri || ""}]`;
  return JSON.stringify(c);
}
// What the owner sees of a tool's answer: structured content as JSON, else the content items; masked and clipped.
// deno-lint-ignore no-explicit-any
export function previewResult(result: any, secret: string | null): { isError: boolean; preview: string; truncated: boolean } {
  const r = result && typeof result === "object" ? result : {};
  const text = redact(r.structuredContent != null ? JSON.stringify(r.structuredContent, null, 2) : (Array.isArray(r.content) ? r.content : []).map(contentText).join("\n\n"), [secret]);
  const truncated = text.length > CLIENT.previewChars;
  return { isError: r.isError === true, preview: truncated ? text.slice(0, CLIENT.previewChars) : text, truncated };
}
// The data in a tool's answer (for the imports): structured content, else the first text item as JSON, else that text.
// deno-lint-ignore no-explicit-any
export function resultData(result: any): unknown {
  if (!result || typeof result !== "object") return null;
  if (result.structuredContent != null) return result.structuredContent;
  // deno-lint-ignore no-explicit-any
  const t = (Array.isArray(result.content) ? result.content : []).find((c: any) => c && c.type === "text" && typeof c.text === "string");
  if (!t) return null;
  try { return JSON.parse(t.text); } catch { return t.text; }
}
// The owner's tool input: an object (or its JSON), at most CLIENT.maxArgsBytes.
export function cleanArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  let v = raw;
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return { ok: true, args: {} };
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { ok: false, reason: "The tool input must be a JSON object." }; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "The tool input must be a JSON object." };
  if (enc.encode(JSON.stringify(v)).length > CLIENT.maxArgsBytes) return { ok: false, reason: "The tool input is too large." };
  return { ok: true, args: v as Record<string, unknown> };
}

// ── client: the transport (Streamable HTTP, JSON or SSE answers) ──
export class ClientError extends Error {
  stage: string;   // 'address' | 'connect' | 'initialize' | 'tools/list' | 'tools/call'
  constructor(message: string, stage = "connect") { super(message); this.name = "ClientError"; this.stage = stage; }
}
// A body read up to max bytes. stop(text) ends the read early (an SSE stream that stays open after our answer);
// signal ends it when the request runs out of time.
export async function readCapped(res: Response, max: number, stop?: (text: string) => boolean, signal?: AbortSignal): Promise<string> {
  const big = () => new ClientError(`The server's answer is larger than ${+(max / 1_000_000).toFixed(1)} MB.`);
  if (Number(res.headers.get("content-length") || 0) > max) { try { await res.body?.cancel(); } catch { /* gone */ } throw big(); }
  if (!res.body) return "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, rej) => { onAbort = () => rej(new Error("aborted")); });
  aborted.catch(() => {});
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  let total = 0, text = "";
  try {
    for (;;) {
      const next = reader.read();
      next.catch(() => {});   // a read left behind by a timeout must not become an unhandled rejection
      const { done, value } = await Promise.race([next, aborted]);
      if (done) return text + dec.decode();
      total += value.byteLength;
      if (total > max) throw big();
      text += dec.decode(value, { stream: true });
      if (stop && stop(text)) return text;
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
}
export type Session = {
  url: string; ip: string | null; auth: Record<string, string>; secret: string | null; sessionId: string | null; protocol: string | null;
  // deno-lint-ignore no-explicit-any
  nextId: number; deadline: number; serverInfo?: any;
};
// One JSON-RPC message to the server: its result (null for a notification). Every failure is a ClientError whose
// message never carries a header and has the secret masked.
// deno-lint-ignore no-explicit-any
async function post(s: Session, msg: any, stage: string): Promise<any | null> {
  const fail = (m: string) => new ClientError(redact(m, [s.secret]), stage);
  const timeout = Math.min(CLIENT.timeoutMs, s.deadline - io.now());
  if (timeout <= 0) throw fail("The server took too long.");
  const slow = `The server took too long (${Math.round(timeout / 1000)} s).`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    let res: Response;
    try {
      res = await io.fetch(s.url, {
        method: "POST", redirect: "manual", signal: ctl.signal,
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "ops-mcp-client/1",
          ...(s.protocol ? { "MCP-Protocol-Version": s.protocol } : {}), ...(s.sessionId ? { "Mcp-Session-Id": s.sessionId } : {}), ...s.auth,
        },
        body: JSON.stringify(msg),
      }, s.ip);
    } catch { throw fail(ctl.signal.aborted ? slow : "OPS couldn't reach the server."); }
    const st = res.status;
    if (res.type === "opaqueredirect" || st < 200 || st >= 300) {
      try { await res.body?.cancel(); } catch { /* gone */ }
      if (res.type === "opaqueredirect" || (st >= 300 && st < 400)) throw fail("The server redirected the call; enter the final address.");
      if (st === 401 || st === 403) throw fail(`The server refused the key (HTTP ${st}).`);
      if (st === 404) throw fail("No MCP endpoint at that address (HTTP 404).");
      throw fail(`The server answered HTTP ${st}.`);
    }
    if (!("id" in msg)) { try { await res.body?.cancel(); } catch { /* gone */ } return null; }
    if (msg.method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid && /^[\x21-\x7E]{1,256}$/.test(sid)) s.sessionId = sid;
    }
    const sse = (res.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
    let text: string;
    try {
      text = await readCapped(res, CLIENT.maxBytes, sse ? (t) => !!pickResponse(parseSse(sseDone(t)), msg.id) : undefined, ctl.signal);
    } catch (e) {
      if (e instanceof ClientError) throw fail(e.message);
      throw fail(ctl.signal.aborted ? slow : "OPS couldn't reach the server.");
    }
    // deno-lint-ignore no-explicit-any
    let answer: any = null;
    if (sse) answer = pickResponse(parseSse(text), msg.id);
    else {
      // deno-lint-ignore no-explicit-any
      let v: any;
      try { v = JSON.parse(text); } catch { throw fail(FORMAT_REASON); }
      answer = pickResponse(Array.isArray(v) ? v : [v], msg.id);
    }
    if (!answer) throw fail(FORMAT_REASON);
    if (answer.error) {
      const e = answer.error && typeof answer.error === "object" ? answer.error : {};
      throw fail(`The server answered: ${clip(redact(String(e.message ?? ""), [s.secret]), 200)}` + (Number.isInteger(e.code) ? ` (code ${e.code})` : ""));
    }
    if (!answer.result || typeof answer.result !== "object") throw fail(FORMAT_REASON);
    return answer.result;
  } finally {
    clearTimeout(timer);
  }
}
// Connects: the address checked again (DNS at use time, every request pinned to the checked address), initialize, then
// notifications/initialized.
export async function openSession(server: { url: string; auth_header: string | null }, secret: string | null): Promise<Session> {
  const chk = checkServerUrl(server.url);
  if (!chk.ok) throw new ClientError(chk.reason, "address");
  const dns = await resolveChecked(chk.host);
  if (!dns.ok) throw new ClientError(dns.reason, "address");
  const hdr = cleanAuthHeader(server.auth_header);
  if (!hdr.ok) throw new ClientError(hdr.reason, "address");
  const name = hdr.value || "Authorization";
  const s: Session = { url: chk.url, ip: dns.ip, auth: secret ? { [name]: authHeaderValue(name, secret) } : {}, secret, sessionId: null, protocol: null, nextId: 1, deadline: io.now() + CLIENT.budgetMs };
  const init = await post(s, { jsonrpc: "2.0", id: s.nextId++, method: "initialize", params: { protocolVersion: CLIENT_PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO } }, "initialize");
  const pv = init.protocolVersion;
  if (typeof pv !== "string" || !PROTOCOL_VERSIONS.includes(pv)) throw new ClientError(`The server speaks an MCP version OPS doesn't support (${clip(redact(String(pv ?? ""), [secret]), 20)}).`, "initialize");
  s.protocol = pv;
  const si = init.serverInfo && typeof init.serverInfo === "object" ? init.serverInfo : {};
  s.serverInfo = { name: clip(redact(String(si.name ?? ""), [secret]), 120), version: clip(redact(String(si.version ?? ""), [secret]), 40) };
  await post(s, { jsonrpc: "2.0", method: "notifications/initialized" }, "initialize");
  return s;
}
// Every page of tools/list (following nextCursor), capped.
export async function listTools(s: Session) {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let cursor = "";
  for (let page = 0; page < CLIENT.maxToolPages && all.length < CLIENT.maxTools; page++) {
    const r = await post(s, { jsonrpc: "2.0", id: s.nextId++, method: "tools/list", params: cursor ? { cursor } : {} }, "tools/list");
    if (!Array.isArray(r.tools)) throw new ClientError(FORMAT_REASON, "tools/list");
    all.push(...r.tools);
    cursor = typeof r.nextCursor === "string" ? r.nextCursor : "";
    if (!cursor) break;
  }
  return cleanTools(all, s.secret);
}
// One tool call: the raw result (the caller previews or imports it).
// deno-lint-ignore no-explicit-any
export async function callRemoteTool(s: Session, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await post(s, { jsonrpc: "2.0", id: s.nextId++, method: "tools/call", params: { name, arguments: args } }, "tools/call");
  if (!Array.isArray(r.content) && (r.structuredContent == null || typeof r.structuredContent !== "object")) throw new ClientError(FORMAT_REASON, "tools/call");
  return r;
}

// ── client: the servers in the database ──
// deno-lint-ignore no-explicit-any
async function loadServer(sb: any, id: unknown): Promise<any | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await sb.from("mcp_servers").select("*").eq("id", id).eq("business_id", BUSINESS_ID).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}
// The server's secret from Vault (service role only). An error never carries the store's answer.
// deno-lint-ignore no-explicit-any
async function serverSecret(sb: any, row: any): Promise<string | null> {
  if (!row.secret_id) return null;
  const { data, error } = await sb.rpc("mcp_server_secret_get", { p_server: row.id });
  if (error) throw new Error("secret store unavailable");
  return typeof data === "string" && data ? data : null;
}
// The one way to call a saved server's tool (call_tool here; the imports and the hourly timer reuse it).
// deno-lint-ignore no-explicit-any
export async function remoteCall(sb: any, serverId: string, tool: string, args: Record<string, unknown>): Promise<{ result: any; data: unknown }> {
  const row = await loadServer(sb, serverId);
  if (!row) throw new ClientError("No such server.", "address");
  const secret = await serverSecret(sb, row);
  const raw = await callRemoteTool(await openSession(row, secret), tool, args);
  // Anything the server echoes of the secret is masked before an import could keep it in a record.
  const result = secret ? JSON.parse(redact(JSON.stringify(raw), [secret])) : raw;
  return { result, data: resultData(result) };
}

// ── client: the owner's steps ──
export const CLIENT_ACTIONS = ["save_server", "delete_server", "test_server", "call_tool"];
// deno-lint-ignore no-explicit-any
export async function clientAction(sb: any, body: any, me: any): Promise<{ status: number; body: any }> {
  if (!me) return { status: 401, body: { ok: false, reason: "unauthorized" } };
  if (me.role !== "owner") return { status: 403, body: { ok: false, reason: "owners only" } };
  const b = body && typeof body === "object" ? body : {};
  let secret: string | null = null;
  // deno-lint-ignore no-explicit-any
  const out = (status: number, o: any) => ({ status, body: typeof o.reason === "string" ? { ...o, reason: redact(o.reason, [secret]) } : o });
  const missing = () => out(404, { ok: false, reason: "No such server." });
  const nowIso = () => new Date(io.now()).toISOString();
  // deno-lint-ignore no-explicit-any
  const update = async (id: string, patch: any) => {
    const { error } = await sb.from("mcp_servers").update(patch).eq("id", id).eq("business_id", BUSINESS_ID);
    if (error) throw new Error(error.message);
  };
  switch (String(b.step || "")) {
    case "save_server": {
      const name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim() : "";
      if (!name || name.length > 80) return out(400, { ok: false, reason: "Give the server a name." });
      const chk = checkServerUrl(b.url);
      if (!chk.ok) return out(400, { ok: false, reason: chk.reason });
      const dns = await checkResolved(chk.host);
      if (dns) return out(400, { ok: false, reason: dns });
      const hdr = cleanAuthHeader(b.auth_header);
      if (!hdr.ok) return out(400, { ok: false, reason: hdr.reason });
      // Write-only secret: absent / null / '' keeps the saved one, a new value replaces it, clear_secret removes it.
      if (b.secret !== undefined && b.secret !== null && b.secret !== "") {
        const bad = checkSecret(b.secret);
        if (bad) return out(400, { ok: false, reason: bad });
        secret = b.secret as string;
      }
      const clear = !secret && b.clear_secret === true;
      let authHeader = hdr.value || (secret ? "Authorization" : null);
      let id: string, isNew = false;
      if (b.id !== undefined && b.id !== null && b.id !== "") {
        const row = await loadServer(sb, b.id);
        if (!row) return missing();
        id = row.id;
        // The saved secret belongs to the saved host: a new host (or port) needs the secret typed again, so it is never
        // sent to an address it wasn't given for.
        if (row.secret_id && !secret && !clear && hostOf(row.url) !== hostOf(chk.url)) return out(400, { ok: false, reason: "Enter the key again for the new address (or remove the saved key)." });
        if (b.auth_header === undefined) authHeader = row.auth_header ?? authHeader;   // not sent = unchanged
        const changed = row.url !== chk.url || (row.auth_header ?? null) !== authHeader || !!secret || (clear && !!row.secret_id);
        await update(id, { name, url: chk.url, auth_header: authHeader, ...(changed ? { last_test_at: null, last_test_ok: null, last_tools: null } : {}) });
      } else {
        const { data, error } = await sb.from("mcp_servers").insert({ business_id: BUSINESS_ID, name, url: chk.url, auth_header: authHeader, created_by: me.id }).select("*").single();
        if (error || !data) throw new Error((error && error.message) || "insert failed");
        id = data.id;
        isNew = true;
      }
      if (secret || (clear && !isNew)) {
        const { error } = await sb.rpc("mcp_server_secret_set", { p_server: id, p_secret: secret });
        if (error) {
          if (isNew) await sb.from("mcp_servers").delete().eq("id", id).eq("business_id", BUSINESS_ID);
          return out(500, { ok: false, reason: "The secret could not be saved." });
        }
      }
      const saved = await loadServer(sb, id);
      if (!saved) return missing();
      return out(200, { ok: true, server: publicServer(saved) });
    }
    case "delete_server": {
      const row = await loadServer(sb, b.id);
      if (!row) return missing();
      // The SQL trigger deletes its Vault secret; its import rules go with it (on delete cascade).
      const { error } = await sb.from("mcp_servers").delete().eq("id", row.id).eq("business_id", BUSINESS_ID);
      if (error) throw new Error(error.message);
      return out(200, { ok: true });
    }
    case "test_server": {
      const row = await loadServer(sb, b.id);
      if (!row) return missing();
      secret = await serverSecret(sb, row);
      try {
        const s = await openSession(row, secret);
        const tools = await listTools(s);
        await update(row.id, { last_test_at: nowIso(), last_test_ok: true, last_tools: tools });
        const saved = (await loadServer(sb, row.id)) || row;
        // deno-lint-ignore no-explicit-any
        return out(200, { ok: true, test_ok: true, protocol: s.protocol, server_info: s.serverInfo, tools: tools.map((t: any) => ({ name: t.name, title: t.title, description: t.description })), server: publicServer(saved) });
      } catch (e) {
        if (!(e instanceof ClientError)) throw e;
        await update(row.id, { last_test_at: nowIso(), last_test_ok: false });   // the last good tool list stays
        return out(502, { ok: false, test_ok: false, stage: e.stage, reason: e.message });
      }
    }
    case "call_tool": {
      if (typeof b.tool !== "string" || !TOOL_NAME.test(b.tool)) return out(400, { ok: false, reason: "That tool name doesn't look right." });
      const args = cleanArgs(b.args);
      if (!args.ok) return out(400, { ok: false, reason: args.reason });
      const row = await loadServer(sb, b.id);
      if (!row) return missing();
      secret = await serverSecret(sb, row);
      try {
        const result = await callRemoteTool(await openSession(row, secret), b.tool, args.args);
        return out(200, { ok: true, ...previewResult(result, secret) });
      } catch (e) {
        if (!(e instanceof ClientError)) throw e;
        return out(502, { ok: false, stage: e.stage, reason: e.message });
      }
    }
  }
  return out(400, { ok: false, reason: "unknown action" });
}

// ── imports: registry ──
// What an import rule can make, where it goes, and the activity_log record_kind the app uses for it.
export const IMPORT_KINDS = ["contacts", "jobs", "tasks"];
const IMPORT_TABLE: Record<string, string> = { contacts: "contacts", jobs: "jobs", tasks: "tasks" };
const IMPORT_RECORD_KIND: Record<string, string> = { contacts: "contact", jobs: "job", tasks: "task" };
const IMPORT_ACTOR = "MCP import";            // the actor of the history entries an import writes (Undo removes only these)
export const IMPORT_MAX_ROWS = 500;          // items read per run
export const IMPORT_PREVIEW_ROWS = 200;      // rows shown in a preview
export const IMPORT_CHUNK = 100;             // rows per insert / delete
export const RUN_STALE_MS = 10 * 60e3;       // a run 'running' longer than this has stopped
export const HOURLY_GAP_MS = 55 * 60e3;      // an hourly rule runs at most once in this long
// The timer starts no new rule after CRON_BUDGET_MS. A rule that starts just before it can still take CLIENT.budgetMs
// (45 s) for the server plus its database work, and the platform stops background work at 150 s (free plan).
export const CRON_BUDGET_MS = 40e3;
export const CRON_MAX_RULES = 20;
export const RUN_ERRORS_MAX = 50;
export const TOOL_ARGS_MAX = 4000;
export const IMPORT_SCAN = { max: 50 * PAGE };   // existing rows the duplicate check reads (an object, so tests can shrink it)
// The key on a contact's first thread entry that marks an import made with automations off (kept for the app). The
// automations engine (quietArrival) and the phone notifications (push) read the import_quiet column, and this key too:
// such a card is not a new lead.
export const QUIET_KEY = "quiet";
export type ImportField = { label: string; type: "text" | "email" | "phone" | "day" | "money" | "bool" | "enum" | "tags" | "person" | "catalog"; max?: number; required?: boolean; values?: string[]; list?: CatalogSection; past?: boolean };
// The fields an import can fill, per kind (keys = the database columns). One entry per line: the app's MCP_IMPORT_FIELDS
// is parity-tested against these keys. The task lists are the app's TASK_STATUSES / TASK_PRIORITIES / TASK_CATEGORIES.
export const IMPORT_FIELDS: Record<string, Record<string, ImportField>> = {
  contacts: {
    full_name: { label: "Name", type: "text", max: 120, required: true },
    phone: { label: "Phone", type: "phone", max: 40 },
    email: { label: "Email", type: "email", max: 200 },
    postcode: { label: "Postcode", type: "text", max: 10 },
    division: { label: "Service", type: "catalog", list: "services" },
    source: { label: "Lead source", type: "catalog", list: "sources" },
    sub_source: { label: "Sub-source", type: "text", max: 60 },
    status: { label: "Stage", type: "catalog", list: "stages" },
    job_description: { label: "Job description", type: "text", max: 1000 },
    estimated_value: { label: "Estimated value", type: "money" },
    notes: { label: "Notes", type: "text", max: 2000 },
    tags: { label: "Tags", type: "tags" },
    created_at: { label: "Date received", type: "day", past: true },   // a lead can't arrive after today (MapCtx.today)
  },
  jobs: {
    customer_name: { label: "Customer", type: "text", max: 120, required: true },
    invoice_number: { label: "Invoice number", type: "text", max: 40 },
    date: { label: "Job date", type: "day" },
    technician: { label: "Technician", type: "person" },
    job_type: { label: "Job type", type: "text", max: 60 },
    amount: { label: "Amount", type: "money" },
    includes_gst: { label: "Includes GST", type: "bool" },
    payment_status: { label: "Payment status", type: "enum", values: ["Paid", "Unpaid"] },
    payment_method: { label: "Payment method", type: "text", max: 40 },
    parts_cost: { label: "Parts cost", type: "money" },
    notes: { label: "Notes", type: "text", max: 2000 },
  },
  tasks: {
    title: { label: "Title", type: "text", max: 200, required: true },
    notes: { label: "Notes", type: "text", max: 2000 },
    due: { label: "Due date", type: "day" },
    status: { label: "Status", type: "enum", values: ["Not Started", "In Progress", "Waiting on Response", "Stuck", "Done"] },
    priority: { label: "Priority", type: "enum", values: ["Low", "Medium", "High", "Urgent"] },
    client: { label: "Client", type: "text", max: 120 },
    assigned_to: { label: "Assigned to", type: "person" },
    category: { label: "Category", type: "enum", values: ["Client-related", "Financial", "Personal", "Operational", "Marketing"] },
  },
};
// The duplicate check a new rule starts with (the UI's starting values).
export const DEFAULT_DEDUPE = { contacts: { fields: ["phone", "email"], match: "any" }, jobs: { fields: ["invoice_number"], match: "any" }, tasks: { fields: ["title", "due"], match: "all" } };

// ── imports: the business's own lists (Settings → Pipeline / Services / Lead sources) and renamable words ──
export const CATCH_ALL_SERVICE = "Other";                 // an unknown service lands here (as conversations / voice)
export const NEW_STAGE = "New";                           // an unknown stage lands here (every new lead starts in New)
// Where an unknown value of a list lands: the New stage, the catch-all service; an unknown source is left empty, so the
// row gets the import's own source (catalog.mcp.importSource).
export const CATALOG_FALLBACK: Record<CatalogSection, string> = { stages: NEW_STAGE, services: CATCH_ALL_SERVICE, sources: "" };
// today: the business's day now; a past-only day field (Date received) after it is a problem row.
export type MapCtx = { tz: string; people: string[]; lists?: CatalogLists; keys?: CatalogKeys; tax?: string; today?: string };

// ── imports: pure helpers ──
const iso = (ms: number) => new Date(ms).toISOString();
const hasOwn = (o: unknown, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
// deno-lint-ignore no-explicit-any
const plainObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const PATH_SEG = /^([A-Za-z0-9_$-]{1,64})(?:\[(\d{1,6})\])?$/;
const BAD_SEGS = ["__proto__", "prototype", "constructor"];
// Where a value sits in a tool's answer: '' (the whole answer) or name[.name…], each optionally with one [n].
export function validPath(p: string): boolean {
  if (p === "") return true;
  if (typeof p !== "string" || p.length > 200) return false;
  const segs = p.split(".");
  if (segs.length > 12) return false;
  return segs.every((s) => { const m = PATH_SEG.exec(s); return !!m && !BAD_SEGS.includes(m[1]); });
}
// The value at a path: own properties and array items only (never anything inherited); undefined when a step is missing.
export function getPath(root: unknown, p: string): unknown {
  if (p === "") return root;
  if (!validPath(p)) return undefined;
  let cur: unknown = root;
  for (const s of p.split(".")) {
    const m = PATH_SEG.exec(s) as RegExpExecArray;
    if (!hasOwn(cur, m[1])) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      if (!Array.isArray(cur) || n >= cur.length) return undefined;
      cur = cur[n];
    }
  }
  return cur;
}
// The data in a tool's answer: its structured content, else its first text item as JSON.
// deno-lint-ignore no-explicit-any
export function toolData(result: any): { ok: true; data: unknown } | { ok: false; reason: string } {
  const r = result && typeof result === "object" ? result : {};
  // deno-lint-ignore no-explicit-any
  const text = (Array.isArray(r.content) ? r.content : []).find((c: any) => c && c.type === "text" && typeof c.text === "string");
  if (r.isError === true) { const t = clip(text ? text.text : "", 200); return { ok: false, reason: "The tool reported an error" + (t ? ": " + t : ".") }; }
  if (r.structuredContent && typeof r.structuredContent === "object") return { ok: true, data: r.structuredContent };
  if (!text) return { ok: false, reason: "The tool returned nothing" };
  try { return { ok: true, data: JSON.parse(text.text) }; } catch { return { ok: false, reason: "The tool did not return JSON data" }; }
}
// The list of items at itemsPath, at most IMPORT_MAX_ROWS of them.
export function itemsAt(data: unknown, itemsPath: string): { ok: true; items: unknown[]; truncated: boolean } | { ok: false; reason: string } {
  const v = getPath(data, itemsPath);
  if (v === undefined) return { ok: false, reason: `Nothing found at "${clip(itemsPath, 200)}"` };
  if (!Array.isArray(v)) return { ok: false, reason: itemsPath ? `"${itemsPath}" is not a list` : "The tool's answer is not a list" };
  return { ok: true, items: v.slice(0, IMPORT_MAX_ROWS), truncated: v.length > IMPORT_MAX_ROWS };
}
const EMPTY_VALUE: Record<string, unknown> = { text: "", phone: "", email: "", day: null, money: 0, bool: false, enum: null, tags: [], person: "", catalog: "" };
const emptyOf = (f: ImportField) => { const e = EMPTY_VALUE[f.type]; return Array.isArray(e) ? [] : e; };
const isBlank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const prim = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
// A date-time that says its own zone: a time followed by Z or an offset, or GMT/UTC (optionally with an offset and a name).
export const ZONED_TIME = /(?:\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)|\b(?:GMT|UTC)(?:\s*[+-]\d{2}:?\d{2})?(?:\s*\([^)]*\))?)$/i;
// One source value as the field's type (the app's own formats). Empty gives the type's empty value.
export function coerceField(f: ImportField, v: unknown, ctx: MapCtx): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (v == null || (typeof v === "string" && !v.trim())) return { ok: true, value: emptyOf(f) };
  const bad = (reason: string) => ({ ok: false as const, reason });
  const ok = (value: unknown) => ({ ok: true as const, value });
  switch (f.type) {
    case "text": return prim(v) ? ok(clip(v, f.max ?? 2000)) : bad("is not text");
    case "email": {
      const s = prim(v) ? String(v).trim().toLowerCase() : "";
      return s.length <= (f.max ?? 200) && /^[^\s@"',()\\]+@[^\s@"',()\\]+\.[^\s@"',()\\]+$/.test(s) ? ok(s) : bad("is not a valid email");
    }
    case "phone": return prim(v) && typeof v !== "boolean" ? ok(String(v).trim().slice(0, f.max ?? 40)) : bad("is not a phone number");
    case "day": {
      if (typeof v !== "string") return bad("is not a date");
      // A past-only field (Date received) after the business's today is refused, never clamped: a wrong date is shown.
      const day = (d: string) => f.past && ctx.today && d > ctx.today ? bad("is in the future") : ok(d);
      const s = v.trim();
      // A date, or a date with a wall time and no zone ("2026-09-30T18:00:00", "2026-09-30 15:30"): that calendar day as written.
      const wall = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
      if (wall) return isDay(wall[1]) ? day(wall[1]) : bad("is not a date");
      const ms = Date.parse(s);
      if (!Number.isFinite(ms)) return bad("is not a date");
      // An instant with its own zone (Z, +10:00, GMT): the day it was in the business's zone.
      if (ZONED_TIME.test(s)) return day(bizParts(ms, ctx.tz).day);
      // No zone ("09/30/2026", "Sep 30 2026"): the runtime read it as its own local wall time, so its local calendar day is
      // the day written (never moved through the business's zone, which would shift it by a day east or west of UTC).
      const d = new Date(ms);
      return day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    case "money": {
      if (typeof v !== "string" && typeof v !== "number") return bad("is not an amount");
      const s = String(v).replace(/[$,\s]/g, ""), n = Number(s);
      return s !== "" && Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? ok(Math.round(n * 100) / 100) : bad("is not an amount");
    }
    case "bool": {
      if (typeof v === "boolean") return ok(v);
      const s = String(prim(v) ? v : "").trim().toLowerCase();
      if (["yes", "true", "1"].includes(s)) return ok(true);
      if (["no", "false", "0"].includes(s)) return ok(false);
      return bad("is not yes/no");
    }
    case "enum": {
      // Paid / Done as the business calls them (catalog.keys)
      const values = (f.values || []).map((x) => renamedKey(ctx.keys, x));
      const s = prim(v) ? String(v).trim().toLowerCase() : "";
      const hit = values.find((x) => x.toLowerCase() === s);
      return hit ? ok(hit) : bad("is not one of: " + values.join(", "));
    }
    case "catalog": {
      // The business's own list (key or label, any case); anything else lands where conversations / voice put it.
      if (!prim(v) || typeof v === "boolean") return bad("is not text");
      const sec = f.list as CatalogSection, lists = ctx.lists || catalogLists(null, ctx.keys);
      return ok(catalogMatch(lists[sec] || [], String(v)) ?? CATALOG_FALLBACK[sec]);
    }
    case "tags": {
      // As the lead card keeps them: trimmed, at most 60 characters, one of each whatever the case (the first spelling).
      const list = Array.isArray(v) ? v : prim(v) ? String(v).split(",") : null;
      if (!list || list.some((x) => x != null && !prim(x))) return bad("is not a list of tags");
      const out: string[] = [], seen = new Set<string>();
      for (const x of list) { const t = clip(x, 60); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); } }
      return ok(out.slice(0, 20));
    }
    case "person": {
      const s = prim(v) ? String(v).trim().toLowerCase() : "";
      const hit = ctx.people.find((p) => p.toLowerCase() === s);
      return hit ? ok(hit) : bad("is not someone on the team");
    }
  }
  return bad("is not supported");
}
// One item through a rule's mapping: { target: "path" | { path } | { value } }. Unknown targets are ignored.
// deno-lint-ignore no-explicit-any
export function mapItem(kind: string, mapping: any, item: unknown, ctx: MapCtx): { values: Record<string, unknown>; errors: string[] } {
  const fields = IMPORT_FIELDS[kind] || {}, values: Record<string, unknown> = {}, errors: string[] = [], failed = new Set<string>();
  for (const target of Object.keys(plainObj(mapping) ? mapping : {})) {
    if (!hasOwn(fields, target)) continue;
    const e = mapping[target], f = fields[target];
    let raw: unknown;
    if (typeof e === "string") raw = getPath(item, e);
    else if (plainObj(e) && typeof e.path === "string") raw = getPath(item, e.path);
    else if (plainObj(e) && hasOwn(e, "value")) raw = e.value;
    else continue;
    const r = coerceField(f, raw, ctx);
    // the tax field by the business's own tax name (GST, VAT, Sales tax…), as the app's mapping shows it
    if (r.ok) values[target] = r.value; else { errors.push(`${target === "includes_gst" && ctx.tax ? `Includes ${ctx.tax}` : f.label} ${r.reason}`); failed.add(target); }
  }
  for (const [k, f] of Object.entries(fields)) if (f.required && !failed.has(k) && isBlank(values[k])) errors.push(`${f.label} is missing`);
  return { values, errors };
}
// A value as the duplicate check compares it (phones by their last 9 digits, like automations' phoneKey; an invoice
// number by its digits). field names the column, for the invoice-number rule.
export function normKey(type: string, v: unknown, field = ""): string {
  if (v == null) return "";
  if (type === "phone") { const d = String(v).replace(/\D/g, ""); return d.length >= 8 ? d.slice(-9) : ""; }
  if (type === "email") return String(v).trim().toLowerCase();
  if (type === "day") return String(v).slice(0, 10);
  if (type === "money") return v === "" ? "" : String(Number(v));
  if (type === "bool") return String(v === true || v === "true");
  if (type === "tags") return Array.isArray(v) ? v.map(String).sort().join(",") : "";
  const s = String(v).toLowerCase().replace(/\s+/g, " ").trim();
  if (field === "invoice_number") { const d = s.replace(/\D/g, ""); return d || s; }
  return s;
}
// The duplicate-check keys of one row: 'any' = one key per filled field; 'all' = one combined key, where an empty part
// is part of the key ('title=x|due=': an undated task matches the same title with no date), null only when every part
// is empty.
// deno-lint-ignore no-explicit-any
export function rowKeys(kind: string, dedupe: any, values: Record<string, unknown>): string[] | null {
  const fields = IMPORT_FIELDS[kind] || {}, list: string[] = (dedupe && Array.isArray(dedupe.fields) ? dedupe.fields : []).filter((f: string) => hasOwn(fields, f));
  const parts = list.map((f) => [f, normKey(fields[f].type, values[f], f)]);
  if (dedupe && dedupe.match === "all") return parts.some(([, k]) => k) ? [parts.map(([f, k]) => `${f}=${k}`).join("|")] : null;
  const keys = parts.filter(([, k]) => k).map(([f, k]) => `${f}=${k}`);
  return keys.length ? keys : null;
}
// The same keys over rows already in OPS (their columns are the IMPORT_FIELDS keys): key → id (the first one wins).
// deno-lint-ignore no-explicit-any
export function keyIndex(kind: string, dedupe: any, rows: any[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) for (const k of rowKeys(kind, dedupe, r) || []) if (!out.has(k)) out.set(k, String(r.id));
  return out;
}
export type FlaggedRow = { i: number; status: "new" | "duplicate" | "error"; reason?: string; match_id?: string; values: Record<string, unknown> };
// Each mapped item: new, a duplicate (of a row in OPS, or of an earlier item of this import) or an error.
// deno-lint-ignore no-explicit-any
export function flagRows(kind: string, dedupe: any, mapped: { values: Record<string, unknown>; errors: string[] }[], existing: Map<string, string>): FlaggedRow[] {
  const seen = new Set<string>();
  return mapped.map((m, i) => {
    if (m.errors.length) return { i, status: "error", reason: m.errors.join("; "), values: m.values };
    const keys = rowKeys(kind, dedupe, m.values);
    if (!keys) return { i, status: "error", reason: "No value in the duplicate-check fields", values: m.values };
    const hit = keys.find((k) => existing.has(k));
    if (hit) return { i, status: "duplicate", reason: "Already in OPS", match_id: existing.get(hit), values: m.values };
    if (keys.some((k) => seen.has(k))) return { i, status: "duplicate", reason: "Repeated in this import", values: m.values };
    keys.forEach((k) => seen.add(k));
    return { i, status: "new", values: m.values };
  });
}
const RULE_TOOL = /^[A-Za-z0-9_.\/-]+$/;
// What is wrong with a rule (empty = good), in plain English. tool_args and items_path may be left out ({} and '').
// deno-lint-ignore no-explicit-any
export function validateRule(r: any): string[] {
  if (!plainObj(r)) return ["The rule is missing."];
  const out: string[] = [];
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name.length > 80) out.push("Give the rule a name of 1 to 80 characters.");
  const kindOk = IMPORT_KINDS.includes(r.kind);
  if (!kindOk) out.push("Choose what to import: contacts, jobs or tasks.");
  if (!isUuid(r.server_id)) out.push("Choose the server to import from.");
  if (typeof r.tool !== "string" || !r.tool || r.tool.length > 120 || !RULE_TOOL.test(r.tool)) out.push("Enter the tool's name (letters, digits and _ . / - only, up to 120 characters).");
  const args = r.tool_args === undefined ? {} : r.tool_args;
  if (!plainObj(args)) out.push("The tool input must be a JSON object.");
  else if (JSON.stringify(args).length > TOOL_ARGS_MAX) out.push(`The tool input is too long (at most ${TOOL_ARGS_MAX} characters).`);
  const ip = r.items_path === undefined ? "" : r.items_path;
  if (typeof ip !== "string" || !validPath(ip)) out.push("The list path is not valid (for example: items or data.results).");
  const fields = kindOk ? IMPORT_FIELDS[r.kind] : {};
  const mapping = plainObj(r.mapping) ? r.mapping : null, n = mapping ? Object.keys(mapping).length : 0;
  if (!mapping || n < 1 || n > 40) out.push("Map 1 to 40 fields.");
  // deno-lint-ignore no-explicit-any
  const byPath = (e: any) => (typeof e === "string" && validPath(e)) || (plainObj(e) && Object.keys(e).length === 1 && typeof e.path === "string" && validPath(e.path));
  // deno-lint-ignore no-explicit-any
  const byValue = (e: any) => plainObj(e) && Object.keys(e).length === 1 && hasOwn(e, "value") && prim(e.value) && String(e.value).length <= 500;
  if (mapping && kindOk) {
    for (const [t, e] of Object.entries(mapping)) {
      if (!hasOwn(fields, t)) out.push(`"${clip(t, 40)}" is not a field you can import into.`);
      else if (!byPath(e) && !byValue(e)) out.push(`The mapping of ${fields[t].label} is not valid.`);
    }
    for (const [k, f] of Object.entries(fields)) if (f.required && !hasOwn(mapping, k)) out.push(`Map ${f.label}: it is required.`);
  }
  const d = r.dedupe;
  const list = plainObj(d) && Array.isArray(d.fields) ? d.fields : null;
  if (!list || list.length < 1 || list.length > 4 || new Set(list).size !== list.length || list.some((f: unknown) => typeof f !== "string")) out.push("Choose 1 to 4 different fields to find duplicates.");
  else if (kindOk) {
    for (const f of list as string[]) {
      if (!hasOwn(fields, f)) out.push(`"${clip(f, 40)}" can't be used to find duplicates.`);
      else if (!mapping || !hasOwn(mapping, f) || !byPath(mapping[f])) out.push(`${fields[f].label} finds duplicates, so map it from the data (not a fixed value).`);
    }
  }
  if (!plainObj(d) || (d.match !== "any" && d.match !== "all")) out.push("Choose whether any or all of the duplicate fields must match.");
  if (r.mode !== "manual" && r.mode !== "hourly") out.push("Choose manual or hourly.");
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") out.push("'enabled' must be true or false.");
  if (r.run_automations !== undefined && typeof r.run_automations !== "boolean") out.push("'run_automations' must be true or false.");
  return out;
}
// deno-lint-ignore no-explicit-any
export type ImportCtx = { quiet: boolean; nowMs: number; tz: string; ruleName: string; serverName: string; importSource: string; profiles: any[]; employees?: any[]; rates?: Record<string, any>; keys?: CatalogKeys };
// The row inserted for one new item. Always the same keys for a kind: a bulk insert sends the union of every row's
// keys, so a key missing from one row would be written as NULL there.
export function importRow(kind: string, values: Record<string, unknown>, ctx: ImportCtx): Record<string, unknown> {
  const fields = IMPORT_FIELDS[kind] || {}, row: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) row[k] = hasOwn(values, k) && values[k] !== undefined ? values[k] : emptyOf(f);
  const or = (k: string, d: unknown) => { if (isBlank(row[k])) row[k] = d; };
  const today = bizParts(ctx.nowMs, ctx.tz).day, at = iso(ctx.nowMs);
  // The one marker the automations engine and push read (SQL M5-review): an import made with automations off.
  row.import_quiet = ctx.quiet;
  if (kind === "contacts") {
    or("division", CATCH_ALL_SERVICE); or("source", ctx.importSource); or("status", NEW_STAGE);
    // "Date received" mapped: the card arrived that business day (its created_at AND its first thread entry), so
    // imported history never shows as today's new leads. Not mapped: today. The same stamp as conversations / voice.
    const received = isDay(row.created_at) ? String(row.created_at) : null;
    row.created_at = bizDayStamp(received || today, ctx.tz);
    const firstAt = received ? new Date(Date.parse(String(row.created_at))).toISOString() : at;
    const text = `Imported from ${ctx.serverName} (${ctx.ruleName})` + (ctx.quiet ? ", automatic messages off" : "");
    row.messages = [{ id: crypto.randomUUID(), kind: "event", at: firstAt, text: clip(text, 300), ...(ctx.quiet ? { [QUIET_KEY]: true } : {}) }];
    row.last_read_at = ctx.quiet ? at : null;   // quiet: no "new lead waiting" alert in the app and no leadWaiting push
    row.stage_changed_at = null;                // the engine's stage trigger needs a real move
    row.linked_job_id = null;
    row.starred = false;
  } else if (kind === "jobs") {
    or("date", today); or("job_type", "Other"); or("payment_status", "Unpaid");
    // As the app's job form: GST applies unless the data says otherwise, and the commission is the technician's rate
    // for that job type (Settings → People → commission rates), 0 when there is none.
    if (!hasOwn(values, "includes_gst")) row.includes_gst = true;
    row.commission_percent = commissionRateFor(ctx.rates || {}, String(row.technician || ""), String(row.job_type || "")) ?? 0;
    row.date_paid = row.payment_status === (ctx.keys || KEY_DEFAULTS).paid ? row.date : null;
    row.paid_to_technician = "Not Paid";
    row.parts_refund_status = "N/A";
    row.cash_confirmed = false;
    row.entered_by = clip("MCP import: " + ctx.ruleName, 80);
    // Quiet (as review-requests' sheet sync and the engine's rule for old jobs): no review request, never "newly closed".
    row.review_do_not_ask = ctx.quiet;
    row.created_at = ctx.quiet ? null : at;
  } else if (kind === "tasks") {
    or("status", "Not Started"); or("priority", "Medium"); or("category", "");
    const who = String(row.assigned_to || "");
    row.assignees = who ? [who] : [];
    row.board = boardFor(row.assignees as string[], ctx.profiles, ctx.employees || []);
    row.created_by = clip("MCP import: " + ctx.ruleName, 200);
    row.created_at = at;
    row.heads_up = "";
    row.technician = "";
    row.subtasks = [];
    row.updates = [];
    row.contact_id = null;
  }
  return row;
}
// Verbatim from index.html (the job form's automatic commission %): the rate for a technician and job type, or null.
// deno-lint-ignore no-explicit-any
export function commissionRateFor(rates: Record<string, any>, tech: string, jobType: string) {
  const t = rates[tech]; if (!t) return null;
  const v = t[jobType]; return (v===null||v===undefined) ? null : v;
}
// The app's board rule (index.html boardForAssignees, parity-tested; the same as automations' boardFor): the office's
// tasks — a VA login (full name, technician name or the first word of the full name) or an employee with the VA role —
// and tasks with no one go on the office's board (its storage key stays 'ron'); anyone else's on their own board.
// deno-lint-ignore no-explicit-any
export function boardFor(names: string[], profiles: any[], employees: any[] = []): string {
  const first = names[0]; if (!first) return "ron";
  const va = profiles.find((p) => p.role === "va" && (p.full_name === first || p.technician_name === first || String(p.full_name || "").trim().split(/\s+/)[0] === first))
    || employees.some((e) => e && e.name === first && Array.isArray(e.roles) && e.roles.includes("VA"));
  return va ? "ron" : first;
}
export function runStatus(inserted: number, errorCount: number): "done" | "partial" | "failed" {
  return errorCount === 0 ? "done" : inserted > 0 ? "partial" : "failed";
}

// ── imports: database ──
// What a run needs besides the rule: the business's time zone and import source, the profiles and the employees with
// their roles (task boards), the active employees' names (tasks and jobs can only be given to someone on the team) and,
// for jobs, the commission rates.
// deno-lint-ignore no-explicit-any
async function importContext(sb: any, rule: any, nowMs: number) {
  const biz = await loadBusiness(sb);
  const { rows: profiles } = await pageAll((a, z) => sb.from("profiles").select("id, full_name, role, technician_name").order("id").range(a, z));
  const { rows: employees } = await pageAll((a, z) => sb.from("employees").select("name, status, roles").order("name").range(a, z));
  // deno-lint-ignore no-explicit-any
  const people = employees.filter((e: any) => e.status === "Active").map((e: any) => String(e.name || "")).filter(Boolean);
  // deno-lint-ignore no-explicit-any
  const rates: Record<string, any> = {};
  if (rule.kind === "jobs") {
    const { rows } = await pageAll((a, z) => sb.from("commission_rates").select("technician_name, rates").order("technician_name").range(a, z));
    // deno-lint-ignore no-explicit-any
    rows.forEach((r: any) => { rates[r.technician_name] = r.rates || {}; });
  }
  const keys = catalogKeys(biz.catalog);
  return { tz: biz.tz, importSource: biz.mcp.importSource, profiles, employees, people, rates, ruleName: String(rule.name || ""), nowMs, keys, lists: catalogLists(biz.catalog, keys), tax: taxNameOf(biz.catalog),
    today: bizParts(nowMs, biz.tz).day };
}
const SERVER_COLS = "id, business_id, name, url, auth_header, secret_id";   // never the secret (it is only in Vault)
// A rule and its server, both of this business, or null.
// deno-lint-ignore no-explicit-any
async function loadRuleAndServer(sb: any, ruleId: unknown): Promise<{ rule: any; server: any } | null> {
  if (!isUuid(ruleId)) return null;
  const { data: rule, error } = await sb.from("mcp_import_rules").select("*").eq("id", ruleId).eq("business_id", BUSINESS_ID).maybeSingle();
  if (error) throw new Error(error.message);
  if (!rule) return null;
  const { data: server, error: se } = await sb.from("mcp_servers").select(SERVER_COLS).eq("id", rule.server_id).eq("business_id", BUSINESS_ID).maybeSingle();
  if (se) throw new Error(se.message);
  return server ? { rule, server } : null;
}
// The duplicate-check keys of what is already in OPS (id + the dedupe columns, paged, at most IMPORT_SCAN.max rows).
// complete is false when there are more rows than that: the check would miss some, so the import is refused.
// deno-lint-ignore no-explicit-any
async function existingIndex(sb: any, kind: string, dedupe: any): Promise<{ index: Map<string, string>; complete: boolean }> {
  const cols = ["id", ...(dedupe.fields as string[]).filter((f) => hasOwn(IMPORT_FIELDS[kind], f))].join(", ");
  const { rows, truncated } = await pageAll((a, z) => sb.from(IMPORT_TABLE[kind]).select(cols).order("id").range(a, z), IMPORT_SCAN.max);
  return { index: keyIndex(kind, dedupe, rows), complete: !truncated };
}
// Fetch → items → map → duplicate flags. Writes nothing. The tool gets exactly the saved arguments: no OPS data is added.
// deno-lint-ignore no-explicit-any
export async function planImport(sb: any, rule: any, server: any, nowMs: number) {
  const bad = validateRule(rule);
  if (bad.length) return { ok: false as const, reason: bad[0] };
  const call = await io.callTool(sb, server, rule.tool, rule.tool_args || {});
  if (!call.ok) return { ok: false as const, reason: call.reason };
  const td = toolData(call.result);
  if (!td.ok) return { ok: false as const, reason: td.reason };
  const it = itemsAt(td.data, rule.items_path || "");
  if (!it.ok) return { ok: false as const, reason: it.reason };
  const ctx = await importContext(sb, rule, nowMs);
  const mapped = it.items.map((item) => mapItem(rule.kind, rule.mapping, item, ctx));
  const ex = await existingIndex(sb, rule.kind, rule.dedupe);
  if (!ex.complete) return { ok: false as const, reason: `The duplicate check can only read ${IMPORT_SCAN.max.toLocaleString("en-AU")} existing records, and there are more, so nothing was imported.` };
  const rows = flagRows(rule.kind, rule.dedupe, mapped, ex.index);
  return { ok: true as const, fetched: it.items.length, truncated: it.truncated, rows, ctx: { ...ctx, serverName: String(server.name || "") } };
}
// One import: insert the new rows (insert only), record exactly which ids it made, so Undo can take back those and
// nothing else. One running run per rule (the partial unique index): a second one answers { busy: true }.
// deno-lint-ignore no-explicit-any
export async function runImport(sb: any, rule: any, server: any, opts: { source: "manual" | "hourly"; by: string | null; nowMs: number }): Promise<{ busy: true } | { busy: false; run: any }> {
  const nowMs = opts.nowMs, kind = rule.kind;
  // deno-lint-ignore no-explicit-any
  const must = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message || "write failed"); return data; };
  // 1. A run left 'running' by a crash is closed, so it neither blocks this one nor looks alive.
  await must(sb.from("mcp_import_runs").update({ status: "failed", finished_at: iso(nowMs), errors: [{ reason: "Stopped before it finished" }] })
    .eq("rule_id", rule.id).eq("status", "running").lt("started_at", iso(nowMs - RUN_STALE_MS)));
  // 2. Claim the rule.
  const { data: run, error: re } = await sb.from("mcp_import_runs").insert({
    business_id: BUSINESS_ID, rule_id: rule.id, rule_name: rule.name, kind, source: opts.source, run_automations: rule.run_automations === true,
    started_by: opts.by, started_at: iso(nowMs), status: "running",
  }).select("*").single();
  if (re && re.code === "23505") return { busy: true };
  if (re || !run) throw new Error((re && re.message) || "run insert failed");
  const finish = async (patch: Record<string, unknown>) => {
    await must(sb.from("mcp_import_rules").update({ last_run_at: iso(nowMs) }).eq("id", rule.id).eq("business_id", BUSINESS_ID));
    return { busy: false as const, run: await must(sb.from("mcp_import_runs").update({ finished_at: iso(io.now()), ...patch }).eq("id", run.id).select("*").single()) };
  };
  // 3. Fetch and flag.
  let plan: Awaited<ReturnType<typeof planImport>>;
  try { plan = await planImport(sb, rule, server, nowMs); } catch (e) {
    console.error("mcp import plan failed:", clip((e as Error)?.message, 200));
    plan = { ok: false as const, reason: "The import could not be prepared." };
  }
  if (!plan.ok) return await finish({ status: "failed", errors: [{ reason: plan.reason }] });
  // 4. Insert the new rows in chunks; a chunk that fails goes row by row, so one bad row never stops the rest. Each row
  //    gets its id here and the run lists a chunk's ids BEFORE the chunk is inserted, so a worker stopped in the middle
  //    (the platform's time limit) never leaves a record Undo doesn't know about (an id that never got in is simply
  //    not there to delete). After the chunk the list is set to what really went in.
  const fresh = plan.rows.filter((r) => r.status === "new");
  const ctx: ImportCtx = { ...plan.ctx, quiet: rule.run_automations !== true, nowMs };
  const ids: string[] = [], rowErrors: { i: number; reason: string }[] = plan.rows.filter((r) => r.status === "error").map((r) => ({ i: r.i, reason: clip(r.reason, 200) }));
  //    An hourly run reads its rule again before each chunk and stops once it is off (Undo switches it off while this
  //    run fetched; the rows that undo removes must not come straight back). Can't read it: stops too.
  let stopped = false;
  for (let k = 0; k < fresh.length; k += IMPORT_CHUNK) {
    if (opts.source === "hourly") {
      const { data: on, error: oe } = await sb.from("mcp_import_rules").select("enabled").eq("id", rule.id).eq("business_id", BUSINESS_ID).maybeSingle();
      if (oe || !on || on.enabled !== true) { stopped = true; break; }
    }
    const part = fresh.slice(k, k + IMPORT_CHUNK), built = part.map((r) => ({ id: crypto.randomUUID(), ...importRow(kind, r.values, ctx) }));
    const ahead = [...ids, ...built.map((r) => r.id)];
    await must(sb.from("mcp_import_runs").update({ inserted_ids: ahead, inserted: ahead.length }).eq("id", run.id));
    const { data, error } = await sb.from(IMPORT_TABLE[kind]).insert(built, { defaultToNull: false }).select("id");
    // deno-lint-ignore no-explicit-any
    if (!error) ids.push(...(data || []).map((d: any) => String(d.id)));
    else {
      for (let j = 0; j < built.length; j++) {
        const one = await sb.from(IMPORT_TABLE[kind]).insert(built[j], { defaultToNull: false }).select("id");
        if (one.error || !one.data || !one.data[0]) rowErrors.push({ i: part[j].i, reason: clip(one.error ? one.error.message : "not saved", 200) });
        else ids.push(String(one.data[0].id));
      }
    }
    // After each chunk: exactly what is in so far.
    await must(sb.from("mcp_import_runs").update({ inserted_ids: ids, inserted: ids.length }).eq("id", run.id));
  }
  // 5. The records' history (as the app writes it); a failure here never fails the import.
  const text = clip(`Added by the import "${rule.name}" from ${plan.ctx.serverName}`, 300);
  for (let k = 0; k < ids.length; k += IMPORT_CHUNK) {
    const logRows = ids.slice(k, k + IMPORT_CHUNK).map((id) => ({ record_kind: IMPORT_RECORD_KIND[kind], record_id: id, actor: IMPORT_ACTOR, text, manual: false, at: iso(nowMs) }));
    try {
      const { error } = await sb.from("activity_log").insert(logRows);
      if (error) console.error("mcp import history failed:", clip(error.message, 200));
    } catch (e) { console.error("mcp import history failed:", clip((e as Error)?.message, 200)); }
  }
  // 6. The result.
  const errors: { i?: number; reason: string }[] = [...rowErrors];
  if (stopped) errors.push({ reason: "The rule was switched off, so the rest was not imported" });
  if (plan.truncated) errors.push({ reason: `Only the first ${IMPORT_MAX_ROWS} items were read` });
  return await finish({
    status: runStatus(ids.length, rowErrors.length + (stopped ? 1 : 0)), fetched: plan.fetched, inserted: ids.length, inserted_ids: ids,
    duplicates: plan.rows.filter((r) => r.status === "duplicate").length, errors: errors.slice(0, RUN_ERRORS_MAX),
  });
}
// The imported records Undo keeps because the team has used them since: a history entry by anyone but the import,
// something that points at them (a contact's texts / chat / opt-out / calls / jobs / tasks, or an automation's message
// to the customer (automation_log); a closing, lead or review request of a job), or work on the row itself (a contact called (contacted_at), noted (customer_notes), its thread grown, stage
// moved or job linked; a task's updates or subtasks). Deleting those would take the team's work with them (a contact's
// texts even go with it: on delete cascade). Every read is paged (.range, PAGE rows) until a short page, so a lead with
// thousands of texts never hides the next one behind the server's 1,000-row cap: an id seen once is decided and left
// out of the next page's filter, so each full page settles at least one more id. A check that can't be read keeps
// the whole chunk.
// deno-lint-ignore no-explicit-any
export async function usedSince(sb: any, kind: string, ids: string[]): Promise<Set<string>> {
  const used = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const read = async (table: string, cols: string, col: string, f: (q: any) => any, each: (r: any) => boolean) => {
    let open = ids.slice();
    while (open.length) {
      const { data, error } = await f(sb.from(table).select(cols).in(col, open)).range(0, PAGE - 1);
      if (error) { console.error("mcp undo check failed:", table, clip(error.message, 200)); ids.forEach((id) => used.add(id)); return; }
      const rows = data || [], seen = new Set<string>();
      // deno-lint-ignore no-explicit-any
      rows.forEach((r: any) => { const id = String(r[col]); seen.add(id); if (each(r)) used.add(id); });
      if (rows.length < PAGE) return;
      const left = open.filter((id) => !seen.has(id));
      // a full page that settled nothing new can't happen (every row's id is still open); never loop on it
      if (left.length === open.length) { ids.forEach((id) => used.add(id)); return; }
      open = left;
    }
  };
  // deno-lint-ignore no-explicit-any
  const points = (table: string, col: string) => read(table, col, col, (q: any) => q, () => true);
  // deno-lint-ignore no-explicit-any
  await read("activity_log", "record_id", "record_id", (q: any) => q.eq("record_kind", IMPORT_RECORD_KIND[kind]).neq("actor", IMPORT_ACTOR), () => true);
  if (kind === "contacts") {
    for (const t of ["lead_messages", "chat_sessions", "customer_opt_outs", "calls", "jobs", "tasks"]) await points(t, "contact_id");
    // an automation already texted / emailed the customer (or is sending it now): a message out can't be taken back, so
    // the lead stays. The engine's own "a message to the customer" (automation_claim_customer, automations' claim):
    // sending / sent / queued. A skipped, failed or waiting_phone step sent nothing (waiting_phone is final: no texts
    // without Twilio), and a push or task to the team is not the customer.
    // deno-lint-ignore no-explicit-any
    await read("automation_log", "contact_id", "contact_id", (q: any) => q.eq("audience", "customer").in("status", ["sending", "sent", "queued"]), () => true);
    // deno-lint-ignore no-explicit-any
    await read("contacts", "id, messages, stage_changed_at, linked_job_id, contacted_at, customer_notes", "id", (q: any) => q, (r: any) =>
      (Array.isArray(r.messages) && r.messages.length > 1) || !!r.stage_changed_at || !!r.linked_job_id || !!r.contacted_at || (Array.isArray(r.customer_notes) && r.customer_notes.length > 0));
  } else if (kind === "jobs") {
    await points("closings", "linked_job_id");
    await points("contacts", "linked_job_id");
    // a review request queued or sent for the job (review-requests): deleting the job would not stop a waiting text
    await points("review_requests", "job_id");
  } else if (kind === "tasks") {
    // deno-lint-ignore no-explicit-any
    await read("tasks", "id, updates, subtasks", "id", (q: any) => q, (r: any) => (Array.isArray(r.updates) && r.updates.length > 0) || (Array.isArray(r.subtasks) && r.subtasks.length > 0));
  }
  return used;
}
// Undo: deletes exactly the ids its own run recorded, and only those still there and not used since (usedSince). A row
// that is used, or can't go, is kept and counted. Only the import's own history entries of the deleted rows go. An
// hourly rule is switched off first, or the next hour would import it all again.
// The undo is claimed with undo_started_at (one undo at a time) and marked done (undone_at) only at the END, after
// every chunk: an undo stopped in the middle (the platform's time limit) is not "Undone" with records still there.
// Pressing Undo again once it is stale (UNDO_STALE_MS) resumes it: the rows already deleted are simply not there any
// more, and its deleted count carries on from what the stopped undo saved after each chunk.
export const UNDO_STALE_MS = RUN_STALE_MS;
// deno-lint-ignore no-explicit-any
export async function undoImport(sb: any, runId: unknown, me: any, nowMs: number): Promise<{ status: number; body: any }> {
  if (!isUuid(runId)) return { status: 404, body: { ok: false, reason: "No such import." } };
  const { data: run, error } = await sb.from("mcp_import_runs").select("*").eq("id", runId).eq("business_id", BUSINESS_ID).maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) return { status: 404, body: { ok: false, reason: "No such import." } };
  if (run.status === "running") {
    if (Date.parse(run.started_at) >= nowMs - RUN_STALE_MS) return { status: 409, body: { ok: false, reason: "This import is still running." } };
    // Stopped by a crash long ago: closed now, then undone like any other.
    await sb.from("mcp_import_runs").update({ status: "failed", finished_at: iso(nowMs), errors: [...(Array.isArray(run.errors) ? run.errors : []), { reason: "Stopped before it finished" }].slice(0, RUN_ERRORS_MAX) }).eq("id", run.id).eq("status", "running");
  }
  if (run.undone_at) return { status: 409, body: { ok: false, reason: "Already undone." } };
  const { data: claimed, error: ce } = await sb.from("mcp_import_runs").update({ undo_started_at: iso(nowMs), undone_by: me.id }).eq("id", run.id).is("undone_at", null)
    .or(`undo_started_at.is.null,undo_started_at.lt."${iso(nowMs - UNDO_STALE_MS)}"`).select("id");
  if (ce) throw new Error(ce.message);
  if (!claimed || !claimed.length) {
    const { data: now } = await sb.from("mcp_import_runs").select("undone_at").eq("id", run.id).maybeSingle();
    return { status: 409, body: { ok: false, reason: now && now.undone_at ? "Already undone." : "This import is being undone right now." } };
  }
  // The hourly rule off before anything is deleted, so its next run can't bring rows back while this one works.
  let paused = false;
  if (run.rule_id) {
    const { data: rule } = await sb.from("mcp_import_rules").select("id, mode, enabled").eq("id", run.rule_id).eq("business_id", BUSINESS_ID).maybeSingle();
    if (rule && rule.mode === "hourly") {
      if (rule.enabled) await sb.from("mcp_import_rules").update({ enabled: false, updated_at: iso(nowMs) }).eq("id", rule.id).eq("business_id", BUSINESS_ID);
      paused = true;
    }
    // Another import of the same rule still running (claimed before the pause) would find the rows this undo deletes
    // missing and add them again: nothing is deleted until it finishes. The undo claim is handed back as it was, so
    // pressing Undo again later works (and a resumed undo still carries its count on).
    const { data: busy, error: be } = await sb.from("mcp_import_runs").select("id").eq("rule_id", run.rule_id).eq("status", "running").neq("id", run.id)
      .gte("started_at", iso(nowMs - RUN_STALE_MS)).limit(1);
    if (be || (busy && busy.length)) {
      await sb.from("mcp_import_runs").update({ undo_started_at: run.undo_started_at ?? null, undone_by: run.undone_by ?? null }).eq("id", run.id).is("undone_at", null);
      return { status: 409, body: { ok: false, reason: "An import of this rule is running; undo it when it finishes." } };
    }
  }
  const table = IMPORT_TABLE[run.kind], ids: string[] = (Array.isArray(run.inserted_ids) ? run.inserted_ids : []).map(String);
  // A resumed undo goes on from the deleted count the stopped one saved (kept is counted again: those rows are all
  // still there).
  let deleted = run.undo_started_at ? Number(run.undo_deleted) || 0 : 0, kept = 0;
  for (let k = 0; k < ids.length; k += IMPORT_CHUNK) {
    const all = ids.slice(k, k + IMPORT_CHUNK), gone: string[] = [];
    const used = await usedSince(sb, run.kind, all);
    const { data: still } = await sb.from(table).select("id").in("id", all);
    // deno-lint-ignore no-explicit-any
    const there = new Set(still ? still.map((d: any) => String(d.id)) : all);   // unreadable: counted as there
    kept += all.filter((id) => used.has(id) && there.has(id)).length;
    const chunk = all.filter((id) => !used.has(id));
    if (!chunk.length) continue;
    const { data, error: de } = await sb.from(table).delete().in("id", chunk).select("id");
    // deno-lint-ignore no-explicit-any
    if (!de) gone.push(...(data || []).map((d: any) => String(d.id)));
    else {
      for (const id of chunk) {
        const one = await sb.from(table).delete().eq("id", id).select("id");
        if (one.error) kept++;
        else if (one.data && one.data.length) gone.push(id);   // an id the office already deleted is neither
      }
    }
    deleted += gone.length;
    if (gone.length) {
      const { error: le } = await sb.from("activity_log").delete().eq("record_kind", IMPORT_RECORD_KIND[run.kind]).eq("actor", IMPORT_ACTOR).in("record_id", gone);
      if (le) console.error("mcp undo history failed:", clip(le.message, 200));
      // Progress after each chunk (a resumed undo carries the count on), still not marked undone.
      await sb.from("mcp_import_runs").update({ undo_deleted: deleted }).eq("id", run.id);
    }
  }
  // Done: only now is the run marked undone.
  const { error: fe } = await sb.from("mcp_import_runs").update({ undone_at: iso(nowMs), undone_by: me.id, undo_deleted: deleted, undo_kept: kept }).eq("id", run.id);
  if (fe) throw new Error(fe.message);
  return { status: 200, body: { ok: true, deleted, kept, paused } };
}
// The hourly timer: the rules that are ON and hourly, least recently run first, each claimed (so two timers never run
// the same rule twice in an hour), within CRON_BUDGET_MS. The claim itself checks the rule is still on: a rule Undo
// switched off after the list was read never runs again and brings back the rows the undo just removed.
// (The access log is pruned by M1's 'mcp-log-prune'.)
// deno-lint-ignore no-explicit-any
export async function cronImports(sb: any, nowMs: number) {
  const started = io.now();
  const { data, error } = await sb.from("mcp_import_rules").select("*").eq("business_id", BUSINESS_ID).eq("enabled", true).eq("mode", "hourly")
    .order("last_run_at", { ascending: true, nullsFirst: true }).limit(CRON_MAX_RULES);
  if (error) throw new Error(error.message);
  // deno-lint-ignore no-explicit-any
  const rules: any[] = data || [], out = { rules: rules.length, ran: 0, skipped: 0, failed: 0, deferred: 0 };
  for (let k = 0; k < rules.length; k++) {
    const r = rules[k];
    if (io.now() - started > CRON_BUDGET_MS) { out.deferred = rules.length - k; break; }
    const { data: claimed } = await sb.from("mcp_import_rules").update({ last_run_at: iso(nowMs) }).eq("id", r.id).eq("enabled", true)
      .or(`last_run_at.is.null,last_run_at.lt."${iso(nowMs - HOURLY_GAP_MS)}"`).select("id");
    if (!claimed || !claimed.length) { out.skipped++; continue; }
    const { data: server } = await sb.from("mcp_servers").select(SERVER_COLS).eq("id", r.server_id).eq("business_id", BUSINESS_ID).maybeSingle();
    if (!server) { out.skipped++; continue; }
    try {
      const res = await runImport(sb, r, server, { source: "hourly", by: null, nowMs: io.now() });
      if (res.busy) out.skipped++; else out.ran++;
    } catch (e) {
      out.failed++;
      console.error("mcp hourly import failed:", clip((e as Error)?.message, 200));
    }
  }
  return out;
}
// POST /mcp/cron: the secret, then 202 at once (pg_net gives up after 10 s); the imports run in the background.
// deno-lint-ignore no-explicit-any
export function handleCron(sb: any, secretHeader: string, envSecret: string): { status: number; body: any } {
  if (!sameSecret(secretHeader || "", envSecret)) return { status: 401, body: { ok: false, reason: "unauthorized" } };
  // deno-lint-ignore no-explicit-any
  io.waitUntil(cronImports(sb, io.now()).catch((e: any) => console.error("mcp cron failed:", clip(String(e?.message || e), 300))));
  return { status: 202, body: { ok: true } };
}

// ── imports: the owner's steps ──
export const IMPORT_ACTIONS = ["save_rule", "delete_rule", "preview_import", "commit_import", "undo_import"];
// The columns save_rule writes (plus updated_at; created_by / created_at only on insert).
const RULE_COLS = ["server_id", "kind", "name", "tool", "tool_args", "items_path", "mapping", "dedupe", "mode", "enabled", "run_automations"];
// deno-lint-ignore no-explicit-any
export async function importAction(sb: any, body: any, me: Profile | null, nowMs: number): Promise<{ status: number; body: any }> {
  if (!me) return { status: 401, body: { ok: false, reason: "Sign in again." } };
  if (me.role !== "owner") return { status: 403, body: { ok: false, reason: "Owners only." } };
  const b = plainObj(body) ? body : {};
  const missing = { status: 404, body: { ok: false, reason: "No such rule (or its server is gone)." } };
  switch (String(b.step)) {
    case "save_rule": {
      const r = plainObj(b.rule) ? b.rule : {};
      const errors = validateRule(r);
      if (errors.length) return { status: 400, body: { ok: false, reason: errors[0], errors } };
      const { data: srv, error: se } = await sb.from("mcp_servers").select("id").eq("id", r.server_id).eq("business_id", BUSINESS_ID).maybeSingle();
      if (se) throw new Error(se.message);
      if (!srv) return { status: 404, body: { ok: false, reason: "No such server." } };
      const vals: Record<string, unknown> = {
        server_id: r.server_id, kind: r.kind, name: clip(r.name, 80), tool: r.tool, tool_args: r.tool_args === undefined ? {} : r.tool_args,
        items_path: r.items_path === undefined ? "" : r.items_path, mapping: r.mapping, dedupe: { fields: r.dedupe.fields, match: r.dedupe.match },
        mode: r.mode, enabled: r.enabled === true, run_automations: r.run_automations === true,
      };
      const row: Record<string, unknown> = Object.fromEntries(RULE_COLS.map((k) => [k, vals[k]]));
      row.updated_at = iso(nowMs);
      if (r.id !== undefined && r.id !== null && r.id !== "") {
        if (!isUuid(r.id)) return { status: 404, body: { ok: false, reason: "No such rule." } };
        const { data, error } = await sb.from("mcp_import_rules").update(row).eq("id", r.id).eq("business_id", BUSINESS_ID).select("*");
        if (error) throw new Error(error.message);
        if (!data || !data.length) return { status: 404, body: { ok: false, reason: "No such rule." } };
        return { status: 200, body: { ok: true, rule: data[0] } };
      }
      const { data, error } = await sb.from("mcp_import_rules").insert({ ...row, business_id: BUSINESS_ID, created_by: me.id, created_at: iso(nowMs) }).select("*").single();
      if (error || !data) throw new Error((error && error.message) || "insert failed");
      return { status: 200, body: { ok: true, rule: data } };
    }
    case "delete_rule": {
      if (!isUuid(b.id)) return { status: 404, body: { ok: false, reason: "No such rule." } };
      // Its runs stay (rule_id is cleared, rule_name kept), so its imports can still be undone.
      const { data, error } = await sb.from("mcp_import_rules").delete().eq("id", b.id).eq("business_id", BUSINESS_ID).select("id");
      if (error) throw new Error(error.message);
      if (!data || !data.length) return { status: 404, body: { ok: false, reason: "No such rule." } };
      return { status: 200, body: { ok: true } };
    }
    case "preview_import": {
      // Works whether the rule is on or off (enabled only gates the hourly timer). Nothing is written.
      const rs = await loadRuleAndServer(sb, b.rule_id);
      if (!rs) return missing;
      const plan = await planImport(sb, rs.rule, rs.server, nowMs);
      if (!plan.ok) return { status: 400, body: { ok: false, reason: plan.reason } };
      const count = (s: string) => plan.rows.filter((r) => r.status === s).length;
      return {
        status: 200,
        body: {
          ok: true, fetched: plan.fetched, truncated: plan.truncated, counts: { new: count("new"), duplicate: count("duplicate"), error: count("error") },
          rows: plan.rows.slice(0, IMPORT_PREVIEW_ROWS).map((r) => ({ i: r.i, status: r.status, reason: r.reason, match_id: r.match_id, values: r.values })),
        },
      };
    }
    case "commit_import": {
      // Always fetched again here: the browser's preview is never trusted.
      const rs = await loadRuleAndServer(sb, b.rule_id);
      if (!rs) return missing;
      const res = await runImport(sb, rs.rule, rs.server, { source: "manual", by: me.id, nowMs });
      if (res.busy) return { status: 409, body: { ok: false, reason: "An import of this rule is already running." } };
      return { status: 200, body: { ok: true, run: res.run } };
    }
    case "undo_import": return await undoImport(sb, b.run_id, me, nowMs);
  }
  return { status: 400, body: { ok: false, reason: "unknown step" } };
}

// ── HTTP ──
const unauthorized = (id: unknown) => json(rpcError(id, -32001, "Unauthorized: this key is missing, wrong or revoked."), 401, { "WWW-Authenticate": 'Bearer realm="ops-mcp"' });
// deno-lint-ignore no-explicit-any
async function mcpHttp(req: Request, route: { pathToken?: string }, sb: any, nowMs: number): Promise<Response> {
  if (req.method !== "POST") return json(rpcError(null, -32000, "Method not allowed: send JSON-RPC with POST."), 405, { Allow: "POST" });
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !PROTOCOL_VERSIONS.includes(pv)) return json(rpcError(null, -32600, `Unsupported protocol version: ${clip(pv, 20)}`), 400);
  // deno-lint-ignore no-explicit-any
  let msg: any;
  try { msg = JSON.parse(await req.text()); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
  const id = msg && typeof msg === "object" && !Array.isArray(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
  // Every method needs a key, initialize included.
  const auth = await authToken(sb, tokenFrom(req, route), nowMs);
  if (!auth) { console.warn("mcp: refused a request without a valid key"); return unauthorized(id); }
  // Notifications and client answers need nothing loaded.
  if (msg && typeof msg === "object" && !Array.isArray(msg) && !("id" in msg)) {
    const r = await handleRpc(msg, { sb, s: scopeOf(auth.profile), biz: null as unknown as Biz, nowMs, token: auth.token });
    if (r.status === 202) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(r.body, r.status, r.headers);
  }
  const r = await handleRpc(msg, { sb, s: scopeOf(auth.profile), biz: await loadBusiness(sb), nowMs, token: auth.token });
  if (r.status === 202) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(r.body, r.status, r.headers);
}
// deno-lint-ignore no-explicit-any
export async function handleHttp(req: Request, deps: { sb: any; nowMs?: number }): Promise<Response> {
  const nowMs = deps.nowMs ?? io.now(), sb = deps.sb;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const route = routeOf(new URL(req.url).pathname);
  if (!route) return json({ ok: false, reason: "not found" }, 404);
  if (route.kind === "mcp") {
    try { return await mcpHttp(req, route, sb, nowMs); } catch (e) {
      console.error("mcp failed:", clip((e as Error).message, 300));
      return json(rpcError(null, -32603, "Internal error"), 500);
    }
  }
  if (req.method !== "POST") return json({ ok: false, reason: "Method not allowed" }, 405, { Allow: "POST" });
  // The hourly timer: its secret is all it needs (the body is not read).
  if (route.kind === "cron") {
    const r = handleCron(sb, req.headers.get("x-mcp-cron-secret") || "", env("MCP_CRON_SECRET"));
    return json(r.body, r.status);
  }
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, reason: "Could not parse request body" }, 400); }
  try {
    const r = await handleManage(sb, body, await caller(sb, req), nowMs);
    return json(r.body, r.status);
  } catch (e) {
    console.error("mcp " + route.kind + " failed:", clip((e as Error).message, 300));
    return json({ ok: false, reason: "server" }, 500);
  }
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__MCP_TEST__) {
  Deno.serve((req: Request) => handleHttp(req, { sb: createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) }));
}
