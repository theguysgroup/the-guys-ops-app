// ingest-ads-stats: receives keyword / search-term / ad / campaign / segment stats (Google Ads) and
// ad-level stats (Meta) from the cloud routine and REPLACES the stored snapshot for each
// (platform, account, win, level) in public.ads_stats. Same auth model as ingest-ad-spend / ingest-ad-calls:
// the Supabase gateway needs the publishable key, and this function checks the shared X-Intake-Secret.
// Since 9 Oct it also takes Google's conversion settings and conversions per action (conv_setting / conv_action, for
// the Tracking problems list), hands the nightly routine the real leads (realLeads), and checks the lead emails in
// info@ against the CRM (leadEmails), saved per day in lead_email_checks.
// Since 13 Oct it also issues short upload tickets (issueTicket), so the key never has to go into the outside sandbox
// where the Google Ads data is pulled: see "upload ticket" below.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INTAKE_SECRET = Deno.env.get("INTAKE_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// Supabase returns at most 1,000 rows per request whatever the limit says, so a table that can be bigger is read page
// by page (in a fixed order, so no row is skipped or read twice).
// deno-lint-ignore no-explicit-any
export async function readAll(page: (from: number, to: number) => any, size = 1000, max = 50000): Promise<{ data: any[]; error: any }> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (let from = 0; from < max; from += size) {
    const r = await page(from, from + size - 1);
    if (r.error) return { data: out, error: r.error };
    out.push(...(r.data || []));
    if ((r.data || []).length < size) break;
  }
  return { data: out, error: null };
}

// --- upload ticket (13 Oct, Ofek approved) ---
// The nightly routine pulls Google Ads data inside an outside sandbox (Composio). The shared key must never go there
// (the run's own safety check refused it on 12 Oct, and it was right), so the routine asks for a ticket here with the
// key, from its own machine, and gives the sandbox only the ticket. A ticket lasts at most 3 hours and only lets its
// holder replace ad-stat rows and the organic Search Console / GA4 rows, and read the real-lead counts (without names);
// everything else still needs the key.
const TICKET_MAX_SECONDS = 3 * 3600;
export const TICKET_ALLOWS = new Set(["rows", "realLeads", "organicRows"]);
async function ticketSig(secret: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("ads-rows:v1:" + exp));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function makeTicket(secret: string, nowSec: number, minutes: number): Promise<{ ticket: string; expires: number }> {
  const exp = nowSec + Math.max(60, Math.min(TICKET_MAX_SECONDS, Math.round((Number(minutes) || 0) * 60)));
  return { ticket: `v1.${exp}.${await ticketSig(secret, exp)}`, expires: exp };
}
export async function ticketOk(secret: string, ticket: string, nowSec: number): Promise<boolean> {
  const m = /^v1\.(\d{10})\.([0-9a-f]{64})$/.exec(String(ticket || ""));
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (exp <= nowSec || exp > nowSec + TICKET_MAX_SECONDS) return false;
  const want = await ticketSig(secret, exp);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}
// What a request asks for, in the same order the handler below checks it.
// deno-lint-ignore no-explicit-any
export function requestKind(body: any): string {
  if (!body || typeof body !== "object") return "rows";
  if (body.issueTicket) return "issueTicket";
  if (body.pendingGclids) return "pendingGclids";
  if (Array.isArray(body.clickAttribution)) return "clickAttribution";
  if (body.crmDigest) return "crmDigest";
  if (body.insight) return "insight";
  if (body.realLeads) return "realLeads";
  if (body.leadEmails) return "leadEmails";
  if (body.organic) return "organicRows";
  if (body.seoWeekly) return "organicWeekly";
  if (body.organicFindings) return "organicFindings";
  if (body.organicDigest) return "organicDigest";
  return "rows";
}
// --- end upload ticket ---

const LEVELS = new Set(["campaign", "keyword", "search_term", "ad", "hour", "dow", "device", "geo", "adset", "placement", "conv_setting", "conv_action"]);

