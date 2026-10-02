// voice: the business phone line on Twilio (Ofek, 1 Oct 2026). Replaces GHL's phone so the office can leave GHL.
//
// Twilio calls this function (webhooks, form-encoded, signed with X-Twilio-Signature) at each step of a call; the OPS
// app calls it for a browser-phone token. ?step= picks the step:
//   incoming      someone rang our number (the Telstra 1300 forwards here): short recording notice, then ring the office
//                 browser phones (Ron) for 20 seconds. The caller is matched to a CRM card by phone, or becomes a new lead.
//   after_office  nobody answered in the browser: ring Ofek's and Noam's mobiles together (OWNER_MOBILES) for 20 seconds.
//   after_owners  still nobody: a short goodbye, an SMS to the caller, and the call is marked missed (red call-back alert
//                 in the app until someone calls them back).
//   outbound      Ron calls a customer from the app: dial the number with the business number as caller ID.
//   status        the call ended: duration, answered or not, a note on the customer's card.
//   recording     the recording is ready: saved on the call (played through ?step=play, never a public link).
//   play          the app streams a recording (signed-in office users only).
//   token         the app asks for a browser-phone token (signed-in office users only).
// Every Twilio step checks the X-Twilio-Signature; anything unsigned is refused. Recording starts only after the
// "this call may be recorded" notice (Australian law requires notice).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const ACCOUNT_SID = env("TWILIO_ACCOUNT_SID");
const AUTH_TOKEN = env("TWILIO_AUTH_TOKEN");
const API_KEY_SID = env("TWILIO_API_KEY_SID");
const API_KEY_SECRET = env("TWILIO_API_KEY_SECRET");
const TWIML_APP_SID = env("TWILIO_TWIML_APP_SID");
const BUSINESS_NUMBER = env("TWILIO_NUMBER");             // +61… the number Twilio answers and shows as caller ID
const SELF_URL = env("VOICE_FUNCTION_URL");                // https://<project>.supabase.co/functions/v1/voice (signatures are over this exact URL)
const OWNER_MOBILES = env("OWNER_MOBILES").split(",").map((s) => toE164(s)).filter(Boolean);
const RING_SECONDS = 20;
const NOTICE = "Thanks for calling The Guys Service Group. This call may be recorded for quality and training.";
const MISSED_SAY = "Sorry we missed your call. We'll send you a text now and call you back shortly. Thank you.";
const MISSED_SMS = "Hi, it's The Guys Service Group. Sorry we missed your call! We'll call you back shortly. If it's easier, reply here with what you need and your suburb.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });

