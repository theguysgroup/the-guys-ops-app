// conversations: the website chat and customer text messages, inside OPS (Ofek, 3 Oct 2026). Replaces GHL's chat
// widget and its 3 chat workflows, so the office can leave GHL. Spec: memory project_ops_chat_sms_spec.md.
//
// The website chat (site-chat/chat-v4.js with transport 'ops') talks to this function directly:
//   chat_start  name + phone + service → a CRM card (through intake-lead, so returning customers keep their card and
//               their name), a chat session, the customer's first message, and an email to the office.
//   chat_send   another message from the customer.        chat_poll   Ron's replies for the customer's window.
// The app (signed-in office staff):
//   reply       Ron answers by website chat, SMS or WhatsApp (the business number, the same one the phone line uses), or
//               email (queued here, sent from info@ by the info@ Apps Script within a minute).
//   daily_report  Ron's end-of-day report (sent when he logs out) → WhatsApp to the owners, or by email until WhatsApp is on.
// Twilio (signed webhooks): sms_in (a customer's text, STOP/START), sms_status (delivery).
// The info@ Apps Script, every minute: alerts — the new-chat emails, handed only to the verified info@ mailbox, which
//   sends them to itself (so the office gets the email within a minute, from its own address).
// A scheduler every minute: tick — the automatic text when Ron hasn't answered a chat in 5 minutes:
//   • office open (Mon–Fri 08:00–17:00 Sydney, no public holidays — Ofek 3/10): a human "I'm on another call" text;
//   • office closed: "I'll call you first thing when our office opens".
//   "Answered" = any reply from the office in the chat or by SMS, or an outgoing call to the customer that connected.
//   At most one automatic text per phone per 24 hours, mobiles only, never to a number that sent STOP, and only
//   while settings.chat_auto_sms is on.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : "") || "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const INTAKE_SECRET = env("INTAKE_SHARED_SECRET");
const ACCOUNT_SID = env("TWILIO_ACCOUNT_SID");
const AUTH_TOKEN = env("TWILIO_AUTH_TOKEN");
const BUSINESS_NUMBER = env("TWILIO_NUMBER");
const WHATSAPP_FROM = env("TWILIO_WHATSAPP_FROM");        // the WhatsApp sender approved on Twilio, e.g. +614…
const SELF_URL = env("CONVERSATIONS_FUNCTION_URL");       // https://<project>.supabase.co/functions/v1/conversations (Twilio signs this exact URL)
const MAILBOX = "info@theguyservicegroup.com";
const TEST_PHONES = ["+61418638552"];                     // the only number Ofek approved for real test texts

// ── approved texts (Ofek). {hi} = "Hi Sarah" or "Hi there" when there is no first name ──
const SMS_CLOSED = "{hi}, it's Ron from {brand}. You sent us a message on our website chat about {service}. I'll call you first thing when our office opens, or you can reply here.";
// Approved by Ofek 3/10 (the longer of the two versions). Live once settings.chat_auto_sms is switched on.
const SMS_OPEN = "{hi}, Ron here from {brand}. I saw your message about {service} - I'm just finishing up another call and will get back to you very shortly. Feel free to reply here in the meantime.";
// Ron's one-click intro when he moves a chat to SMS (he can edit it before sending).
const INTRO = "{hi}, it's Ron from {brand}. You sent us a message on our website chat about {service}. I'll give you a call shortly, or you can reply here.";

// The chat's service choices → the brand and the words used in the texts (Ofek 2/10).
const SERVICES: Record<string, { text: string; brand: string; division: string }> = {
  split: { text: "aircon split system cleaning", brand: "The AC Cleaning Guys", division: "Aircon" },
  ducted: { text: "ducted aircon cleaning", brand: "The AC Cleaning Guys", division: "Aircon" },
  chimney: { text: "chimney cleaning", brand: "The Chimney Guys", division: "Chimney" },
  pw: { text: "pressure washing", brand: "The Pressure Washing Guys", division: "Pressure Washing" },
  other: { text: "", brand: "The Guys Group", division: "Other" },
};
const serviceOf = (key: unknown) => SERVICES[String(key)] || SERVICES.other;
const BRANDS: Record<string, string> = { Aircon: "The AC Cleaning Guys", Chimney: "The Chimney Guys", "Pressure Washing": "The Pressure Washing Guys" };

