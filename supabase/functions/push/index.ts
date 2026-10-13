// push: phone notifications for the owners (Ofek, 6 Oct 2026).
//
// The OPS app can be added to a phone's home screen; there each owner turns notifications on once per device and the
// app saves that device in public.push_subscriptions (each person can only see and remove his own devices). This
// function sends to them. POST with the signed-in person's token, { step, ... }:
//   key      → the public key a device subscribes with. The key pair is made here on first use and kept in
//              public.app_keys, which has no access rules, so only this function (service role) can read it — no key
//              is ever typed in by a person.
//   invoice  → { week, person }: a technician's commission invoice for that pay week is in → every owner's devices get
//              "you can pay <person>". Only that technician or an owner/manager may ask, and only when the invoice is
//              really on the week's row.
//   test     → the caller's own devices get a test notification (owners and managers).
//   selftest → builds one encrypted, signed message for a made-up device without sending it, to prove the sending
//              code works here (owners and managers).
//   scan     → (every 10 minutes, from pg_cron; added 12 Oct) the news switched on in Settings → Notifications
//              (settings.catalog.notify), each sent once: a new lead, a new lead still untouched after 15 minutes, a missed
//              call, a job that has just turned 7 days unpaid, an employee document expiring within 30 days. To the owners,
//              and to the office (VA and managers) when chosen. Anyone may call it: it only ever sends what push_sent hasn't
//              recorded yet, and does nothing while everything is switched off.
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
export function weekText(week: string): string {
  const [y, m, d] = week.split("-").map(Number);
  const a = new Date(Date.UTC(y, m - 1, d)), b = new Date(Date.UTC(y, m - 1, d + 6));
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

// ── scan: news for the phones (Settings → Notifications) ──
export const NOTIFY_KINDS = ["newLead", "leadWaiting", "missedCall", "unpaid", "docExpiry"];
const DOC_LABEL: Record<string, string> = { license: "driver licence", passport: "passport", visa: "visa", heights: "working-at-heights ticket", arc: "refrigerant licence", insurance: "public liability insurance" };
export function sydParts(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
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
// deno-lint-ignore no-explicit-any
export async function scan(sb: any, nowMs: number) {
  const { data: st } = await sb.from("settings").select("catalog, unpaid_reminder_days").eq("id", 1).single();
  const N = (st && st.catalog && st.catalog.notify) || {};
  const R = notifyRules(N, st && st.unpaid_reminder_days);
  const on = (k: string) => !!(N[k] && N[k].on);
  if (!NOTIFY_KINDS.some(on)) return { ok: true, off: true, sent: 0 };
  // one scan at a time: the first call in each 8-minute window claims it
  const { error: busy } = await sb.from("push_sent").insert({ key: `scan:${Math.floor(nowMs / (8 * 60000))}` });
  if (busy) return { ok: true, busy: true, sent: 0 };
  const now = sydParts(nowMs), today = now.day;
  // deno-lint-ignore no-explicit-any
  const events: { key: string; kind: string; payload: any }[] = [];
  if (on("newLead") || on("leadWaiting")) {
    const { data: leads } = await sb.from("contacts").select("id, full_name, division, source, status, created_at, contacted_at, last_read_at, tags, messages, reopened_at").gte("created_at", shiftDay(today, -1));
    for (const c of leads || []) {
      const at = arrivedAt(c); if (!at || TEST_TAG(c.tags)) continue;
      const atMs = Date.parse(at), age = nowMs - atMs;
      if (!(age >= 0 && age < 6 * 3600e3)) continue;   // only what came in in the last 6 hours, never a backlog
      const what = [c.division, c.source].filter(Boolean).join(" · ");
      if (on("newLead")) events.push({ key: `lead:${c.id}:${at}`, kind: "newLead", payload: { title: `New lead: ${c.full_name || "no name"}`, body: what || "A new enquiry came in.", url: `${APP_URL}?tab=crm`, tag: `lead-${c.id}` } });
      const touched = (c.status && c.status !== "New") || (c.contacted_at && Date.parse(c.contacted_at) >= atMs) || (c.last_read_at && Date.parse(c.last_read_at) >= atMs);
      if (on("leadWaiting") && !touched && age >= R.waitMinutes * 60000 && now.hour >= R.from && now.hour < R.until) events.push({ key: `waiting:${c.id}:${at}`, kind: "leadWaiting", payload: { title: `Waiting ${R.waitMinutes}+ minutes: ${c.full_name || "a new lead"}`, body: `Nobody has picked up this ${c.division || ""} lead yet.`.replace("  ", " "), url: `${APP_URL}?tab=crm`, tag: `waiting-${c.id}` } });
    }
  }
  if (on("missedCall")) {
    const { data: calls } = await sb.from("calls").select("id, from_number, missed, started_at, division").eq("missed", true).gte("started_at", new Date(nowMs - 6 * 3600e3).toISOString());
    for (const c of calls || []) events.push({ key: `call:${c.id}`, kind: "missedCall", payload: { title: "Missed call", body: `${c.from_number || "A caller"}${c.division ? " · " + c.division : ""}. Call them back.`, url: `${APP_URL}?tab=myDay`, tag: `call-${c.id}` } });
  }
  if (on("unpaid")) {
    const { data: jobs } = await sb.from("jobs").select("id, customer_name, amount, date, payment_status").eq("payment_status", "Unpaid").eq("date", shiftDay(today, -R.unpaidDays));
    for (const j of jobs || []) events.push({ key: `unpaid:${j.id}`, kind: "unpaid", payload: { title: `${R.unpaidDays === 7 ? "Unpaid for a week" : `Unpaid for ${R.unpaidDays} days`}: ${j.customer_name || "a job"}`, body: `$${Number(j.amount || 0).toLocaleString("en-AU")} from ${j.date}. Time to chase it.`, url: `${APP_URL}?tab=outstanding`, tag: `unpaid-${j.id}` } });
  }
  if (on("docExpiry")) {
    const { data: emps } = await sb.from("employees").select("id, name, status, documents");
    for (const e of emps || []) {
      if (e.status !== "Active") continue;
      for (const [kind, d] of Object.entries(e.documents || {})) {
        // deno-lint-ignore no-explicit-any
        const exp = (d as any) && (d as any).expiry; if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) continue;
        if (exp < today || exp > shiftDay(today, R.docDays)) continue;
        events.push({ key: `doc:${e.id}:${kind}:${exp}`, kind: "docExpiry", payload: { title: `${e.name}'s ${DOC_LABEL[kind] || kind} expires soon`, body: `On ${exp}. Ask for the new one.`, url: `${APP_URL}?tab=reference`, tag: `doc-${e.id}-${kind}` } });
      }
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
    const to = [...owners, ...(N[ev.kind] && N[ev.kind].office ? office : [])];
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
    const r = await sendTo(sb, [me.id], { title: "Notifications are on", body: "This phone will get the notifications that are switched on in Settings → Notifications.", url: APP_URL + "?tab=payroll", tag: "test" }, await vapidKeys(sb));
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
    const r = await sendTo(sb, (owners || []).map((o: any) => o.id), {
      title: `Invoice in: ${person}`,
      body: `${person} sent his commission invoice for ${weekText(week)}. You can pay him.`,
      url: `${APP_URL}?tab=payroll&week=${week}`,
      tag: `invoice-${week}-${person}`,
    }, await vapidKeys(sb));
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
