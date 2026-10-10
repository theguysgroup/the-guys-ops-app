// review-requests: a Google review request after every job (Ofek, 29 Sep 2026; reworked 2 and 5 Oct).
//
// Called every 15 minutes by the info@ Google script with the recent week tabs of the jobs sheet. Each run:
//   1. keeps Jobs & Commissions in step with the sheet (syncSheetJobs);
//   2. when settings.review_requests_auto is on (Ofek 5 Oct: switched on only at go-live), asks every new job from
//      settings.reviews_from on that hasn't been asked: as soon as the job is in OPS, between 08:00 and 20:00 Sydney,
//      otherwise at 10:00 the next morning. Skipped: review taken, "don't ask", a customer asked in the last 6 months.
//      A job it can't ask for (no customer card in the CRM, no mobile or email on the card, unknown job type) is written
//      down as skipped, and the app puts it in the "Ask for a review" bubble on My Day for the office to fix and ask;
//   3. sends what is due while settings.review_requests_enabled is on (08:00–20:00 Sydney):
//      - the SMS through the GHL workflow (GHL_REVIEW_WEBHOOK_URL), from the business's Australian number;
//      - the email is handed to the same Google script, which runs under info@theguyservicegroup.com and sends it from
//        that mailbox (real sender name, no spam folder). Emails are only handed out to a caller that proves — with a
//        Google ID token that Google itself verifies — that it is info@. Anyone else gets no customer details back.
// The office can also press "Ask for review" on a job, and "Ask again" once for a customer who still hasn't left a review
// a day later (the app shows those in the bubble; the nightly review routine marks the ones who did).
//
// The customer's mobile, email and first name come from their customer card in the OPS CRM (Ofek 5 Oct), never from
// the caller. Texts go to mobiles only, never to a number that texted STOP.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SERVICEM8_API_KEY = Deno.env.get("SERVICEM8_API_KEY");
const GHL_REVIEW_WEBHOOK_URL = Deno.env.get("GHL_REVIEW_WEBHOOK_URL");
const MAILBOX = "info@theguyservicegroup.com";   // the only account allowed to collect the emails to send

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// ── Sydney time ──
const SYD = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function sydParts(ms: number) {
  const p = Object.fromEntries(SYD.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// The UTC instant of a Sydney wall-clock time (handles daylight saving).
function sydToUtc(day: string, hour: number, minute: number): number {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = sydParts(t);
    const [py, pm, pd] = p.day.split("-").map(Number);
    t -= Date.UTC(py, pm - 1, pd, p.hour, p.minute) - Date.UTC(y, m - 1, d, hour, minute);
  }
  return t;
}
// Requests go out between 08:00 and 20:00 Sydney; one made outside those hours goes at 10:00 the next morning.
const SEND_FROM = 8, SEND_UNTIL = 20, MORNING = 10;
function inSendWindow(nowMs: number): boolean { const h = sydParts(nowMs).hour; return h >= SEND_FROM && h < SEND_UNTIL; }
function sendAt(nowMs: number): number {
  if (inSendWindow(nowMs)) return nowMs;
  const p = sydParts(nowMs);
  return sydToUtc(p.hour < SEND_FROM ? p.day : shiftDay(p.day, 1), MORNING, 0);
}

// ── Which profile the review goes to (the three Google review links Ofek sent on 29 Sep) ──
const REVIEW = {
  aircon: { link: "https://search.google.com/local/writereview?placeid=ChIJx33jOtfwSSgRs09ybCNrVbU", result: "Enjoy the fresh, clean air!" },
  chimney: { link: "https://g.page/r/CZUuKFAccuR4EBM/review", result: "Enjoy your clean, safe fireplace!" },
  pw: { link: "https://g.page/r/CZjy0MO5zKE7EBM/review", result: "Enjoy your fresh, clean outdoor area!" },
};
function reviewFor(jobType: string) {
  const t = String(jobType || "").toLowerCase();
  if (/chim|flue|fire/.test(t)) return REVIEW.chimney;
  if (/\bpw\b|pressure|wash|surface|roof|driveway|solar/.test(t)) return REVIEW.pw;
  if (/air|\bac\b|split|duct|vent|hvac/.test(t)) return REVIEW.aircon;
  return null;
}

// ── Small helpers ──
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
function firstNameOf(name: string): string {
  const n = String(name || "").trim();
  if (!n) return "";
  const first = n.includes(",") ? n.split(",")[1].trim().split(/\s+/)[0] : n.split(/\s+/)[0];   // "Surname, First" (ServiceM8 style)
  return titleCase(first || "");
}
// Australian numbers → +61…; anything that isn't a plausible mobile/landline gives "".
function normPhone(p: unknown): string {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("61")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return /^\d{9}$/.test(d) ? "+61" + d : "";
}
const cleanEmail = (e: unknown) => { const s = String(e || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""; };
function reviewTaken(v: unknown): boolean { return /taken|yes|done|✓|true/i.test(String(v || "")); }
// "Don't ask" (Ofek, 1 Oct): an unhappy customer or a complaint. Written in the sheet's Review column for now, or ticked
// on the job in the OPS app ("Don't ask for a review", jobs.review_do_not_ask). Either one stops the request, even one
// that is already waiting.
function reviewDoNotAsk(v: unknown): boolean { return /don'?t\s*ask|do\s*not\s*ask|no\s*ask|complain/i.test(String(v || "")); }
const NO_ASK_REASON = "do not ask (unhappy customer or complaint)";
function isDay(s: unknown): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// ── The customer's details: from their card in the OPS CRM (Ofek, 5 Oct), not from ServiceM8 ──
// The job's linked card (jobs.contact_id); a job not linked yet uses the one card with exactly the job's customer name.
// The text goes to a mobile only (a landline can't receive it), never to a number that texted STOP.
const normMobile = (p: unknown) => { const e = normPhone(p); return /^\+614\d{8}$/.test(e) ? e : ""; };
// deno-lint-ignore no-explicit-any
async function contactFromCrm(sb: any, job: any) {
  // deno-lint-ignore no-explicit-any
  let c: any = null;
  if (job.contact_id) { const { data } = await sb.from("contacts").select("id, full_name, phone, email").eq("id", job.contact_id).limit(1); c = data && data[0]; }
  const name = String(job.customer_name || "").trim();
  if (!c && name) {
    const { data } = await sb.from("contacts").select("id, full_name, phone, email").ilike("full_name", name.replace(/[%_\\]/g, "\\$&")).limit(2);
    if (data && data.length === 1) c = data[0];
  }
  if (!c) return null;
  let phone = normMobile(c.phone);
  if (phone) { const { data: stop } = await sb.from("sms_opt_outs").select("phone_key").eq("phone_key", phone.slice(-9)).limit(1); if (stop && stop.length) phone = ""; }
  return { id: c.id, phone, email: cleanEmail(c.email), first: firstNameOf(c.full_name) };
}
// Why a job can't be asked, in words (kept on the skipped request; the app shows these in the My Day bubble).
const SKIP_TEXT: Record<string, string> = {
  no_card: "no customer card in the CRM for this job",
  no_contact: "no mobile or email on the customer card",
  unknown_job_type: "unknown job type, so no review link",
  asked_recently: "same customer already asked or waiting (6 months)",
  do_not_ask: NO_ASK_REASON,
  review_taken: "review taken",
  no_invoice: "no invoice number",
};

// ── ServiceM8: job number → the customer's contact details ──
async function sm8(path: string): Promise<any[]> {
  const r = await fetch(`https://api.servicem8.com/api_1.0/${path}`, { headers: { "X-API-Key": SERVICEM8_API_KEY!, Accept: "application/json" } });
  if (!r.ok) throw new Error(`ServiceM8 ${r.status} on ${path.split("?")[0]}`);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}
const q = (s: string) => encodeURIComponent(s);
async function contactForJob(jobNumber: string) {
  const jobs = await sm8(`job.json?%24filter=${q(`generated_job_id eq '${jobNumber.replace(/'/g, "")}'`)}`);
  const job = jobs.find((j) => String(j.active) !== "0") || jobs[0];
  if (!job) return null;
  const pick = (list: any[]) => list.find((c) => String(c.active) !== "0" && (normPhone(c.mobile) || normPhone(c.phone) || cleanEmail(c.email))) || null;
  const jobContacts = await sm8(`jobcontact.json?%24filter=${q(`job_uuid eq '${job.uuid}'`)}`);
  let c = pick(jobContacts.filter((x) => /job/i.test(String(x.type || "")))) || pick(jobContacts);
  if (!c && job.company_uuid) {
    const companyContacts = await sm8(`companycontact.json?%24filter=${q(`company_uuid eq '${job.company_uuid}'`)}`);
    c = pick(companyContacts.filter((x) => String(x.is_primary_contact) === "1")) || pick(companyContacts);
  }
  if (!c) return { found: true, phone: "", email: "", first: "" };
  return { found: true, phone: normPhone(c.mobile) || normPhone(c.phone), email: cleanEmail(c.email), first: titleCase(String(c.first || "").trim()) };
}

// ── The messages (text approved by Ofek on 29 Sep) ──
function buildMessages(r: { first_name: string; technician: string; review_link: string; job_type: string; job_date: string }, todaySyd: string) {
  const rv = reviewFor(r.job_type)!;
  const name = r.first_name ? ` ${r.first_name}` : "";
  const tech = firstNameOf(r.technician) || "The team";
  const when = r.job_date === todaySyd ? " today" : "";
  const sms = `Hi${name}, ${tech} from The Guys Service Group here - thanks for having us${when}! ${rv.result} Our team works really hard and would truly appreciate a quick Google review: ${r.review_link} Thank you!`;
  const subject = `A quick favour${r.first_name ? ", " + r.first_name : ""}?`;
  const html = `<p>Hi${name},</p>
<p>Thanks for having us${when} - it was a pleasure. ${rv.result}</p>
<p>Our team works really hard to do every job properly, and a Google review from you would mean a lot to them. It takes 30 seconds.</p>
<p><a href="${r.review_link}" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">&#11088;&#11088;&#11088;&#11088;&#11088; Leave a quick Google review</a></p>
<p>Thank you!<br>${tech}<br>The Guys Service Group</p>`;
  const text = `Hi${name},\n\nThanks for having us${when} - it was a pleasure. ${rv.result}\n\nOur team works really hard to do every job properly, and a Google review from you would mean a lot to them. It takes 30 seconds:\n${r.review_link}\n\nThank you!\n${tech}\nThe Guys Service Group`;
  return { sms, subject, html, text };
}
// True only when Google confirms the token belongs to the business mailbox (checked with Google, not by us).
// Google id tokens (from the info@ script's ScriptApp.getIdentityToken) are checked here against Google's published signing
// keys. Until 10 Oct every call asked Google's tokeninfo endpoint, which Google rate-limits; the jobs-sheet sync stopped
// getting through on 3 Oct, when the chat emails started calling every minute, most likely for that reason. tokeninfo stays
// only as a fallback when the keys can't be fetched. Every refusal is now logged, so it can't go unnoticed again.
let GOOGLE_KEYS: { at: number; keys: any[] } | null = null;
async function googleSigningKeys(): Promise<any[]> {
  if (GOOGLE_KEYS && Date.now() - GOOGLE_KEYS.at < 3600 * 1000) return GOOGLE_KEYS.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("Google signing keys: HTTP " + r.status);
  const j = await r.json();
  GOOGLE_KEYS = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
  return GOOGLE_KEYS.keys;
}
function base64UrlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
// The token's claims when its signature, issuer and expiry are good; null when they're not (the reason is logged).
// deno-lint-ignore no-explicit-any
async function verifyGoogleIdToken(token: string, nowMs = Date.now()): Promise<any | null> {
  const parts = token.split(".");
  if (parts.length !== 3) { console.warn("id token: not a JWT"); return null; }
  const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
  if (header.alg !== "RS256") { console.warn("id token: unexpected alg", header.alg); return null; }
  const jwk = (await googleSigningKeys()).find((k) => k.kid === header.kid);
  if (!jwk) { console.warn("id token: unknown signing key", header.kid); return null; }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!good) { console.warn("id token: bad signature"); return null; }
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") { console.warn("id token: wrong issuer", claims.iss); return null; }
  if (!(Number(claims.exp) * 1000 > nowMs)) { console.warn("id token: expired"); return null; }
  return claims;
}
// deno-lint-ignore no-explicit-any
function claimsAreMailbox(t: any): boolean {
  return String(t?.email || "").toLowerCase() === MAILBOX && String(t?.email_verified) === "true";
}
async function googleSaysMailbox(idToken: unknown): Promise<boolean> {
  if (typeof idToken !== "string" || idToken.length < 20) return false;
  try {
    const t = await verifyGoogleIdToken(idToken);
    if (!t) return false;
    const ok = claimsAreMailbox(t);
    if (!ok) console.warn("id token: not the info@ mailbox", String(t.email || ""));
    return ok;
  } catch (e) {
    console.warn("id token: key check failed, asking tokeninfo instead:", String((e as Error).message || e));
    try {
      const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!r.ok) { console.warn("id token: tokeninfo HTTP", r.status); return false; }
      const t = await r.json();
      return claimsAreMailbox(t) && Number(t.exp) * 1000 > Date.now();
    } catch (e2) { console.warn("id token: tokeninfo failed:", String((e2 as Error).message || e2)); return false; }
  }
}
async function isMailbox(idToken: unknown): Promise<boolean> {
  return await googleSaysMailbox(idToken);
}