const ORIGINS = ["https://theguyservicegroup.com", "https://www.theguyservicegroup.com", "https://theguysgroup.github.io"];
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const twiml = () => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, { headers: { "Content-Type": "text/xml" } });

// ── phones: E.164 (+61…); the last 9 digits are the CRM key ──
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

// ── Sydney time and office hours ──
export function sydney(nowMs: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)) };
}
export function officeOpen(nowMs: number): boolean {
  const t = sydney(nowMs);
  return t.dow >= 1 && t.dow <= 5 && t.minutes >= 8 * 60 && t.minutes < 17 * 60;
}

// ── texts ──
export function cleanFirstName(name: unknown): string {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  if (!/\p{L}/u.test(first) || first.length > 30 || /\d/.test(first)) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}
export function fill(template: string, s: { first_name?: string; brand?: string; service_text?: string }): string {
  const first = cleanFirstName(s.first_name);
  return template
    .replace("{hi}", first ? `Hi ${first}` : "Hi there")
    .replace("{brand}", s.brand || "The Guys Group")
    .replace("{service}", s.service_text || "your enquiry");
}
export const introFor = (s: { first_name?: string; brand?: string; service_text?: string }) => fill(INTRO, s);

// ── small helpers ──
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const validName = (n: string) => /\p{L}/u.test(n) && n.length <= 40 && !/\d{3,}/.test(n);

// ── Twilio ──
async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)))));
}
export async function twilioSignatureOk(url: string, params: Record<string, string>, signature: string, token = AUTH_TOKEN): Promise<boolean> {
  if (!token || !signature) return false;
  const expected = await hmacSha1Base64(token, url + Object.keys(params).sort().map((k) => k + params[k]).join(""));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
type SendResult = { ok: boolean; sid?: string; error?: string };
// Swappable in tests.
export const io = {
  async sendSms(to: string, body: string): Promise<SendResult> {
    if (!ACCOUNT_SID || !AUTH_TOKEN || !BUSINESS_NUMBER) return { ok: false, error: "sms_not_set_up" };
    const params: Record<string, string> = { To: to, From: BUSINESS_NUMBER, Body: body };
    if (SELF_URL) params.StatusCallback = `${SELF_URL}?step=sms_status`;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, sid: out.sid } : { ok: false, error: String(out.message || res.status) };
  },
  async sendWhatsApp(to: string, body: string): Promise<SendResult> {
    if (!ACCOUNT_SID || !AUTH_TOKEN || !WHATSAPP_FROM) return { ok: false, error: "whatsapp_not_set_up" };
    const params: Record<string, string> = { To: "whatsapp:" + to, From: "whatsapp:" + WHATSAPP_FROM, Body: body };
    if (SELF_URL) params.StatusCallback = `${SELF_URL}?step=sms_status`;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, sid: out.sid } : { ok: false, error: String(out.message || res.status) };
  },
  // The card goes through intake-lead, so the website form and the chat follow exactly the same rules
  // (returning customer → same card, the old name kept and the new one noted, GHL archive note, ad source).
  async intake(fields: Record<string, string>): Promise<{ id: string; attached?: string } | null> {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/intake-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-intake-secret": INTAKE_SECRET },
      body: JSON.stringify(fields),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok && out.id ? { id: out.id, attached: out.attached } : null;
  },
  // True only when Google confirms the token belongs to the business mailbox (checked with Google, not by us).
  async isMailbox(idToken: unknown): Promise<boolean> {
    if (typeof idToken !== "string" || idToken.length < 20) return false;
    try {
      const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!r.ok) return false;
      const t = await r.json();
      return String(t.email || "").toLowerCase() === MAILBOX && String(t.email_verified) === "true" && Number(t.exp) * 1000 > Date.now();
    } catch { return false; }
  },
};

// ── opt-outs (STOP) ──
// deno-lint-ignore no-explicit-any
async function optedOut(sb: any, e164: string): Promise<boolean> {
  const { data } = await sb.from("sms_opt_outs").select("phone_key").eq("phone_key", phoneKey(e164)).limit(1);
  return !!(data && data.length);
}

// ── CRM card for a phone (newest card wins, as in intake-lead and voice) ──
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