// --- lead email check (pure) ---
// Every website form and chat also sends an email to info@. The nightly routine reads those emails and sends them
// here; each one is matched to a CRM card by phone or email, so a lead that reached the inbox but not the app shows
// up the next morning. A repeat enquiry matches the customer's existing card (intake adds it there), which is right.
const sydneyDay = (ts: string | number | Date) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const decodeHtml = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The last 9 digits of an Australian number, so 0412 345 678, +61412345678 and 61412345678 are the same person.
function phoneKey(s: unknown): string {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("61") && d.length === 11) d = "0" + d.slice(2);
  return d.length >= 9 ? d.slice(-9) : "";
}
const PHONE_RE = /(?<!\d)(?:\+?61[\s-]?|0)[2-478](?:[\s-]?\d){8}(?!\d)/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function parseLeadEmail(e: any) {
  const subject = decodeHtml(String(e?.subject || "")).trim();
  const text = decodeHtml(String(e?.body || e?.snippet || "")).replace(/\s+/g, " ").trim();
  const email = (text.match(EMAIL_RE) || []).find((x) => !/@theguyservicegroup\.com$/i.test(x)) || "";
  const phone = ((text.match(PHONE_RE) || subject.match(PHONE_RE)) || [""])[0].trim();
  const field = (k: string) => { const m = text.match(new RegExp("\\b" + k + ":\\s*([^\\s:]+)(?=\\s|$)", "i")); return m ? m[1] : ""; };
  const src = field("utm_source").toLowerCase(), medium = field("utm_medium").toLowerCase();
  let name = (text.match(/Name:\s*(.+?)\s+(?:Phone|Email|Suburb|Post ?code|Message)\b/i) || [])[1] || "";
  if (!name) { const cut = text.search(/[A-Z0-9._%+-]+@|(?<!\d)(?:\+?61|0)[2-478]\d/i); name = cut > 0 ? text.slice(0, cut) : ""; }
  name = name.trim().slice(0, 80);
  const google = src.includes("google") || /\b(?:gclid|gbraid|wbraid)\s*:\s*[A-Za-z0-9_-]{10,}/i.test(text) || /\bgad_source\s*:\s*\d/i.test(text);
  const meta = /^(?:fb|ig|facebook|instagram|meta)$/.test(src) && /paid|cpc/.test(medium);
  // The ads agency's test forms (and the business's own 1300 number) are not leads.
  const test = /@searchrescue\.com\.au$/i.test(email) || email.toLowerCase() === "heythere@gmail.com" || /^test\b/i.test(name) ||
    (!phone && /(?<!\d)1[38]00[\s-]?\d{3}[\s-]?\d{3}(?!\d)/.test(subject + " " + text));
  return { subject, name, phone, phoneKey: phoneKey(phone), email, kind: /chat/i.test(subject) ? "chat" : "form", hint: google ? "Google Ads" : meta ? "Meta Ads" : "", test };
}
// emails: [{ id, date, subject, sender?, snippet, body? }] from the routine; contacts: CRM cards, newest first; today: Sydney
// day (today's emails are left for tomorrow night, when the day is complete); from: the first day the routine read in full
// (days before it are left alone, so a partly-read day never replaces a complete one). Replies and forwards in the same
// thread, and mail not sent by the website forms (info@) or the chat (apptbot), are not lead emails. One summary per day.
function checkLeadEmails(emails: any[], contacts: any[], today: string, from = "") {
  const byPhone = new Map<string, any>(), byEmail = new Map<string, any>();
  for (const c of contacts) {
    const k = phoneKey(c.phone); if (k && !byPhone.has(k)) byPhone.set(k, c);
    const em = String(c.email || "").trim().toLowerCase(); if (em && !byEmail.has(em)) byEmail.set(em, c);
  }
  const days = new Map<string, any>(), needBody: string[] = [], seen = new Set<string>();
  for (const e of emails) {
    const id = String(e?.id || ""); if (!id || seen.has(id)) continue; seen.add(id);
    const at = new Date(e.date); if (isNaN(at.getTime())) continue;
    const day = sydneyDay(at); if (day >= today || (from && day < from)) continue;
    if (/^\s*(?:re|fwd?|aw)\s*:/i.test(String(e.subject || ""))) continue;
    if (e.sender && !/info@theguyservicegroup\.com|apptbot\.ai/i.test(String(e.sender))) continue;
    const p = parseLeadEmail(e);
    const d = days.get(day) || { day, emails: 0, matched: 0, missing: [], tests: [], mismatch: [], google_emails: 0, google_matched: 0 };
    days.set(day, d);
    const item = { id, at: at.toISOString(), subject: p.subject.slice(0, 120), name: p.name, phone: p.phone, email: p.email, kind: p.kind, hint: p.hint };
    if (p.test) { d.tests.push(item); continue; }
    d.emails++;
    if (!p.phoneKey && !p.email) {   // nothing to match on: ask for the full email; until then it counts as missing
      if (!e.body) needBody.push(id);
      d.missing.push({ ...item, unreadable: true });
      continue;
    }
    const c = (p.phoneKey && byPhone.get(p.phoneKey)) || (p.email && byEmail.get(p.email.toLowerCase())) || null;
    const isGoogle = c ? c.source === "Google Ads" : p.hint === "Google Ads";
    if (isGoogle) d.google_emails++;
    if (!c) { d.missing.push(item); continue; }
    d.matched++;
    if (isGoogle) d.google_matched++;
    // The email names the ad it came from but the card says otherwise (only for a card made that day, not an old customer).
    if (p.hint && c.source !== p.hint && String(c.created_at || "").slice(0, 10) >= day) d.mismatch.push({ ...item, contact_id: c.id, app_source: c.source || "" });
  }
  return { days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), need_body: needBody };
}
// --- end lead email check ---