// deno-lint-ignore no-explicit-any
async function handle(sb: any, rows: any[], nowMs: number) {
  const out = { queued: 0, skipped: 0, sent: 0, errors: 0 };
  // A "don't ask" note in the sheet's Review column stops a request even before the job sync has marked the job.
  const sheetNoAsk = new Set((Array.isArray(rows) ? rows : []).slice(0, 200).filter((r) => reviewDoNotAsk(r?.review)).map((r) => digits(r?.invoice)).filter(Boolean));
  const { data: settings } = await sb.from("settings").select("review_requests_enabled, review_requests_auto, reviews_from").limit(1);
  const s = (settings && settings[0]) || {};
  const enabled = !!s.review_requests_enabled, auto = !!s.review_requests_auto;
  if (enabled && auto) { const a = await autoAsk(sb, nowMs, s.reviews_from, sheetNoAsk); out.queued += a.queued; out.skipped += a.skipped; }
  // Release what's due — only while switched on and during sending hours in Sydney. The SMS goes out here through GHL;
  // the email is picked up by the info@ script (emailsToSend below).
  if (enabled && inSendWindow(nowMs)) { const r = await releaseDue(sb, nowMs, sheetNoAsk); out.sent += r.sent; out.skipped += r.skipped; out.errors += r.errors; }
  return { ...out, enabled, auto, ghl: !!GHL_REVIEW_WEBHOOK_URL };
}