// ── chat: start ──
// deno-lint-ignore no-explicit-any
export async function chatStart(sb: any, body: any, ip: string, nowMs: number) {
  const name = clip(body.name, 40);
  const e164 = toE164(body.phone);
  if (!validName(name)) return { ok: false, reason: "bad_name" };
  if (!e164 || !/^\+61[2-478]\d{8}$|^\+611[38]00\d{6}$/.test(e164)) return { ok: false, reason: "bad_phone" };
  const key = String(body.service || "other");
  const svc = serviceOf(key);
  const test = body.test === true;
  const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const ipHash = ip ? await sha256("ip:" + ip) : "";
  // Abuse limits: a real customer never starts 5 chats a day from one phone or 15 from one connection.
  const { count: byPhone } = await sb.from("chat_sessions").select("id", { count: "exact", head: true }).eq("phone", e164).gte("created_at", since);
  if ((byPhone || 0) >= 5) return { ok: false, reason: "limit" };
  if (ipHash) {
    const { count: byIp } = await sb.from("chat_sessions").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since);
    if ((byIp || 0) >= 15) return { ok: false, reason: "limit" };
  }
  const first = svc.text ? `Hi, I'd like a quote for ${svc.text}.` : "Hi, I'd like a quote.";
  const a = body.attribution && typeof body.attribution === "object" ? body.attribution : {};
  const page = clip(body.page, 300);

  let contactId: string | null = null, attached = "";
  if (test) {
    // A test never touches the lead numbers: its own card, marked TEST, deleted after the test.
    const { data, error } = await sb.from("contacts").insert({
      full_name: `TEST - ${name}`, phone: pretty(e164), email: "", postcode: "", division: svc.division, source: "Unknown", status: "New",
      created_at: sydney(nowMs).day, job_description: `Website chat (test): ${svc.text || "something else"}`, tags: ["Test"],
      messages: [{ id: crypto.randomUUID(), kind: "event", text: "TEST card from the website chat — delete after the test", at: new Date(nowMs).toISOString() }],
    }).select("id").single();
    if (error) throw error;
    contactId = data.id;
  } else {
    const r = await io.intake({
      full_name: name, phone: pretty(e164), email: "", postcode: "", division: svc.division,
      job_description: `Website chat: ${svc.text || "something else"}`, lead_channel: "chat",
      utm_source: clip(a.utm_source, 200), utm_medium: clip(a.utm_medium, 200), utm_campaign: clip(a.utm_campaign, 200),
      utm_term: clip(a.utm_term, 200), utm_content: clip(a.utm_content, 200), landing_page: clip(a.landing_page, 300),
      referrer_domain: clip(a.referrer_domain, 200), gclid: clip(a.gclid, 300), fbclid: clip(a.fbclid, 300),
      gbraid: clip(a.gbraid, 300), wbraid: clip(a.wbraid, 300), submission_page: page,
    }).catch((e) => { console.error("intake-lead call failed:", e); return null; });
    if (r) { contactId = r.id; attached = r.attached || ""; }
    // intake-lead down: the chat still works and is kept; the office alert says the card is missing.
  }
  // The office email (Ofek 3/10: straight away): written now, sent by the info@ mailbox within a minute.
  const alertSubject = `${test ? "[TEST] " : ""}New website chat lead - ${name} ${pretty(e164)}`;
  const alertBody = [
    "New lead from the website live chat.", `Name: ${name}`, `Phone: ${pretty(e164)}`, `Message: ${first}`, `Page: ${page || "-"}`,
    `Source: ${[a.utm_source, a.utm_medium].filter(Boolean).join(" / ") || (a.gclid || a.gbraid || a.wbraid ? "Google Ads (click id)" : "-")}`,
    `Campaign: ${a.utm_campaign || "-"}`,
    attached === "returning" ? "Returning customer: added to their existing card." : attached === "repeat" ? "Same person again today: added to their card." : "",
    contactId ? "Reply to the customer in OPS > CRM." : "The CRM card could not be created. Please add it by hand.",
  ].filter(Boolean).join("\n");
  const token = newToken();
  const { data: s, error } = await sb.from("chat_sessions").insert({
    token_hash: await sha256(token), contact_id: contactId, first_name: cleanFirstName(name), full_name: name, phone: e164,
    service_key: SERVICES[key] ? key : "other", brand: svc.brand, service_text: svc.text || "your enquiry", first_message: first,
    page, test, ip_hash: ipHash || null, created_at: new Date(nowMs).toISOString(), alert_subject: alertSubject, alert_body: alertBody,
  }).select("*").single();
  if (error) throw error;
  await sb.from("lead_messages").insert({ contact_id: contactId, session_id: s.id, channel: "chat", direction: "in", body: first, author: name, phone: e164, at: new Date(nowMs).toISOString() });
  return { ok: true, session: s.id, token };
}