// --- organic (13 Oct, Ofek approved plan E) ---
// The Organic page: Google search (Search Console), the website's visits (GA4) and the weekly map / AI check, kept in
// public.organic_stats; and the improvement suggestions the nightly run writes from them, by fixed rules and only with
// numbers that prove them (public.seo_suggestions; the SEO chat adds its own and marks what it did).
export const ORGANIC_LEVELS: Record<string, string[]> = {
  gsc: ["total", "page", "query", "page_query", "date"],
  ga4: ["channel", "landing", "ai_source"],
  serp: ["localpack", "aimode", "reviews"],
};
const ORGANIC_WINS = new Set(["7d", "prev7d", "28d", "prev28d", "90d"]);
// The three ad landing pages (posts 5296, 5275 and 6424) get paid traffic only: never part of organic.
export const PPC_PATHS = new Set(["/aircon-split-system-cleaning-service/", "/aircon-duct-system-cleaning-service/", "/aircon-cleaning-service/"]);
// The aircon Google Business Profile links to this page, so Search Console gives it the map pack's positions too.
export const GBP_LINKED_PATH = "/services/air-conditioning-cleaning/";
export function urlPath(u: unknown): string {
  try { const p = new URL(String(u || ""), "https://theguyservicegroup.com").pathname; return p.endsWith("/") ? p : p + "/"; } catch { return ""; }
}
export const isPpcUrl = (u: unknown) => PPC_PATHS.has(urlPath(u));
type OrgRow = { source: string; win: string; level: string; item: string; item2: string; clicks: number; impressions: number; position: number | null; extra: Record<string, unknown> };
// One upload: { source, win, level, rows: [{ item, item2, clicks, impressions, position, extra }] }. Search Console and GA4
// use the windows 7d, prev7d, 28d, prev28d (and 90d for the day-by-day trend); the weekly check uses the Monday's date,
// so every week is kept. The ad landing pages are dropped here, whatever the routine sends.
// deno-lint-ignore no-explicit-any
export function organicBatch(o: any): { ok: true; source: string; win: string; level: string; rows: OrgRow[] } | { ok: false; error: string } {
  const source = String(o?.source || ""), win = String(o?.win || ""), level = String(o?.level || "");
  if (!ORGANIC_LEVELS[source]) return { ok: false, error: "invalid source" };
  if (!ORGANIC_LEVELS[source].includes(level)) return { ok: false, error: "invalid level" };
  if (source === "serp" ? !/^\d{4}-\d{2}-\d{2}$/.test(win) : !ORGANIC_WINS.has(win)) return { ok: false, error: "invalid win" };
  if (!Array.isArray(o?.rows)) return { ok: false, error: "invalid rows: expected an array" };
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const seen = new Set<string>(), rows: OrgRow[] = [];
  for (const r of o.rows.slice(0, 6000)) {
    const item = String(r?.item ?? "").slice(0, 500), item2 = String(r?.item2 ?? "").slice(0, 200);
    if (((source === "gsc" && (level === "page" || level === "page_query")) || (source === "ga4" && level === "landing")) && isPpcUrl(item)) continue;
    const k = item + "\u0001" + item2;
    if (seen.has(k)) continue;
    seen.add(k);
    const pos = r?.position === null || r?.position === undefined || r?.position === "" ? null : Number(r.position);
    rows.push({ source, win, level, item, item2, clicks: num(r?.clicks), impressions: num(r?.impressions), position: pos !== null && Number.isFinite(pos) ? Math.round(pos * 100) / 100 : null,
      extra: r?.extra && typeof r.extra === "object" && !Array.isArray(r.extra) ? r.extra : {} });
  }
  return { ok: true, source, win, level, rows };
}
// The weekly map and AI check (seo-weekly-check, Mondays) as upload batches, one per level, under that Monday's date.
// deno-lint-ignore no-explicit-any
export function weeklyBatches(w: any): { ok: true; week: string; batches: { source: string; win: string; level: string; rows: unknown[] }[] } | { ok: false; error: string } {
  const week = String(w?.week || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return { ok: false, error: "invalid week" };
  const arr = (x: unknown) => Array.isArray(x) ? x : [];
  const s = (x: unknown, n = 120) => String(x ?? "").trim().slice(0, n);
  const n = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x))) ? null : Number(x);
  // deno-lint-ignore no-explicit-any
  const localpack = arr(w.localpack).filter((x: any) => s(x?.query) && s(x?.region)).map((x: any) => ({ item: s(x.query), item2: s(x.region), position: n(x.position),
    // deno-lint-ignore no-explicit-any
    extra: { organic: n(x.organic), aiOverview: !!x.aiOverview, aiCites: !!x.aiOverviewCitesUs, top: arr(x.top).slice(0, 5).map((t: any) => ({ name: s(t?.name, 80), rating: n(t?.rating), reviews: n(t?.reviews) })) } }));
  // deno-lint-ignore no-explicit-any
  const aimode = arr(w.aimode).filter((x: any) => s(x?.query) && Number(x?.runs) > 0).map((x: any) => ({ item: s(x.query), clicks: Math.max(0, Math.round(Number(x.mentioned) || 0)), impressions: Math.round(Number(x.runs)),
    extra: { named: arr(x.named).slice(0, 12).map((t: unknown) => s(t, 80)).filter(Boolean) } }));
  const rv = w.reviews && typeof w.reviews === "object" ? w.reviews : null;
  // deno-lint-ignore no-explicit-any
  const reviews = !rv ? [] : [...(rv.ours ? [{ ...rv.ours, us: true }] : []), ...arr(rv.competitors)].filter((x: any) => s(x?.name)).map((x: any) => ({ item: s(x.name, 80), item2: x.us ? "us" : "competitor",
    clicks: Math.max(0, Math.round(Number(x.count) || 0)), position: n(x.rating), extra: x.us ? { thisWeek: n(x.thisWeek), newestDays: n(x.newestDays), ductedMentions: n(x.ductedMentions) } : {} }));
  const batches = [{ level: "localpack", rows: localpack }, { level: "aimode", rows: aimode }, { level: "reviews", rows: reviews }].filter((b) => b.rows.length).map((b) => ({ source: "serp", win: week, ...b }));
  if (!batches.length) return { ok: false, error: "nothing in the weekly data" };
  return { ok: true, week, batches };
}
// The usual click rate for an average position in Google's results (organic, phone and computer together). Used only to
// spot a page whose click rate is far below normal for where it sits: 0.8% at position 14 is normal, 0.2% at position 1 is not.
export function expectedCtr(pos: number): number {
  const t: [number, number][] = [[1.5, 0.25], [2.5, 0.14], [3.5, 0.1], [4.5, 0.07], [5.5, 0.055], [6.5, 0.045], [7.5, 0.035], [8.5, 0.03], [10.5, 0.025], [15.5, 0.012], [20.5, 0.008]];
  for (const [p, c] of t) if (pos <= p) return c;
  return 0.004;
}
// Searches for the business by name convert anyway; the rules look at the other searches.
export const BRAND_RE = /\bguys?\s*(service|group)\b|\bthe guys\b|ac cleaning guys|chimney guys|pressure washing guys/i;
export type Finding = { dedupe_key: string; surface: string; page_url: string | null; query: string | null; issue_type: string; title: string; evidence: Record<string, unknown>; proposed_action: string; expected_impact: string | null; priority: string };
// The nightly suggestions. Each rule needs its own data from tonight; a rule whose data is missing is not run (and its open
// suggestions are left alone, not marked as solved).
export function organicFindings(rows: OrgRow[]): { findings: Finding[]; evaluated: string[] } {
  const get = (src: string, win: string, lvl: string) => rows.filter((r) => r.source === src && r.win === win && r.level === lvl);
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const out: Finding[] = [], evaluated: string[] = [];
  const pq = get("gsc", "28d", "page_query").filter((r) => !BRAND_RE.test(r.item2) && r.position !== null);
  if (get("gsc", "28d", "total").length || pq.length) {
    evaluated.push("ctr", "near");
    const ctr: Finding[] = [], near: Finding[] = [];
    for (const r of pq) {
      const path = urlPath(r.item), pos = r.position as number, exp = expectedCtr(pos), rate = r.impressions ? r.clicks / r.impressions : 0;
      const gbp = path === GBP_LINKED_PATH;
      if (r.impressions >= 150 && pos <= 10 && rate < exp * 0.4) {
        const more = Math.round(r.impressions * exp - r.clicks);
        ctr.push({ dedupe_key: `ctr|${path}|${r.item2.toLowerCase()}`, surface: "search", page_url: path, query: r.item2, issue_type: "ctr", priority: r.impressions >= 500 ? "P1" : "P2",
          title: `Few clicks for "${r.item2}" at position ${Math.round(pos * 10) / 10}`,
          evidence: { window: "28 days", impressions: r.impressions, clicks: r.clicks, ctr_pct: pct(rate), position: pos, usual_ctr_pct: pct(exp), ...(gbp ? { note: "This page is the aircon Google Business Profile's website link, so its position includes the map pack." } : {}) },
          proposed_action: `Search "${r.item2}" on a phone in Sydney first. If a map pack or an AI answer sits above our blue link, the fix is the Google Business Profile, not the page. If our blue link shows and people skip it, rewrite ${path}'s title and description to answer this search directly.`,
          expected_impact: more > 0 ? `About ${more} more clicks a month at the usual click rate for this position.` : null });
      } else if (pos > 7.5 && pos <= 20 && r.impressions >= 100 && !gbp) {
        const more = Math.round(r.impressions * expectedCtr(5) - r.clicks);
        near.push({ dedupe_key: `near|${path}|${r.item2.toLowerCase()}`, surface: "search", page_url: path, query: r.item2, issue_type: "near", priority: r.impressions >= 400 ? "P1" : "P2",
          title: `"${r.item2}" is close to page 1 (position ${Math.round(pos * 10) / 10})`,
          evidence: { window: "28 days", impressions: r.impressions, clicks: r.clicks, position: pos },
          proposed_action: `Strengthen ${path} for this search: a section that answers "${r.item2}" under a heading with those words, the words in the page title, and links to the page from related pages and posts.`,
          expected_impact: more > 0 ? `Reaching position 5 would bring about ${more} more clicks a month.` : null });
      }
    }
    // deno-lint-ignore no-explicit-any
    const gain = (f: Finding) => Number((f.evidence as any).impressions) || 0;
    out.push(...ctr.sort((a, b) => gain(b) - gain(a)).slice(0, 12), ...near.sort((a, b) => gain(b) - gain(a)).slice(0, 12));
  }
  const now = get("gsc", "28d", "page"), prev = get("gsc", "prev28d", "page");
  if (now.length && prev.length) {
    evaluated.push("drop");
    const byPath = new Map(now.map((r) => [urlPath(r.item), r]));
    for (const p of prev) {
      if (p.clicks < 20) continue;
      const path = urlPath(p.item), c = byPath.get(path) || { clicks: 0, impressions: 0, position: null } as unknown as OrgRow;
      if (c.clicks > p.clicks * 0.7) continue;
      const posWorse = c.position !== null && p.position !== null && (c.position as number) - (p.position as number) >= 2;
      const demand = !posWorse && c.impressions <= p.impressions * 0.7;
      const why = posWorse ? `its average position fell from ${p.position} to ${c.position}` : demand ? `it was shown ${Math.round((1 - c.impressions / Math.max(1, p.impressions)) * 100)}% less (fewer searches, or lost for some searches)` : "it was shown about as often but clicked less";
      out.push({ dedupe_key: `drop|${path}`, surface: "search", page_url: path, query: null, issue_type: "drop", priority: "P1",
        title: `${path} got ${Math.round((1 - c.clicks / p.clicks) * 100)}% fewer clicks than the 4 weeks before`,
        evidence: { window: "28 days vs the 28 before", clicks: c.clicks, prev_clicks: p.clicks, impressions: c.impressions, prev_impressions: p.impressions, position: c.position, prev_position: p.position, why },
        proposed_action: posWorse ? `Find which searches it lost (Search Console, this page, compare the two periods) and check whether a competitor page or a change on ours explains it.` : demand ? `Check whether it is the season (fewer people searching) before changing anything; if the searches are still there, see which ones it no longer shows for.` : `Look at the live search: a new map pack, AI answer or ads above us can take the clicks. If our result looks the same, refresh the title and description.`,
        expected_impact: `Back to the earlier level is about ${Math.round(p.clicks - c.clicks)} clicks a month.` });
    }
  }
  const weeks = [...new Set(rows.filter((r) => r.source === "serp").map((r) => r.win))].sort();
  const wk = weeks[weeks.length - 1], pwk = weeks[weeks.length - 2];
  if (wk) {
    const lp = rows.filter((r) => r.source === "serp" && r.win === wk && r.level === "localpack");
    const plp = pwk ? new Map(rows.filter((r) => r.source === "serp" && r.win === pwk && r.level === "localpack").map((r) => [r.item + "|" + r.item2, r])) : new Map();
    if (lp.length) {
      evaluated.push("map");
      for (const r of lp) {
        const before = plp.get(r.item + "|" + r.item2) as OrgRow | undefined, was = before ? before.position : undefined;
        const out_ = r.position === null, low = !out_ && (r.position as number) > 3, fell = !out_ && was !== undefined && was !== null && (r.position as number) - was >= 2;
        if (!out_ && !low && !fell) continue;
        out.push({ dedupe_key: `map|${r.item.toLowerCase()}|${r.item2.toLowerCase()}`, surface: "local", page_url: null, query: r.item, issue_type: "map", priority: out_ || fell ? "P1" : "P2",
          title: out_ ? `Not in the map pack for "${r.item}" in ${r.item2}` : `#${r.position} in the map pack for "${r.item}" in ${r.item2}${fell ? ` (was #${was})` : ""}`,
          evidence: { week: wk, position: r.position, previous_week: was ?? null, top: (r.extra as Record<string, unknown>).top || [] },
          proposed_action: `On the Google Business Profile: ask recent customers from around ${r.item2} for reviews that mention the service, add a post and photos about it, and check the service is listed.`,
          expected_impact: null });
      }
    }
    const us = rows.find((r) => r.source === "serp" && r.win === wk && r.level === "reviews" && r.item2 === "us");
    if (us) {
      evaluated.push("reviews");
      const days = Number((us.extra as Record<string, unknown>).newestDays);
      if (Number.isFinite(days) && days >= 14) out.push({ dedupe_key: "reviews|stale", surface: "local", page_url: null, query: null, issue_type: "reviews", priority: days >= 21 ? "P0" : "P1",
        title: `No new Google review for ${days} days`,
        evidence: { week: wk, newest_review_days: days, reviews: us.clicks, rating: us.position, competitors: rows.filter((r) => r.source === "serp" && r.win === wk && r.level === "reviews" && r.item2 === "competitor").map((r) => ({ name: r.item, reviews: r.clicks })) },
        proposed_action: "Ask this week's happy customers for a review: Jobs → Ask for review, or switch on automatic requests in Settings → Google reviews.",
        expected_impact: "After about 3 weeks without a new review, the map position usually starts to slip." });
    }
    const ai = rows.filter((r) => r.source === "serp" && r.win === wk && r.level === "aimode");
    if (ai.length) {
      evaluated.push("ai");
      for (const r of ai) if (r.impressions >= 2 && r.clicks === 0) out.push({ dedupe_key: `ai|${r.item.toLowerCase()}`, surface: "ai", page_url: null, query: r.item, issue_type: "ai", priority: "P2",
        title: `Google's AI Mode doesn't name us for "${r.item}"`,
        evidence: { week: wk, runs: r.impressions, mentioned: r.clicks, named_instead: (r.extra as Record<string, unknown>).named || [] },
        proposed_action: `Give AI answers something to quote: on the page for this service, a short section that answers "${r.item}" plainly (price from, areas, what is included, how long it takes), and the same business details on the directories those competitors appear on.`,
        expected_impact: null });
    }
  }
  return { findings: out, evaluated };
}
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
// What tonight's findings change in the list: a new one is added; an open one (or one being worked on) gets tonight's
// numbers; one marked done or not relevant is left as it is; one that solved itself earlier and is back is opened again;
// an open one the numbers no longer show (for a rule that ran tonight) is marked solved by itself.
// deno-lint-ignore no-explicit-any
export function syncSuggestions(findings: Finding[], existing: any[], evaluated: string[], nowIso: string) {
  const byKey = new Map(existing.filter((e) => e.source === "nightly" && e.dedupe_key).map((e) => [e.dedupe_key, e]));
  // The same issue already written by the SEO chat (or the owner) is theirs: the nightly run neither copies nor changes it.
  const others = new Set(existing.filter((e) => e.source !== "nightly" && e.dedupe_key).map((e) => e.dedupe_key));
  // deno-lint-ignore no-explicit-any
  const inserts: any[] = [], updates: any[] = [], resolves: any[] = [], seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.dedupe_key)) continue;
    seen.add(f.dedupe_key);
    const priority = PRIORITIES.has(f.priority) ? f.priority : "P2";
    const fields = { title: f.title, evidence: f.evidence, proposed_action: f.proposed_action, expected_impact: f.expected_impact, priority, updated_at: nowIso };
    if (others.has(f.dedupe_key)) continue;
    const e = byKey.get(f.dedupe_key);
    if (!e) inserts.push({ source: "nightly", dedupe_key: f.dedupe_key, surface: f.surface, page_url: f.page_url, query: f.query, issue_type: f.issue_type, status: "open", created_at: nowIso, ...fields });
    else if (e.status === "open" || e.status === "in_progress") updates.push({ id: e.id, ...fields });
    else if (e.status === "resolved") updates.push({ id: e.id, ...fields, status: "open", done_at: null, note: null });
  }
  const ran = new Set(evaluated);
  for (const e of byKey.values()) if ((e.status === "open" || e.status === "in_progress") && !seen.has(e.dedupe_key) && ran.has(e.issue_type)) resolves.push({ id: e.id, status: "resolved", done_at: nowIso, updated_at: nowIso, note: `The numbers no longer show this (checked ${nowIso.slice(0, 10)}).` });
  return { inserts, updates, resolves };
}
// Leads saved as "Organic web" before click ids were stored (10 Sep) include Google ad leads, so a window that starts
// earlier is not reliable for them. iPhone ad clicks (wbraid) are still not stored, so a few ad leads can still land there.
export const ORGANIC_CLEAN_FROM = "2026-09-10";
const dayAdd = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export function crmWindows(end: string) {
  return { "7d": [dayAdd(end, -6), end], prev7d: [dayAdd(end, -13), dayAdd(end, -7)], "28d": [dayAdd(end, -27), end], prev28d: [dayAdd(end, -55), dayAdd(end, -28)] } as Record<string, [string, string]>;
}
// What the nightly organic assessment is written from: numbers only, already worked out, one fact per line.
// leads: CRM cards whose source is Organic (web) or Google Maps: { id, day, source, sub_source, division }; rev: jobs and
// revenue (before GST) per card; open: the open suggestions; last: the previous organic assessment.
// deno-lint-ignore no-explicit-any
export function organicDigest(rows: OrgRow[], leads: any[], rev: Record<string, { jobs: number; revenue: number }>, open: any[], last: any, end: string): string[] {
  const L: string[] = [];
  const get = (src: string, win: string, lvl: string) => rows.filter((r) => r.source === src && r.win === win && r.level === lvl);
  const sum = (a: OrgRow[], k: "clicks" | "impressions") => a.reduce((t, r) => t + r[k], 0);
  const f1 = (x: number) => Math.round(x * 10) / 10;
  const tot = (w: string) => { const t = get("gsc", w, "total")[0]; return t ? `clicks ${t.clicks}, shown ${t.impressions} times, click rate ${t.impressions ? f1(t.clicks / t.impressions * 100) : 0}%, average position ${t.position ?? "-"}` : "no data"; };
  const gscDates = (w: string) => { const t = get("gsc", w, "total")[0]; const x = (t?.extra || {}) as Record<string, unknown>; return x.start ? ` (${x.start}..${x.end})` : ""; };
  L.push(`GOOGLE SEARCH (Search Console, searches from Australia, organic; Search Console runs about 3 days behind):`);
  for (const [w, p] of [["7d", "prev7d"], ["28d", "prev28d"]]) L.push(`  last ${w === "7d" ? "7" : "28"} days${gscDates(w)}: ${tot(w)} | the ${w === "7d" ? "7" : "28"} days before${gscDates(p)}: ${tot(p)}`);
  const pages = get("gsc", "28d", "page").sort((a, b) => b.clicks - a.clicks).slice(0, 8);
  const prevPages = new Map(get("gsc", "prev28d", "page").map((r) => [urlPath(r.item), r]));
  if (pages.length) {
    L.push(`TOP PAGES, last 28 days (clicks, then the 28 days before; position):`);
    for (const r of pages) { const p = prevPages.get(urlPath(r.item)); L.push(`  ${urlPath(r.item)}: ${r.clicks} clicks (before ${p ? p.clicks : 0}), shown ${r.impressions}, position ${r.position ?? "-"}${p && p.position !== null ? ` (before ${p.position})` : ""}${urlPath(r.item) === GBP_LINKED_PATH ? " [the aircon map profile links here, so its position includes the map pack]" : ""}`); }
  }
  const ch = (w: string) => { const a = get("ga4", w, "channel"); const by = (n: string) => a.find((r) => r.item === n); const os = by("Organic Search"), ai = by("AI Assistant"), om = by("Organic Maps"), soc = by("Organic Social");
    // deno-lint-ignore no-explicit-any
    const ke = (r: OrgRow | undefined) => r ? Number((r.extra as any).keyEvents) || 0 : 0;
    return a.length ? `Organic Search ${os ? os.clicks : 0} visits (${ke(os)} key actions), AI Assistant ${ai ? ai.clicks : 0}, Organic Maps ${om ? om.clicks : 0}, Organic Social ${soc ? soc.clicks : 0}` : "no data"; };
  L.push(`WEBSITE VISITS (GA4; key actions = forms, chats, calls the site counts): last 7 days ${ch("7d")} | 7 before: ${ch("prev7d")}`);
  L.push(`  last 28 days ${ch("28d")} | 28 before: ${ch("prev28d")}`);
  const ais = get("ga4", "28d", "ai_source").sort((a, b) => b.clicks - a.clicks).slice(0, 5);
  if (ais.length) L.push(`  AI assistants that sent visits (28 days): ${ais.map((r) => `${r.item} ${r.clicks}`).join(", ")}`);
  const W = crmWindows(end);
  const inW = (w: string) => leads.filter((l) => l.day >= W[w][0] && l.day <= W[w][1]);
  const desc = (w: string) => {
    const a = inW(w), web = a.filter((l) => l.source === "Organic"), maps = a.filter((l) => l.source === "Google Maps");
    const prof: Record<string, number> = {}; maps.forEach((l) => { const k = l.sub_source || "profile not set"; prof[k] = (prof[k] || 0) + 1; });
    const jobs = a.reduce((t, l) => t + (rev[l.id]?.jobs || 0), 0), money = a.reduce((t, l) => t + (rev[l.id]?.revenue || 0), 0);
    const shaky = W[w][0] < ORGANIC_CLEAN_FROM ? " [Organic web NOT reliable in this window: before 10 Sep Google ad leads were saved as Organic]" : "";
    return `${a.length} leads (Organic web ${web.length}, Google Maps ${maps.length}${maps.length ? ": " + Object.entries(prof).map(([k, v]) => `${k} ${v}`).join(", ") : ""}), ${jobs} jobs so far, $${Math.round(money)} revenue before GST${shaky}`;
  };
  L.push(`LEADS IN THE APP FROM ORGANIC (cards with source Organic web or Google Maps; jobs = jobs linked to those cards):`);
  for (const w of ["7d", "prev7d", "28d", "prev28d"]) L.push(`  ${({ "7d": "last 7 days", prev7d: "the 7 days before", "28d": "last 28 days", prev28d: "the 28 days before" } as Record<string, string>)[w]} (${W[w][0]}..${W[w][1]}): ${desc(w)}`);
  L.push(`  Note: iPhone clicks on Google ads carry no click id we store, so a few ad leads can still show as Organic web.`);
  const weeks = [...new Set(rows.filter((r) => r.source === "serp").map((r) => r.win))].sort();
  const wk = weeks[weeks.length - 1], pwk = weeks[weeks.length - 2];
  if (wk) {
    const lp = (w: string) => rows.filter((r) => r.source === "serp" && r.win === w && r.level === "localpack");
    const prevLp = new Map((pwk ? lp(pwk) : []).map((r) => [r.item + "|" + r.item2, r.position]));
    L.push(`MAP PACK (weekly check of ${wk}${pwk ? `, compared with ${pwk}` : ""}; our aircon profile's place in the Google map results, by search and area):`);
    for (const r of lp(wk)) { const was = prevLp.get(r.item + "|" + r.item2); L.push(`  "${r.item}" in ${r.item2}: ${r.position === null ? "not in the pack" : "#" + r.position}${pwk ? ` (week before: ${was === undefined ? "not checked" : was === null ? "not in the pack" : "#" + was})` : ""}`); }
    const ai = rows.filter((r) => r.source === "serp" && r.win === wk && r.level === "aimode");
    // deno-lint-ignore no-explicit-any
    if (ai.length) L.push(`AI MODE (Google's AI answers, asked ${ai[0].impressions} times each): ${ai.map((r) => `"${r.item}" named us ${r.clicks} of ${r.impressions}${((r.extra as any).named || []).length ? ` (named instead: ${((r.extra as any).named || []).slice(0, 4).join(", ")})` : ""}`).join("; ")}`);
    const rv = rows.filter((r) => r.source === "serp" && r.win === wk && r.level === "reviews");
    const us = rv.find((r) => r.item2 === "us");
    // deno-lint-ignore no-explicit-any
    if (us) L.push(`REVIEWS (aircon profile): ${us.clicks} reviews, rating ${us.position ?? "-"}, ${(us.extra as any).thisWeek ?? "?"} new this week, newest ${(us.extra as any).newestDays ?? "?"} days old; competitors: ${rv.filter((r) => r.item2 === "competitor").map((r) => `${r.item} ${r.clicks}`).join(", ") || "-"}`);
  } else L.push(`MAP PACK / AI MODE / REVIEWS: no weekly check has been loaded yet.`);
  const pr = ["P0", "P1", "P2", "P3"];
  // deno-lint-ignore no-explicit-any
  const os = open.slice().sort((a: any, b: any) => pr.indexOf(a.priority) - pr.indexOf(b.priority));
  L.push(`OPEN SUGGESTIONS (${os.length}; from the nightly rules and the SEO chat): ${os.length ? "" : "none"}`);
  // deno-lint-ignore no-explicit-any
  for (const s of os.slice(0, 12)) L.push(`  ${s.priority} ${s.status === "in_progress" ? "[being worked on] " : ""}${s.title}`);
  L.push(last ? `PREVIOUS ORGANIC ASSESSMENT (${last.day}): ${last.summary}` : `PREVIOUS ORGANIC ASSESSMENT: none`);
  // deno-lint-ignore no-explicit-any
  if (last) for (const p of (last.points || [])) L.push(`   - ${p.tone} ${p.text}`);
  return L;
}
// --- end organic ---

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__INGEST_TEST__) Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const provided = req.headers.get("x-intake-secret") || "";
  const nowSec = Math.floor(Date.now() / 1000);
  const viaSecret = !!INTAKE_SECRET && provided === INTAKE_SECRET;
  const viaTicket = !viaSecret && !!INTAKE_SECRET && await ticketOk(INTAKE_SECRET, req.headers.get("x-ingest-ticket") || "", nowSec);
  if (!viaSecret && !viaTicket) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  const what = requestKind(body);
  if (viaTicket && !TICKET_ALLOWS.has(what)) return json({ ok: false, error: "a ticket can only replace ad-stat or organic rows and read the real-lead counts" }, 403);
  if (what === "issueTicket") return json({ ok: true, ...(await makeTicket(INTAKE_SECRET!, nowSec, Number(body.issueTicket.minutes) || 150)) });
  // Keyword -> job attribution (30 Sep). The nightly Google routine asks which leads carry a Google click id (gclid)
  // that is not matched yet (pendingGclids), looks each up in Google Ads click_view (clicks are kept ~90 days), and
  // sends back campaign / ad group / keyword (clickAttribution), saved in gads_click_attribution.
  if (body && body.pendingGclids) {
    const sbp = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const since = new Date(Date.now() - 85 * 86400000).toISOString().slice(0, 10);
    const cq = await sbp.from("contacts").select("gclid, created_at").not("gclid", "is", null).neq("gclid", "").gte("created_at", since);
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const dq = await sbp.from("gads_click_attribution").select("gclid");
    if (dq.error) return json({ ok: false, error: "attribution failed: " + dq.error.message }, 500);
    const have = new Set((dq.data || []).map((r: any) => r.gclid));
    const pending = (cq.data || []).filter((c: any) => c.gclid && !have.has(c.gclid)).map((c: any) => ({ gclid: c.gclid, lead_date: String(c.created_at).slice(0, 10) }));
    return json({ ok: true, pending });
  }
  if (body && Array.isArray(body.clickAttribution)) {
    const txt = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, 300));
    const rows = body.clickAttribution.filter((r: any) => r && typeof r.gclid === "string" && r.gclid.length > 10).slice(0, 2000).map((r: any) => ({
      gclid: r.gclid,
      account: txt(r.account) || "6569440597",
      click_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.click_date || "")) ? r.click_date : null,
      network: txt(r.network), campaign: txt(r.campaign), ad_group: txt(r.ad_group), keyword: txt(r.keyword), match_type: txt(r.match_type),
      looked_up_at: new Date().toISOString(),
    }));
    if (!rows.length) return json({ ok: true, saved: 0 });
    const sba = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const up = await sba.from("gads_click_attribution").upsert(rows, { onConflict: "gclid" });
    if (up.error) return json({ ok: false, error: up.error.message }, 500);
    return json({ ok: true, saved: rows.length });
  }
  if (body && body.crmDigest) {
    // Read-only digest of Meta-sourced CRM leads per ad set (utm_content) for the nightly Meta assessment.
    const end = String(body.crmDigest.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return json({ ok: false, error: "invalid end" }, 400);
    const sbd = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const sinceIso = new Date(Date.now() - 110 * 86400000).toISOString();
    const cq = await readAll((a, b) => sbd.from("contacts").select("id,created_at,source,utm_source,utm_content,fbclid").gte("created_at", sinceIso).order("id").range(a, b));
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const sydDay = (ts: string) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
    // One definition everywhere (app Dashboard, Meta board, this digest): a Meta lead is a lead whose source is Meta Ads.
    // An fbclid alone isn't enough — it also comes with organic Facebook shares.
    const isMeta = (c: any) => c.source === "Meta Ads";
    const leads = (cq.data || []).filter(isMeta).map((c: any) => ({ id: c.id, day: sydDay(c.created_at), adset: c.utm_content || "" }));
    const ids = leads.map((l: any) => l.id);
    const rev: Record<string, { jobs: number; revenue: number }> = {};
    // In groups of 200: a long list of ids in one request is too long for the address and fails.
    for (let i = 0; i < ids.length; i += 200) {
      const jq = await sbd.from("jobs").select("contact_id,amount").in("contact_id", ids.slice(i, i + 200));
      if (jq.error) return json({ ok: false, error: "jobs failed: " + jq.error.message }, 500);
      for (const j of (jq.data || []) as any[]) { const r = (rev[j.contact_id] ||= { jobs: 0, revenue: 0 }); r.jobs++; r.revenue += Number(j.amount) || 0; }
    }
    const out: Record<string, any> = {};
    for (const [w, n] of [["7d", 7], ["14d", 14], ["30d", 30], ["60d", 60], ["90d", 90]] as [string, number][]) {
      const endD = new Date(end + "T00:00:00Z"); const startD = new Date(endD.getTime() - (n - 1) * 86400000);
      const start = startD.toISOString().slice(0, 10);
      const inW = leads.filter((l: any) => l.day >= start && l.day <= end);
      const per: Record<string, any> = {};
      for (const l of inW) { const k = l.adset || "(no ad set tag)"; const p = (per[k] ||= { leads: 0, jobs: 0, revenue: 0 }); p.leads++; const r = rev[l.id]; if (r) { p.jobs += r.jobs; p.revenue += r.revenue; } }
      out[w] = { start, end, crm_leads: inW.length, per_adset: per };
    }
    return json({ ok: true, crm: out });
  }
  if (body && body.insight) {
    const ins = body.insight;
    const p = String(body.platform || "");
    if (!["google", "meta", "organic"].includes(p)) return json({ ok: false, error: "invalid platform" }, 400);
    const day = String(ins.day || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: "invalid insight day" }, 400);
    const sbi = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    // basis "real" (since 9 Oct): the Google assessment is written from the real leads, not Google's conversion count.
    const up = await sbi.from("ads_insights").upsert({ platform: p, account: String(body.account || ""), day, summary: String(ins.summary || ""), points: Array.isArray(ins.points) ? ins.points : [], ...(ins.basis === "real" ? { basis: "real" } : {}) }, { onConflict: "platform,account,day" });
    if (up.error) return json({ ok: false, error: "insight failed: " + up.error.message }, 500);
    return json({ ok: true, insight: true });
  }
  // The real leads (CRM forms and chats from Google clicks, Google ad calls of a minute or more) per window, kind and
  // campaign, plus the last week of lead email checks: what the nightly Google assessment is written from.
  if (body && body.realLeads) {
    const sbr = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const rq = await sbr.from("gads_real_leads").select("win,kind,campaign,n");
    if (rq.error) return json({ ok: false, error: "real leads failed: " + rq.error.message }, 500);
    const kq = await sbr.from("lead_email_checks").select("day,emails,matched,missing,mismatch,google_emails,google_matched").order("day", { ascending: false }).limit(7);
    if (kq.error) return json({ ok: false, error: "lead checks failed: " + kq.error.message }, 500);
    // The last assessment written, so tonight's can say what changed since (13 Oct).
    const iq = await sbr.from("ads_insights").select("day,summary,points").eq("platform", "google").order("day", { ascending: false }).limit(1);
    // A ticket holder (the outside sandbox) gets the counts only, never the names of the leads that are missing.
    // deno-lint-ignore no-explicit-any
    const checks = (kq.data || []).map((k: any) => viaTicket ? { day: k.day, emails: k.emails, matched: k.matched, google_emails: k.google_emails, google_matched: k.google_matched, missing_count: (k.missing || []).length, mismatch_count: (k.mismatch || []).length } : k);
    return json({ ok: true, real: rq.data || [], checks, lastInsight: (iq.data || [])[0] || null });
  }
  if (body && body.leadEmails) {
    const list = Array.isArray(body.leadEmails.emails) ? body.leadEmails.emails.slice(0, 500) : null;
    if (!list) return json({ ok: false, error: "invalid leadEmails.emails: expected an array" }, 400);
    const sbl = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const cq = await readAll((a, b) => sbl.from("contacts").select("id,phone,email,source,created_at").order("created_at", { ascending: false }).order("id").range(a, b));
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(body.leadEmails.from || "")) ? String(body.leadEmails.from) : "";
    const res = checkLeadEmails(list, cq.data || [], sydneyDay(Date.now()), from);
    if (res.days.length) {
      const now = new Date().toISOString();
      const up = await sbl.from("lead_email_checks").upsert(res.days.map((d: any) => ({ ...d, checked_at: now })), { onConflict: "day" });
      if (up.error) return json({ ok: false, error: "lead checks failed: " + up.error.message }, 500);
    }
    return json({ ok: true, saved: res.days.length, need_body: res.need_body,
      days: res.days.map((d: any) => ({ day: d.day, emails: d.emails, matched: d.matched, tests: d.tests.length, google_emails: d.google_emails, google_matched: d.google_matched,
        missing: d.missing.map((m: any) => `${m.name || "(no name)"} ${m.phone || m.email || ""}${m.unreadable ? " (details not readable)" : ""}`),
        source_differs: d.mismatch.map((m: any) => `${m.name}: email says ${m.hint}, app says ${m.app_source || "nothing"}`) })) });
  }
  // ── organic (13 Oct) ──
  if (what === "organicRows") {
    const b = organicBatch(body.organic);
    if (!b.ok) return json({ ok: false, error: b.error }, 400);
    const sbo = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const del = await sbo.from("organic_stats").delete().eq("source", b.source).eq("win", b.win).eq("level", b.level);
    if (del.error) return json({ ok: false, error: "delete failed: " + del.error.message }, 500);
    const at = new Date().toISOString();
    for (let i = 0; i < b.rows.length; i += 500) {
      const ins = await sbo.from("organic_stats").insert(b.rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: at })));
      if (ins.error) return json({ ok: false, error: "insert failed: " + ins.error.message }, 500);
    }
    return json({ ok: true, rowsWritten: b.rows.length });
  }
  if (what === "organicWeekly") {
    const w = weeklyBatches(body.seoWeekly);
    if (!w.ok) return json({ ok: false, error: w.error }, 400);
    const sbw = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const at = new Date().toISOString(), written: Record<string, number> = {};
    for (const raw of w.batches) {
      const b = organicBatch(raw);
      if (!b.ok) return json({ ok: false, error: b.error }, 400);
      const del = await sbw.from("organic_stats").delete().eq("source", b.source).eq("win", b.win).eq("level", b.level);
      if (del.error) return json({ ok: false, error: "delete failed: " + del.error.message }, 500);
      const ins = await sbw.from("organic_stats").insert(b.rows.map((r) => ({ ...r, updated_at: at })));
      if (ins.error) return json({ ok: false, error: "insert failed: " + ins.error.message }, 500);
      written[b.level] = b.rows.length;
    }
    return json({ ok: true, week: w.week, written });
  }
  if (what === "organicFindings" || what === "organicDigest") {
    const sbf = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const rq = await readAll((a, b) => sbf.from("organic_stats").select("source,win,level,item,item2,clicks,impressions,position,extra").order("id").range(a, b));
    if (rq.error) return json({ ok: false, error: "organic rows failed: " + rq.error.message }, 500);
    // deno-lint-ignore no-explicit-any
    const rows = (rq.data || []).map((r: any) => ({ ...r, clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, position: r.position === null ? null : Number(r.position), extra: r.extra || {} }));
    const sq = await readAll((a, b) => sbf.from("seo_suggestions").select("id,source,dedupe_key,issue_type,status,priority,title").order("id").range(a, b));
    if (sq.error) return json({ ok: false, error: "suggestions failed: " + sq.error.message }, 500);
    if (what === "organicFindings") {
      const { findings, evaluated } = organicFindings(rows);
      const nowIso = new Date().toISOString();
      const ch = syncSuggestions(findings, sq.data || [], evaluated, nowIso);
      if (ch.inserts.length) { const r = await sbf.from("seo_suggestions").insert(ch.inserts); if (r.error) return json({ ok: false, error: "insert failed: " + r.error.message }, 500); }
      for (const u of [...ch.updates, ...ch.resolves]) { const { id, ...f } = u; const r = await sbf.from("seo_suggestions").update(f).eq("id", id); if (r.error) return json({ ok: false, error: "update failed: " + r.error.message }, 500); }
      return json({ ok: true, rules_run: evaluated, found: findings.length, added: ch.inserts.length, refreshed: ch.updates.length, solved_by_themselves: ch.resolves.length });
    }
    const end = String(body.organicDigest.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return json({ ok: false, error: "invalid end" }, 400);
    const since = new Date(Date.parse(end + "T00:00:00Z") - 60 * 86400000).toISOString();
    const cq = await readAll((a, b) => sbf.from("contacts").select("id,created_at,source,sub_source,division").in("source", ["Organic", "Google Maps"]).gte("created_at", since).order("id").range(a, b));
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    // deno-lint-ignore no-explicit-any
    const leads = (cq.data || []).map((c: any) => ({ id: c.id, day: sydneyDay(c.created_at), source: c.source, sub_source: c.sub_source || "", division: c.division || "" }));
    const ids = leads.map((l) => l.id);
    const rev: Record<string, { jobs: number; revenue: number }> = {};
    for (let i = 0; i < ids.length; i += 200) {
      const jq = await sbf.from("jobs").select("contact_id,amount").in("contact_id", ids.slice(i, i + 200));
      if (jq.error) return json({ ok: false, error: "jobs failed: " + jq.error.message }, 500);
      // deno-lint-ignore no-explicit-any
      for (const j of (jq.data || []) as any[]) { const r = (rev[j.contact_id] ||= { jobs: 0, revenue: 0 }); r.jobs++; r.revenue += Number(j.amount) || 0; }
    }
    // deno-lint-ignore no-explicit-any
    const open = (sq.data || []).filter((s: any) => s.status === "open" || s.status === "in_progress");
    const iq = await sbf.from("ads_insights").select("day,summary,points").eq("platform", "organic").order("day", { ascending: false }).limit(1);
    return json({ ok: true, lines: organicDigest(rows, leads, rev, open, (iq.data || [])[0] || null, end) });
  }
  const platform = String(body?.platform || "");
  const account = String(body?.account || "");
  const win = String(body?.win || "");
  const level = String(body?.level || "");
  const rowsIn = body?.rows;
  if (!["google", "meta"].includes(platform)) return json({ ok: false, error: "invalid platform" }, 400);
  if (!win || win.length > 12) return json({ ok: false, error: "invalid win" }, 400);
  if (!LEVELS.has(level)) return json({ ok: false, error: "invalid level" }, 400);
  if (!Array.isArray(rowsIn)) return json({ ok: false, error: "invalid rows: expected an array" }, 400);

  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const r of rowsIn) {
    const row = {
      platform, account, win, level,
      campaign: String(r?.campaign ?? ""), ad_group: String(r?.ad_group ?? ""),
      item: String(r?.item ?? ""), item2: String(r?.item2 ?? ""),
      impressions: Math.round(num(r?.impressions)), clicks: Math.round(num(r?.clicks)),
      cost: num(r?.cost), conversions: num(r?.conversions),
      extra: (r?.extra && typeof r.extra === "object") ? r.extra : {},
      updated_at: new Date().toISOString(),
    };
    const k = [row.campaign, row.ad_group, row.item, row.item2].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(row);
  }

  const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
  const del = await sb.from("ads_stats").delete().eq("platform", platform).eq("account", account).eq("win", win).eq("level", level);
  if (del.error) return json({ ok: false, error: "delete failed: " + del.error.message }, 500);
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await sb.from("ads_stats").insert(rows.slice(i, i + 500));
    if (ins.error) return json({ ok: false, error: "insert failed: " + ins.error.message }, 500);
  }
  return json({ ok: true, rowsWritten: rows.length });
});