// ── One job's request, checked and put in the queue: by hand ("Ask for review", Ofek 2 Oct) or automatically when the
// job comes in (Ofek 5 Oct). "again" = asked on purpose once more (the reminder a day later, or a customer asked for
// another job in the last 6 months). ask_count counts the requests that actually went to this customer for this job.
const JOB_COLS = "id, invoice_number, customer_name, date, job_type, technician, review_taken, review_do_not_ask, contact_id";
// deno-lint-ignore no-explicit-any
async function queueRequest(sb: any, job: any, nowMs: number, o: { by: string | null; source: "manual" | "auto"; again: boolean; blocked?: Set<string> }) {
  const invoice = digits(job.invoice_number);
  if (!invoice) return { ok: false, reason: "no_invoice" };
  if (job.review_do_not_ask || (o.blocked && o.blocked.has(invoice))) return { ok: false, reason: "do_not_ask" };
  if (job.review_taken) return { ok: false, reason: "review_taken" };
  const { data: existing } = await sb.from("review_requests").select("id, status, sent_at, ask_count").eq("invoice_number", invoice).limit(1);
  const ex = existing && existing[0];
  if (ex && (ex.status === "sent" || ex.status === "waiting") && !o.again) return { ok: false, reason: "already_asked", status: ex.status, sent_at: ex.sent_at };
  const rv = reviewFor(job.job_type);
  if (!rv) return { ok: false, reason: "unknown_job_type" };
  const c = await contactFromCrm(sb, job);
  if (!c) return { ok: false, reason: "no_card" };
  if (!c.phone && !c.email) return { ok: false, reason: "no_contact" };
  if (!o.again) {
    // Asked in the last 6 months, or already waiting to be asked (same mobile or email, e.g. two jobs on one day) → once is enough.
    const since = new Date(nowMs - 183 * 24 * 3600 * 1000).toISOString();
    const ors = [c.phone ? `phone.eq.${c.phone}` : "", c.email ? `email.eq.${c.email}` : ""].filter(Boolean).join(",");
    const { data: recent } = await sb.from("review_requests").select("id, invoice_number").in("status", ["sent", "waiting"]).gte("created_at", since).or(ors).limit(5);
    // deno-lint-ignore no-explicit-any
    if ((recent || []).some((x: any) => x.invoice_number !== invoice)) return { ok: false, reason: "asked_recently" };
  }
  const stamp = new Date(nowMs).toISOString(), at = sendAt(nowMs);
  const prevCount = ex ? Number(ex.ask_count) || 1 : 0;
  const row = {
    source: o.source, invoice_number: invoice, job_id: job.id, job_date: job.date, customer_name: job.customer_name, job_type: job.job_type, technician: job.technician,
    phone: c.phone || null, email: c.email || null, first_name: c.first || firstNameOf(job.customer_name), review_link: rv.link,
    status: "waiting", reason: null, send_after: new Date(at).toISOString(), requested_by: o.by, updated_at: stamp,
    ask_count: ex && ex.status === "sent" ? prevCount + 1 : Math.max(prevCount, 1),
  };
  let id = ex ? ex.id : "";
  if (ex) await sb.from("review_requests").update({ ...row, sent_at: null, sms_sent_at: null, email_sent_at: null }).eq("id", ex.id);
  else { const { data: ins } = await sb.from("review_requests").insert(row).select("id").single(); id = ins ? ins.id : ""; }
  return { ok: true, id, now: at === nowMs, send_after: row.send_after };
}