// deno-lint-ignore no-explicit-any
async function sessionFor(sb: any, body: any, nowMs: number): Promise<any | null> {
  const id = String(body.session || ""), token = String(body.token || "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || token.length < 20) return null;
  const { data } = await sb.from("chat_sessions").select("*").eq("id", id).limit(1);
  const s = data && data[0];
  if (!s || s.token_hash !== (await sha256(token))) return null;
  if (nowMs - Date.parse(s.created_at) > 14 * 24 * 3600 * 1000) return null;   // a chat link lives two weeks
  return s;
}

// ── chat: the customer writes again ──
// deno-lint-ignore no-explicit-any
export async function chatSend(sb: any, body: any, nowMs: number) {
  const s = await sessionFor(sb, body, nowMs);
  if (!s) return { ok: false, reason: "session" };
  const text = String(body.text || "").trim().slice(0, 1000);
  if (!text) return { ok: false, reason: "empty" };
  const { count } = await sb.from("lead_messages").select("id", { count: "exact", head: true }).eq("session_id", s.id).eq("direction", "in");
  if ((count || 0) >= 40) return { ok: false, reason: "limit" };
  const at = new Date(nowMs).toISOString();
  await sb.from("lead_messages").insert({ contact_id: s.contact_id, session_id: s.id, channel: "chat", direction: "in", body: text, author: s.full_name, phone: s.phone, at });
  const patch: Record<string, unknown> = { last_visitor_at: at };
  // The first thing written after the phone is the job details: it also goes on the card's job description.
  if (!s.details) {
    patch.details = text.slice(0, 500);
    if (s.contact_id) {
      const { data: c } = await sb.from("contacts").select("job_description").eq("id", s.contact_id).single();
      const base = `Website chat: ${s.service_key === "other" ? "something else" : s.service_text}`;
      if (c && (!c.job_description || c.job_description === base)) await sb.from("contacts").update({ job_description: `${base}. ${text.slice(0, 500)}` }).eq("id", s.contact_id);
    }
  }
  await sb.from("chat_sessions").update(patch).eq("id", s.id);
  return { ok: true };
}

// ── chat: Ron's replies for the customer's window ──
// deno-lint-ignore no-explicit-any
export async function chatPoll(sb: any, body: any, nowMs: number) {
  const s = await sessionFor(sb, body, nowMs);
  if (!s) return { ok: false, reason: "session" };
  let q = sb.from("lead_messages").select("id, body, at, author").eq("session_id", s.id).eq("channel", "chat").eq("direction", "out");
  if (body.after) q = q.gt("at", String(body.after));
  const { data } = await q.order("at").limit(50);
  // deno-lint-ignore no-explicit-any
  return { ok: true, messages: (data || []).map((m: any) => ({ id: m.id, text: m.body, at: m.at, author: "Ron" })) };
}

// ── the office answers (from the app) ──
// deno-lint-ignore no-explicit-any
export async function reply(sb: any, user: any, body: any, nowMs: number) {
  const contactId = String(body.contact_id || "");
  const text = String(body.text || "").trim().slice(0, 1200);
  const channel = ["sms", "whatsapp", "email"].includes(body.channel) ? body.channel : "chat";
  if (!contactId || !text) return { ok: false, reason: "empty" };
  const { data: c } = await sb.from("contacts").select("id, full_name, phone, email, division").eq("id", contactId).single();
  if (!c) return { ok: false, reason: "no_contact" };
  const at = new Date(nowMs).toISOString();
  const author = user.full_name || "Office";
  if (channel === "chat") {
    const since = new Date(nowMs - 14 * 24 * 3600 * 1000).toISOString();
    const { data: ss } = await sb.from("chat_sessions").select("id").eq("contact_id", contactId).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
    const s = ss && ss[0];
    if (!s) return { ok: false, reason: "no_chat" };
    await sb.from("lead_messages").insert({ contact_id: contactId, session_id: s.id, channel: "chat", direction: "out", body: text, author, author_id: user.id, at });
    await sb.from("chat_sessions").update({ last_staff_at: at }).eq("id", s.id);
    return { ok: true, channel };
  }
  if (channel === "email") {
    // Queued here; the info@ mailbox sends it within a minute (same route as the new-chat emails), so it comes from
    // the business address the customer knows. Their reply lands in the info@ inbox.
    const email = String(body.email || c.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "no_email" };
    const brand = BRANDS[c.division] || "The Guys Service Group";
    await sb.from("lead_messages").insert({ contact_id: contactId, channel: "email", direction: "out", body: text, subject: `Your enquiry - ${brand}`, author, author_id: user.id, email, status: "queued", at });
    return { ok: true, channel, queued: true };
  }
  const to = toE164(body.phone || c.phone);
  if (!isMobile(to)) return { ok: false, reason: "not_mobile" };
  if (await optedOut(sb, to)) return { ok: false, reason: "opted_out" };
  if (channel === "whatsapp") {
    const { data: st } = await sb.from("settings").select("whatsapp_enabled").limit(1);
    if (!(st && st[0] && st[0].whatsapp_enabled)) return { ok: false, reason: "whatsapp_not_set_up" };
    const w = await io.sendWhatsApp(to, text);
    if (!w.ok && w.error === "whatsapp_not_set_up") return { ok: false, reason: "whatsapp_not_set_up" };
    await sb.from("lead_messages").insert({ contact_id: contactId, channel: "whatsapp", direction: "out", body: text, author, author_id: user.id, phone: to, status: w.ok ? "sent" : "failed", provider_sid: w.sid || null, error: w.error || null, at });
    return w.ok ? { ok: true, channel } : { ok: false, reason: w.error || "whatsapp_failed" };
  }
  const r = await io.sendSms(to, text);
  if (!r.ok && r.error === "sms_not_set_up") return { ok: false, reason: "sms_not_set_up" };   // nothing was tried, nothing to log
  await sb.from("lead_messages").insert({ contact_id: contactId, channel: "sms", direction: "out", body: text, author, author_id: user.id, phone: to, status: r.ok ? "sent" : "failed", provider_sid: r.sid || null, error: r.error || null, at });
  return r.ok ? { ok: true, channel } : { ok: false, reason: r.error || "sms_failed" };
}

// ── the automatic text when a chat got no answer in 5 minutes (runs every minute) ──
// deno-lint-ignore no-explicit-any
export async function tick(sb: any, nowMs: number) {
  const out = { sent: 0, skipped: 0, waiting: 0 };
  // No secret needed: a run only does what is already due, and runs closer than 40 seconds apart are ignored.
  const { data: st } = await sb.from("settings").select("id, chat_auto_sms, chat_tick_at").limit(1);
  const set = st && st[0];
  if (!set || !set.chat_auto_sms) return { ...out, off: true };
  if (set.chat_tick_at && nowMs - Date.parse(set.chat_tick_at) < 40 * 1000) return { ...out, busy: true };
  await sb.from("settings").update({ chat_tick_at: new Date(nowMs).toISOString() }).eq("id", set.id);
  const from = new Date(nowMs - 2 * 3600 * 1000).toISOString(), to = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const { data: due } = await sb.from("chat_sessions").select("*").is("auto_sms_at", null).is("auto_sms_skip", null).gte("created_at", from).lte("created_at", to).order("created_at").limit(20);
  for (const s of due || []) {
    const skip = async (why: string) => { await sb.from("chat_sessions").update({ auto_sms_skip: why }).eq("id", s.id); out.skipped++; };
    const created = s.created_at;
    // Ron answered: any message from the office to this customer since the chat started, by chat or SMS…
    const ans = sb.from("lead_messages").select("id, status").eq("direction", "out").eq("auto", false).gte("at", created);
    const { data: replies } = await (s.contact_id ? ans.eq("contact_id", s.contact_id) : ans.eq("session_id", s.id));
    // deno-lint-ignore no-explicit-any
    if ((replies || []).some((m: any) => m.status !== "failed" && m.status !== "undelivered")) { await skip("answered"); continue; }   // a text that never arrived isn't an answer
    // …or a call to them that connected.
    const { data: calls } = await sb.from("calls").select("id, status, duration").eq("direction", "outbound").eq("to_number", s.phone).gte("created_at", created);
    // deno-lint-ignore no-explicit-any
    if ((calls || []).some((c: any) => Number(c.duration) > 0 || c.status === "completed" || c.status === "answered")) { await skip("called"); continue; }
    if (!isMobile(s.phone)) { await skip("not_mobile"); continue; }
    if (s.test && !TEST_PHONES.includes(s.phone)) { await skip("test"); continue; }
    if (await optedOut(sb, s.phone)) { await skip("opted_out"); continue; }
    const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
    const { count: recent } = await sb.from("lead_messages").select("id", { count: "exact", head: true }).eq("phone", s.phone).eq("auto", true).eq("channel", "sms").gte("at", since);
    if ((recent || 0) > 0) { await skip("one_a_day"); continue; }
    const open = officeOpen(nowMs);
    const text = fill(open ? SMS_OPEN : SMS_CLOSED, s);
    const r = await io.sendSms(s.phone, text);
    if (!r.ok && r.error === "sms_not_set_up") { out.waiting++; continue; }   // tried again next minute, until the 2 hours are up
    const at = new Date(nowMs).toISOString();
    await sb.from("lead_messages").insert({ contact_id: s.contact_id, session_id: s.id, channel: "sms", direction: "out", body: text, author: "Ron (automatic)", auto: true, phone: s.phone, status: r.ok ? "sent" : "failed", provider_sid: r.sid || null, error: r.error || null, at });
    await sb.from("chat_sessions").update(r.ok ? { auto_sms_at: at, auto_sms_kind: open ? "open" : "closed" } : { auto_sms_skip: "failed" }).eq("id", s.id);
    if (r.ok) out.sent++; else out.skipped++;
  }
  return out;
}

// ── the new-chat emails, for the info@ mailbox only ──
// deno-lint-ignore no-explicit-any
export async function alerts(sb: any, body: any, nowMs: number) {
  if (!(await io.isMailbox(body.id_token))) return { ok: false, reason: "unauthorized" };
  const sent = Array.isArray(body.sent) ? body.sent.map(String).slice(0, 50) : [];
  const at = new Date(nowMs).toISOString();
  for (const id of sent) {
    if (id.startsWith("m:")) await sb.from("lead_messages").update({ status: "sent" }).eq("id", id.slice(2)).eq("status", "queued");
    else await sb.from("chat_sessions").update({ alert_sent_at: at }).eq("id", id).is("alert_sent_at", null);
  }
  const since = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const { data } = await sb.from("chat_sessions").select("id, alert_subject, alert_body").is("alert_sent_at", null).gte("created_at", since).order("created_at").limit(20);
  const { data: queued } = await sb.from("lead_messages").select("id, email, subject, body, author").eq("channel", "email").eq("status", "queued").gte("at", since).order("at").limit(20);
  const sign = (m: { author?: string; email?: string }) => m.email === MAILBOX ? "" : `\n\n${String(m.author || "Ron").split(" ")[0]}\nThe Guys Service Group\n1300 380 090`;
  return { ok: true, emails: [
    // deno-lint-ignore no-explicit-any
    ...(data || []).filter((r: any) => r.alert_subject).map((r: any) => ({ id: r.id, to: MAILBOX, subject: r.alert_subject, text: r.alert_body })),
    // deno-lint-ignore no-explicit-any
    ...(queued || []).filter((m: any) => m.email).map((m: any) => ({ id: "m:" + m.id, to: m.email, subject: m.subject || "The Guys Service Group", text: m.body + sign(m) })),
  ] };
}

// ── Ron's end-of-day report (Ofek 3/10): when Ron logs out, to the owners on WhatsApp; by email until WhatsApp is on ──
// deno-lint-ignore no-explicit-any
export async function dailyReport(sb: any, user: any, body: any, nowMs: number) {
  const day = String(body.day || "");
  const text = String(body.text || "").trim().slice(0, 3500);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !text) return { ok: false, reason: "empty" };
  const { data: row } = await sb.from("myday_days").select("day, report_sent_at").eq("day", day).limit(1);
  if (row && row[0] && row[0].report_sent_at) return { ok: true, already: true };   // once a day, even if Ron logs out twice
  const { data: st } = await sb.from("settings").select("daily_report_to, whatsapp_enabled").limit(1);
  const to = (st && st[0] && Array.isArray(st[0].daily_report_to) ? st[0].daily_report_to : []).map((r: { whatsapp?: string }) => toE164(r.whatsapp)).filter(Boolean);
  const at = new Date(nowMs).toISOString();
  let via = "email";
  if (st && st[0] && st[0].whatsapp_enabled && to.length) {
    const results = [];
    for (const n of to) results.push(await io.sendWhatsApp(n, text));
    if (results.some((r) => r.ok)) via = "whatsapp";
  }
  if (via === "email") await sb.from("lead_messages").insert({ contact_id: null, channel: "email", direction: "out", body: text, subject: `Daily report ${day}`, author: user.full_name || "Ron", email: MAILBOX, status: "queued", at });
  await sb.from("myday_days").upsert({ day, report_sent_at: at }, { onConflict: "day", ignoreDuplicates: false });
  return { ok: true, via };
}