// ── phone numbers ──
// Australian numbers in E.164 (+61…); the last 9 digits are the key used everywhere in the CRM.
function toE164(v: unknown): string {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : "";
  d = d.replace(/\D/g, "");
  if (d.startsWith("61")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return /^\d{9}$/.test(d) ? "+61" + d : "";
}
function phoneKey(v: unknown): string { const d = String(v || "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(-9) : ""; }
function pretty(e164: string): string {
  const d = e164.startsWith("+61") ? "0" + e164.slice(3) : e164;
  if (/^04\d{8}$/.test(d)) return d.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
  if (/^0\d{9}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3");
  return d;
}
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stepUrl = (step: string) => `${SELF_URL}?step=${step}`;

// ── Twilio request signature (https://www.twilio.com/docs/usage/security#validating-requests) ──
async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}
async function twilioSignatureOk(url: string, params: Record<string, string>, signature: string): Promise<boolean> {
  if (!AUTH_TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = await hmacSha1Base64(AUTH_TOKEN, data);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ── browser-phone token (Twilio Access Token, HS256 JWT with a Voice grant) ──
const b64url = (s: string | Uint8Array) => btoa(typeof s === "string" ? unescape(encodeURIComponent(s)) : String.fromCharCode(...s)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function voiceToken(identity: string, nowSec: number): Promise<string> {
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${API_KEY_SID}-${nowSec}`, iss: API_KEY_SID, sub: ACCOUNT_SID, iat: nowSec, exp: nowSec + 3600,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: TWIML_APP_SID } } },
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(API_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}
// The browser phone of each office user is "office-<profile id>"; incoming calls ring every VA with CRM access.
const identityFor = (profileId: string) => `office-${profileId}`;

// ── CRM ──
// deno-lint-ignore no-explicit-any
async function findContact(sb: any, e164: string): Promise<any | null> {
  const key = phoneKey(e164);
  if (!key) return null;
  let best: any = null;
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await sb.from("contacts").select("id, full_name, phone, created_at, messages").order("id").range(from, from + 999);
    if (error) throw error;
    for (const c of data || []) if (phoneKey(c.phone) === key && (!best || String(c.created_at) > String(best.created_at))) best = c;
    if (!data || data.length < 1000) break;
  }
  return best;
}
// deno-lint-ignore no-explicit-any
async function addEvent(sb: any, contactId: string, text: string, unread = false) {
  const { data } = await sb.from("contacts").select("messages").eq("id", contactId).single();
  const msgs = Array.isArray(data?.messages) ? data.messages : [];
  const at = new Date().toISOString();
  msgs.push(unread ? { id: crypto.randomUUID(), kind: "message", direction: "in", auto: true, author: "Phone", text, at } : { id: crypto.randomUUID(), kind: "event", text, at });
  await sb.from("contacts").update({ messages: msgs }).eq("id", contactId);
}
const sydToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
// deno-lint-ignore no-explicit-any
async function contactForCaller(sb: any, e164: string): Promise<{ id: string; name: string; isNew: boolean } | null> {
  if (!e164) return null;
  const c = await findContact(sb, e164);
  if (c) return { id: c.id, name: c.full_name || pretty(e164), isNew: false };
  const row = {
    full_name: `Caller ${pretty(e164)}`, phone: pretty(e164), email: "", postcode: "", division: "Other", source: "Unknown", status: "New",
    created_at: sydToday(), job_description: "", tags: [],
    messages: [{ id: crypto.randomUUID(), kind: "event", text: "Lead created automatically from an incoming phone call", at: new Date().toISOString() }],
  };
  const { data, error } = await sb.from("contacts").insert(row).select("id").single();
  if (error) throw error;
  return { id: data.id, name: row.full_name, isNew: true };
}
// deno-lint-ignore no-explicit-any
async function officeIdentities(sb: any): Promise<string[]> {
  const { data } = await sb.from("profiles").select("id, role, permissions");
  // deno-lint-ignore no-explicit-any
  return (data || []).filter((p: any) => p.role === "va" && p.permissions && p.permissions.crm).map((p: any) => identityFor(p.id));
}
async function sendSms(to: string, body: string): Promise<boolean> {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !BUSINESS_NUMBER || !to) return false;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: BUSINESS_NUMBER, Body: body }).toString(),
  });
  return res.ok;
}
const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
const recordAttrs = () => `record="record-from-answer-dual" recordingStatusCallback="${esc(stepUrl("recording"))}" recordingStatusCallbackEvent="completed"`;

// ── the call steps (pure enough to test with a fake database) ──
// deno-lint-ignore no-explicit-any
export async function step(sb: any, name: string, p: Record<string, string>): Promise<Response> {
  const callSid = p.CallSid || "";
  if (name === "incoming") {
    const from = toE164(p.From);
    const c = await contactForCaller(sb, from);
    await sb.from("calls").insert({ call_sid: callSid, direction: "inbound", from_number: from || p.From || "", to_number: toE164(p.To) || p.To || "", contact_id: c ? c.id : null, status: "ringing" });
    const clients = await officeIdentities(sb);
    if (!clients.length) return xml(`<Say voice="Polly.Olivia" language="en-AU">${esc(NOTICE)}</Say><Redirect method="POST">${esc(stepUrl("after_office"))}</Redirect>`);
    const params = c ? `<Parameter name="contactId" value="${esc(c.id)}"/><Parameter name="callerName" value="${esc(c.name)}"/>` : "";
    return xml(`<Say voice="Polly.Olivia" language="en-AU">${esc(NOTICE)}</Say>` +
      `<Dial timeout="${RING_SECONDS}" answerOnBridge="true" ${recordAttrs()} action="${esc(stepUrl("after_office"))}">` +
      clients.map((id) => `<Client><Identity>${esc(id)}</Identity>${params}</Client>`).join("") + `</Dial>`);
  }
  if (name === "after_office" || name === "after_owners") {
    if (p.DialCallStatus === "completed") {
      await sb.from("calls").update({ status: "answered", answered_by: name === "after_office" ? "office" : "owner" }).eq("call_sid", callSid);
      return xml(`<Hangup/>`);
    }
    if (name === "after_office" && OWNER_MOBILES.length) {
      // The mobiles show the customer's number (Twilio allows the caller's own number when forwarding an incoming call).
      return xml(`<Dial timeout="${RING_SECONDS}" answerOnBridge="true" callerId="${esc(toE164(p.From) || BUSINESS_NUMBER)}" ${recordAttrs()} action="${esc(stepUrl("after_owners"))}">` +
        OWNER_MOBILES.map((n) => `<Number>${esc(n)}</Number>`).join("") + `</Dial>`);
    }
    // Nobody answered: say sorry, text the caller, and flag it for a call-back.
    const from = toE164(p.From);
    const smsOk = from && /^\+614/.test(from) ? await sendSms(from, MISSED_SMS) : false;
    await sb.from("calls").update({ status: "missed", missed: true, sms_sent: smsOk }).eq("call_sid", callSid);
    const { data: call } = await sb.from("calls").select("contact_id").eq("call_sid", callSid).single();
    if (call && call.contact_id) await addEvent(sb, call.contact_id, `📞 Missed call from ${pretty(from || p.From || "")}${smsOk ? " (sent them a text)" : ""}. Call them back.`, true);
    return xml(`<Say voice="Polly.Olivia" language="en-AU">${esc(MISSED_SAY)}</Say><Hangup/>`);
  }
  if (name === "outbound") {
    // Only our own browser phones may place calls, and only to real phone numbers.
    if (!/^client:office-/.test(p.From || "")) return xml(`<Reject/>`);
    const to = toE164(p.To);
    if (!to) return xml(`<Say voice="Polly.Olivia" language="en-AU">That number is not valid.</Say><Hangup/>`);
    const c = await findContact(sb, to);
    await sb.from("calls").insert({ call_sid: callSid, direction: "outbound", from_number: BUSINESS_NUMBER, to_number: to, contact_id: c ? c.id : null, status: "ringing", created_by: String(p.From).replace(/^client:/, "") });
    return xml(`<Dial callerId="${esc(BUSINESS_NUMBER)}" answerOnBridge="true" ${recordAttrs()}><Number>${esc(to)}</Number></Dial>`);
  }
  if (name === "status") {
    if (p.CallStatus !== "completed" && p.CallStatus !== "no-answer" && p.CallStatus !== "busy" && p.CallStatus !== "failed" && p.CallStatus !== "canceled") return xml("");
    const dur = Number(p.CallDuration || 0) || 0;
    const { data: call } = await sb.from("calls").select("*").eq("call_sid", callSid).single();
    if (!call) return xml("");
    const status = call.status === "missed" ? "missed" : call.status === "answered" ? "answered" : (call.direction === "outbound" ? (dur > 0 ? "answered" : "no answer") : call.status);
    await sb.from("calls").update({ status, duration: dur, ended_at: new Date().toISOString() }).eq("call_sid", callSid);
    if (call.contact_id && status !== "missed") {
      const who = call.direction === "outbound" ? "Outgoing call" : "Incoming call";
      await addEvent(sb, call.contact_id, `📞 ${who} ${status === "answered" ? `· ${fmtDur(dur)}` : `· ${status}`}`);
      if (status === "answered") await sb.from("contacts").update({ contacted_at: new Date().toISOString() }).eq("id", call.contact_id).is("contacted_at", null);
    }
    // Calling a missed caller back (and getting through) clears their missed call.
    if (call.direction === "outbound" && status === "answered" && call.to_number) {
      await sb.from("calls").update({ callback_done_at: new Date().toISOString() }).eq("missed", true).eq("from_number", call.to_number).is("callback_done_at", null);
    }
    return xml("");
  }
  if (name === "recording") {
    if (p.RecordingStatus && p.RecordingStatus !== "completed") return xml("");
    // A <Dial> recording callback carries the parent call's sid.
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
  const ok = p.role === "owner" || p.role === "manager" || (p.role === "va" && p.permissions && p.permissions.crm);
  return ok ? p : null;
}

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
      const signedUrl = `${SELF_URL}${url.search}`;
      if (!(await twilioSignatureOk(signedUrl, params, req.headers.get("x-twilio-signature") || ""))) return new Response("forbidden", { status: 403 });
      return await step(sb, name, params);
    } catch (e) {
      console.error("voice failed:", name, e);
      // Never leave a caller in silence: fall back to the missed-call message.
      if (name === "incoming" || name.startsWith("after_")) return xml(`<Say voice="Polly.Olivia" language="en-AU">${esc(MISSED_SAY)}</Say><Hangup/>`);
      return json({ error: "failed" }, 500);
    }
  });
}