// ── Automatic request when a job comes in (Ofek 5 Oct; on only while settings.review_requests_auto is on) ──
// Jobs from settings.reviews_from (and at most a week old) that have no request yet. One the system can't ask for is
// written down as skipped with the reason, so it isn't tried again and the office sees it in the My Day bubble.
// deno-lint-ignore no-explicit-any
async function autoAsk(sb: any, nowMs: number, fromDay: unknown, sheetNoAsk: Set<string>) {
  const out = { queued: 0, skipped: 0 };
  const today = sydParts(nowMs).day, weekAgo = shiftDay(today, -7);
  if (!isDay(fromDay)) return out;   // never without a start date: old jobs are never asked automatically
  const since = fromDay > weekAgo ? fromDay : weekAgo;
  const { data: jobs } = await sb.from("jobs").select(JOB_COLS).gte("date", since).lte("date", today).limit(500);
  // deno-lint-ignore no-explicit-any
  const list = (jobs || []).filter((j: any) => digits(j.invoice_number) && !j.review_taken && !j.review_do_not_ask);
  if (!list.length) return out;
  // deno-lint-ignore no-explicit-any
  const { data: known } = await sb.from("review_requests").select("invoice_number").in("invoice_number", list.map((j: any) => digits(j.invoice_number)));
  // deno-lint-ignore no-explicit-any
  const have = new Set((known || []).map((k: any) => k.invoice_number));
  for (const j of list) {
    const invoice = digits(j.invoice_number);
    if (have.has(invoice)) continue;
    have.add(invoice);
    const q = await queueRequest(sb, j, nowMs, { by: null, source: "auto", again: false, blocked: sheetNoAsk });
    if (q.ok) {
      out.queued++;
      if (q.now && q.id) await releaseDue(sb, nowMs, sheetNoAsk, q.id);
      continue;
    }
    if (q.reason === "already_asked") continue;
    await sb.from("review_requests").insert({
      source: "auto", invoice_number: invoice, job_id: j.id, job_date: j.date, customer_name: j.customer_name, job_type: j.job_type, technician: j.technician,
      status: "skipped", reason: SKIP_TEXT[q.reason as string] || q.reason, updated_at: new Date(nowMs).toISOString(),
    });
    out.skipped++;
  }
  return out;
}