// ── a customer's text to the business number ──
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT OUT"];
const START_WORDS = ["START", "UNSTOP", "YES"];
// deno-lint-ignore no-explicit-any
export async function smsIn(sb: any, p: Record<string, string>, nowMs: number) {
  const from = toE164(p.From);
  const text = String(p.Body || "").trim().slice(0, 1600);
  if (!from) return { ok: false };
  const word = text.toUpperCase().replace(/[^A-Z ]/g, "").trim();
  const at = new Date(nowMs).toISOString();
  if (STOP_WORDS.includes(word)) await sb.from("sms_opt_outs").upsert({ phone_key: phoneKey(from), phone: from, at, source: "sms" });
  else if (START_WORDS.includes(word) && (await optedOut(sb, from))) await sb.from("sms_opt_outs").delete().eq("phone_key", phoneKey(from));
  let c = await findContact(sb, from);
  if (!c) {
    const { data, error } = await sb.from("contacts").insert({
      full_name: `Text from ${pretty(from)}`, phone: pretty(from), email: "", postcode: "", division: "Other", source: "Unknown", status: "New",
      created_at: sydney(nowMs).day, job_description: "", tags: [],
      messages: [{ id: crypto.randomUUID(), kind: "event", text: "Lead created automatically from a text message", at }],
    }).select("id, full_name").single();
    if (error) throw error;
    c = data;
  }
  await sb.from("lead_messages").insert({ contact_id: c.id, channel: "sms", direction: "in", body: text || "(empty message)", author: c.full_name, phone: from, status: "received", provider_sid: p.MessageSid || null, at });
  return { ok: true, contact_id: c.id };
}

