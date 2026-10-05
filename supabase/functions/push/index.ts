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
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, me: any) {
  const step = String(body?.step || "");
  if (step === "key") { const k = await vapidKeys(sb); return { status: 200, body: { ok: true, publicKey: k.publicKey } }; }
  if (!me) return { status: 401, body: { ok: false, reason: "unauthorized" } };

  if (step === "test") {
    if (!isOffice(me)) return { status: 403, body: { ok: false, reason: "owners only" } };
    const r = await sendTo(sb, [me.id], { title: "Notifications are on", body: "This phone will get a message when a technician sends his commission invoice.", url: APP_URL + "?tab=payroll", tag: "test" }, await vapidKeys(sb));
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
      const me = body.step === "key" ? null : await caller(sb, req);
      const r = await handle(sb, body, me);
      return json(r.body, r.status);
    } catch (e) {
      console.error("push failed:", e);
      return json({ ok: false, reason: String((e as Error).message || e) }, 500);
    }
  });
}