// Sends the waiting requests that are due (or just one, right after it was made).
// deno-lint-ignore no-explicit-any
async function releaseDue(sb: any, nowMs: number, sheetNoAsk: Set<string>, onlyId?: string) {
  const out = { sent: 0, skipped: 0, errors: 0 };
  const todaySyd = sydParts(nowMs).day;
  let q = sb.from("review_requests").select("*").eq("status", "waiting").lte("send_after", new Date(nowMs).toISOString());
  if (onlyId) q = q.eq("id", onlyId);
  const { data: due } = await q.limit(20);
  for (const r of due || []) {
    const stamp = new Date(nowMs).toISOString();
    const skip = async (reason: string) => { await sb.from("review_requests").update({ status: "skipped", reason, updated_at: stamp }).eq("id", r.id); out.skipped++; };
    // Too late to ask: an automatic one for a job more than a week old (the old sheet ones: 2 days). By hand: any time.
    const oldest = r.source === "auto" ? shiftDay(todaySyd, -7) : shiftDay(todaySyd, -2);
    if (r.source !== "manual" && (!r.job_date || r.job_date < oldest)) { await skip("too late to ask"); continue; }
    // Marked "review taken" or "don't ask" while it waited (the tech got the review on site, or a complaint came in).
    const { data: jj } = r.job_id
      ? await sb.from("jobs").select("review_taken, review_do_not_ask").eq("id", r.job_id).limit(1)
      : await sb.from("jobs").select("review_taken, review_do_not_ask").eq("invoice_number", r.invoice_number).limit(1);
    const job = jj && jj[0];
    if ((job && job.review_do_not_ask) || sheetNoAsk.has(digits(r.invoice_number))) { await skip(NO_ASK_REASON); continue; }
    if (job && job.review_taken) { await skip("review taken"); continue; }
    const m = buildMessages(r, todaySyd);
    try {
      // SMS through GHL (only the phone goes — the email is sent from info@ by the Google script, see below).
      let smsAt: string | null = null;
      if (r.phone && GHL_REVIEW_WEBHOOK_URL) {
        const res = await fetch(GHL_REVIEW_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          first_name: r.first_name || "", full_name: r.customer_name || "", phone: r.phone, email: "",
          technician: firstNameOf(r.technician), job_type: r.job_type, job_number: r.invoice_number, review_link: r.review_link,
          sms_text: m.sms,
        }) });
        if (!res.ok) throw new Error(`GHL ${res.status}`);
        smsAt = stamp;
      }
      await sb.from("review_requests").update({ status: "sent", sent_at: stamp, sms_sent_at: smsAt, first_sent_at: r.first_sent_at || stamp, updated_at: stamp }).eq("id", r.id);
      out.sent++;
    } catch (e) {
      await sb.from("review_requests").update({ status: "error", reason: String((e as Error).message || e).slice(0, 200), updated_at: stamp }).eq("id", r.id);
      out.errors++;
    }
  }
  return out;
}
// ── Jobs sheet → OPS jobs (Ofek, 2 Oct) ──
// Until Ron logs jobs in the app, the info@ script sends the last three week tabs of the jobs sheet every 15 minutes and
// this keeps Jobs & Commissions in step: a new invoice becomes a job (linked to its customer by the ServiceM8 phone);
// a field changed in the sheet since the last sync updates the job. A field only changed in the app is left alone,
// "paid to tech" stays with Payroll, and nothing is ever deleted. jobs.sheet_snapshot holds the last values seen.
const SHEET_FIELDS = ["customer_name", "date", "technician", "job_type", "amount", "includes_gst", "payment_status", "payment_method", "parts_cost", "commission_percent", "review_taken"];
const PAY_METHOD: Record<string, string> = { cc: "Credit Card", "credit card": "Credit Card", card: "Credit Card", bt: "Bank Transfer", "bank transfer": "Bank Transfer", transfer: "Bank Transfer", cash: "Cash" };
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
function sheetJobType(v: unknown): string {
  const t = String(v || "").toLowerCase();
  if (/\bpw\b|pressure|wash|roof|solar|gutter/.test(t)) return "Pressure Washing";
  if (/chim|flue|fire/.test(t)) return "Chimney";
  if (/air|\bac\b|split|duct/.test(t)) return "Aircon";
  return t ? "Other" : "";
}
// deno-lint-ignore no-explicit-any
function sheetRowToJob(r: any) {
  const invoice = String(r?.invoice ?? "").replace(/\D/g, "");
  const name = String(r?.name ?? "").trim();
  if (!invoice || !name || !isDay(r?.date)) return null;
  const amount = money(r.amount), parts = money(r.parts), thc = money(r.thc), gst = money(r.gst);
  const base = amount - parts;
  return {
    invoice_number: invoice, customer_name: name, date: r.date, technician: String(r.technician || "").trim(),
    job_type: sheetJobType(r.job_type), amount, includes_gst: gst > 0,
    payment_status: /^paid$/i.test(String(r.status || "").trim()) ? "Paid" : "Unpaid",
    payment_method: PAY_METHOD[String(r.payment_method || "").trim().toLowerCase()] || "",
    parts_cost: parts, commission_percent: thc > 0 && base > 0 ? Math.round(thc / base * 10000) / 100 : 0,
    review_taken: reviewTaken(r.review) && !/not/i.test(String(r.review || "")),
  };
}
// deno-lint-ignore no-explicit-any
async function linkContactForInvoice(sb: any, invoice: string, name: string): Promise<string | null> {
  try {
    const c = SERVICEM8_API_KEY ? await contactForJob(invoice) : null;
    const key = c && c.phone ? c.phone.replace(/\D/g, "").slice(-9) : "", em = c && c.email ? c.email : "";
    // deno-lint-ignore no-explicit-any
    let best: any = null;
    for (let from = 0; from < 50000; from += 1000) {
      const { data } = await sb.from("contacts").select("id, full_name, phone, email, created_at").order("id").range(from, from + 999);
      for (const x of data || []) {
        const byPhone = key && String(x.phone || "").replace(/\D/g, "").slice(-9) === key;
        const byEmail = em && String(x.email || "").trim().toLowerCase() === em;
        const byName = !key && !em && String(x.full_name || "").trim().toLowerCase() === name.toLowerCase();
        if ((byPhone || byEmail || byName) && (!best || String(x.created_at) > String(best.created_at))) best = x;
      }
      if (!data || data.length < 1000) break;
    }
    return best ? best.id : null;
  } catch { return null; }
}
// deno-lint-ignore no-explicit-any
async function syncSheetJobs(sb: any, rows: any[], nowMs: number) {
  const out = { inserted: 0, updated: 0, adopted: 0, unchanged: 0, skipped: 0 };
  const today = sydParts(nowMs).day;
  const seen = new Set<string>();
  for (const raw of (Array.isArray(rows) ? rows : []).slice(0, 200)) {
    const j = sheetRowToJob(raw);
    if (!j || seen.has(j.invoice_number)) { out.skipped++; continue; }
    seen.add(j.invoice_number);
    const { data: found } = await sb.from("jobs").select("*").eq("invoice_number", j.invoice_number).limit(1);
    const ex = found && found[0];
    const noAsk = reviewDoNotAsk(raw?.review);
    if (!ex) {
      const contactId = await linkContactForInvoice(sb, j.invoice_number, j.customer_name);
      const row = {
        ...j, job_type: j.job_type || "Other", contact_id: contactId, date_paid: j.payment_status === "Paid" ? j.date : null, paid_to_technician: "Not Paid",
        review_do_not_ask: noAsk,
        parts_refund_status: "N/A", cash_confirmed: false, entered_by: "System (sheet sync)", notes: "Imported from the jobs Google Sheet",
        sheet_snapshot: j,
      };
      const { data: ins, error } = await sb.from("jobs").insert(row).select("id").single();
      if (error) { out.skipped++; continue; }
      await sb.from("activity_log").insert({ record_kind: "job", record_id: ins.id, actor: "System", text: "Job added from the jobs Google Sheet", manual: false, at: new Date(nowMs).toISOString() });
      out.inserted++;
      continue;
    }
    // A job already here but never synced: one an import put in (entered by "System …" or nobody) takes the sheet's values,
    // since the sheet is Ron's record; one a person entered in the app keeps its values and only later sheet edits flow in.
    const imported = !ex.entered_by || /^system/i.test(String(ex.entered_by));
    if (!ex.sheet_snapshot && !imported) { await sb.from("jobs").update({ sheet_snapshot: j }).eq("id", ex.id); out.adopted++; continue; }
    const prev = ex.sheet_snapshot || {};
    const patch: Record<string, unknown> = {};
    for (const f of SHEET_FIELDS) {
      const v = (j as any)[f];
      if (v === "" && (f === "job_type" || f === "payment_method" || f === "technician")) continue;   // an empty sheet cell never wipes a value
      const differs = ex.sheet_snapshot ? JSON.stringify(v) !== JSON.stringify(prev[f]) : JSON.stringify(v) !== JSON.stringify(ex[f]);
      if (differs) patch[f] = v;
    }
    // "Don't ask" written in the sheet's Review column marks the job too (Ofek 1 Oct). One way only: the sheet never
    // clears a "don't ask" ticked in the app.
    if (noAsk && !ex.review_do_not_ask) patch.review_do_not_ask = true;
    if (!ex.sheet_snapshot && !Object.keys(patch).length) { await sb.from("jobs").update({ sheet_snapshot: j }).eq("id", ex.id); out.adopted++; continue; }
    if (!Object.keys(patch).length) { out.unchanged++; continue; }
    if (patch.payment_status === "Paid" && !ex.date_paid) patch.date_paid = today;   // commission counts in the week the customer paid
    if (patch.payment_status === "Unpaid") patch.date_paid = null;
    await sb.from("jobs").update({ ...patch, sheet_snapshot: j }).eq("id", ex.id);
    await sb.from("activity_log").insert({ record_kind: "job", record_id: ex.id, actor: "System", text: `Updated from the jobs Google Sheet: ${Object.keys(patch).filter((k) => k !== "date_paid").join(", ")}`, manual: false, at: new Date(nowMs).toISOString() });
    out.updated++;
  }
  return out;
}
// ── "Ask for review" / "Ask again" on a job: the office presses the button (Jobs & Commissions, or the My Day bubble) ──
// Same checks and texts as the automatic request (queueRequest); sends at once between 08:00 and 20:00 Sydney,
// otherwise at 10:00 the next morning.
// deno-lint-ignore no-explicit-any
async function askForReview(sb: any, jobId: string, by: string, nowMs: number, again = false) {
  const { data: job } = await sb.from("jobs").select(JOB_COLS).eq("id", jobId).single();
  if (!job) return { ok: false, reason: "job_not_found" };
  const q = await queueRequest(sb, job, nowMs, { by, source: "manual", again });
  if (!q.ok) return q;
  const { data: settings } = await sb.from("settings").select("review_requests_enabled").limit(1);
  const enabled = !!(settings && settings[0] && settings[0].review_requests_enabled);
  if (enabled && q.id && q.now) await releaseDue(sb, nowMs, new Set(), q.id);
  const { data: after } = await sb.from("review_requests").select("status, sent_at, send_after, reason").eq("id", q.id).limit(1);
  const a = after && after[0];
  return { ok: !!a && a.status !== "error", status: a ? a.status : "waiting", send_after: q.send_after, reason: a && a.status === "error" ? a.reason : undefined, enabled };
}
// The signed-in person pressing the button: an owner/manager, or office staff with Jobs access (never a technician).
// deno-lint-ignore no-explicit-any
async function officeUser(sb: any, req: Request): Promise<any | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role, permissions").eq("id", u.user.id).single();
  if (!p) return null;
  return p.role === "owner" || p.role === "manager" || (p.role === "va" && p.permissions && p.permissions.jobs) ? p : null;
}
// The emails the info@ script should send now: requests already released (status sent) in the last 2 days whose email
// hasn't gone yet. Only ever returned to the verified mailbox.
// deno-lint-ignore no-explicit-any
async function emailsToSend(sb: any, nowMs: number) {
  const todaySyd = sydParts(nowMs).day;
  const since = new Date(nowMs - 2 * 24 * 3600 * 1000).toISOString();
  const { data } = await sb.from("review_requests").select("*").eq("status", "sent").is("email_sent_at", null).gte("sent_at", since).limit(20);
  return (data || []).filter((r: any) => r.email).map((r: any) => { const m = buildMessages(r, todaySyd); return { id: r.id, to: r.email, subject: m.subject, html: m.html, text: m.text }; });
}