// ── office users: signed in with CRM access ──
// deno-lint-ignore no-explicit-any
async function officeUser(sb: any, req: Request): Promise<any | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: u } = await sb.auth.getUser(jwt);
  if (!u || !u.user) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role, permissions").eq("id", u.user.id).single();
  if (!p) return null;
  return p.role === "owner" || p.role === "manager" || (p.role === "va" && p.permissions && p.permissions.crm) ? p : null;
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__CONV_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    if (req.method !== "POST") return json(req, { error: "method" }, 405);
    const url = new URL(req.url);
    const step = url.searchParams.get("step") || "";
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const now = Date.now();
    try {
      if (step === "sms_in" || step === "sms_status") {
        const params = Object.fromEntries(new URLSearchParams(await req.text()));
        if (!(await twilioSignatureOk(`${SELF_URL}${url.search}`, params, req.headers.get("x-twilio-signature") || ""))) return new Response("forbidden", { status: 403 });
        if (step === "sms_in") await smsIn(sb, params, now);
        else if (params.MessageSid) await sb.from("lead_messages").update({ status: String(params.MessageStatus || "").slice(0, 20), error: params.ErrorCode ? `Twilio ${params.ErrorCode}` : null }).eq("provider_sid", params.MessageSid);
        return twiml();
      }
      if (step === "tick") return json(req, await tick(sb, now));
      if (step === "alerts") return json(req, await alerts(sb, await req.json().catch(() => ({})), now));
      const body = await req.json().catch(() => ({}));
      if (step === "daily_report") {
        const user = await officeUser(sb, req);
        if (!user) return json(req, { error: "unauthorized" }, 401);
        return json(req, await dailyReport(sb, user, body, now));
      }
      if (step === "reply") {
        const user = await officeUser(sb, req);
        if (!user) return json(req, { error: "unauthorized" }, 401);
        return json(req, await reply(sb, user, body, now));
      }
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
      if (step === "chat_start") return json(req, await chatStart(sb, body, ip, now));
      if (step === "chat_send") return json(req, await chatSend(sb, body, now));
      if (step === "chat_poll") return json(req, await chatPoll(sb, body, now));
      return json(req, { error: "unknown step" }, 404);
    } catch (e) {
      console.error("conversations failed:", step, e);
      if (step === "sms_in") return twiml();
      return json(req, { error: "failed" }, 500);
    }
  });
}