if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__REVIEW_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "Could not parse request body" }, 400); }
    // Check-only: is this job number in ServiceM8, and does it have a mobile / email? Answers yes/no only — no personal
    // details — and writes nothing. Used to confirm the ServiceM8 key works before anything is switched on.
    if (body.check_invoice) {
      if (!SERVICEM8_API_KEY) return json({ ok: false, error: "No ServiceM8 key" }, 400);
      try {
        const c = await contactForJob(String(body.check_invoice).replace(/\D/g, ""));
        return json({ ok: true, check: c ? { found: true, has_phone: !!c.phone, has_email: !!c.email, has_first_name: !!c.first } : { found: false } });
      } catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 502); }
    }
    const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    if (body.ask && body.ask.job_id) {
      try {
        const p = await officeUser(sb, req);
        if (!p) return json({ ok: false, reason: "unauthorized" }, 401);
        return json(await askForReview(sb, String(body.ask.job_id), p.full_name || "Office", Date.now(), !!body.ask.again));
      } catch (e) { console.error("review-requests ask failed:", e); return json({ ok: false, reason: String((e as Error).message || e) }, 500); }
    }
    try {
      const mailbox = await isMailbox(body.id_token);
      // The script reports which emails it just sent from info@.
      if (mailbox && Array.isArray(body.email_sent) && body.email_sent.length) {
        await sb.from("review_requests").update({ email_sent_at: new Date().toISOString() }).in("id", body.email_sent.slice(0, 50).map(String));
      }
      // The info@ script also sends the recent week tabs: keep Jobs & Commissions in step with the sheet.
      const jobs = mailbox && Array.isArray(body.jobs) ? await syncSheetJobs(sb, body.jobs, Date.now()) : null;
      const result = await handle(sb, body.rows || [], Date.now());
      return json({ ok: true, ...result, mailbox, jobs, emails: mailbox && result.enabled ? await emailsToSend(sb, Date.now()) : [] });
    }
    catch (e) { console.error("review-requests failed:", e); return json({ error: String((e as Error).message || e) }, 500); }
  });
}
