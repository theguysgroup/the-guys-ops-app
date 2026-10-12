// team: the people who can sign in to OPS (Ofek, 12 Oct 2026: settings stage 3b). Owners only.
//
// POST with the signed-in owner's token, { step, ... }:
//   list   → everyone with a profile: email, when they last signed in, whether they have joined, whether access is off.
//   invite → { email, fullName, role, technicianName? } → makes the account and its profile (with that role's pages from
//            Settings → Roles and access) and returns a one-time link to join. The owner sends it (WhatsApp, text or email):
//            Supabase's own email only reaches the project's team, so the app never relies on it.
//   link   → { id } → a fresh link: to join (someone who hasn't yet) or to set a new password (someone who has).
//   access → { id, on } → stops or restores someone's sign-in. Their profile and history stay.
// The service role key lives only here (Supabase secret SUPABASE_SERVICE_ROLE_KEY); nothing is typed in by a person.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const APP_URL = "https://theguysgroup.github.io/the-guys-ops-app/";
export const ROLES = ["manager", "va", "technician", "marketing"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// deno-lint-ignore no-explicit-any
async function allUsers(sb: any) {
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return (data && data.users) || [];
}

// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, me: any) {
  if (!me || me.role !== "owner") return { status: 403, body: { ok: false, reason: "owners only" } };
  const step = String(body?.step || "");

  if (step === "list") {
    const users = await allUsers(sb);
    const { data: profiles } = await sb.from("profiles").select("id, full_name, role");
    // deno-lint-ignore no-explicit-any
    const people = (profiles || []).map((p: any) => {
      // deno-lint-ignore no-explicit-any
      const u = users.find((x: any) => x.id === p.id) || {};
      const banned = !!(u.banned_until && Date.parse(u.banned_until) > Date.now());
      return { id: p.id, email: u.email || "", lastSignIn: u.last_sign_in_at || null, joined: !!(u.email_confirmed_at || u.last_sign_in_at), invitedAt: u.invited_at || null, accessOff: banned };
    });
    return { status: 200, body: { ok: true, people } };
  }

  if (step === "invite") {
    const email = String(body?.email || "").trim().toLowerCase(), fullName = String(body?.fullName || "").trim(), role = String(body?.role || "");
    const technicianName = String(body?.technicianName || "").trim();
    if (!EMAIL.test(email)) return { status: 400, body: { ok: false, reason: "That email doesn't look right." } };
    if (!fullName) return { status: 400, body: { ok: false, reason: "Their name is needed." } };
    if (!ROLES.includes(role)) return { status: 400, body: { ok: false, reason: "Pick a role." } };
    // deno-lint-ignore no-explicit-any
    if ((await allUsers(sb)).some((u: any) => String(u.email || "").toLowerCase() === email)) return { status: 409, body: { ok: false, reason: "Someone with that email already has an account." } };
    const { data: link, error } = await sb.auth.admin.generateLink({ type: "invite", email, options: { data: { full_name: fullName }, redirectTo: APP_URL } });
    if (error || !link || !link.user) return { status: 400, body: { ok: false, reason: (error && error.message) || "The account could not be made." } };
    const { data: st } = await sb.from("settings").select("catalog").eq("id", 1).single();
    const permissions = (st && st.catalog && st.catalog.roles && st.catalog.roles[role]) || {};
    const { error: pe } = await sb.from("profiles").insert({ id: link.user.id, full_name: fullName, role, technician_name: role === "technician" ? (technicianName || fullName) : null, permissions });
    if (pe) { await sb.auth.admin.deleteUser(link.user.id); return { status: 400, body: { ok: false, reason: pe.message } }; }
    return { status: 200, body: { ok: true, id: link.user.id, link: link.properties && link.properties.action_link } };
  }

  if (step === "link") {
    const id = String(body?.id || "");
    // deno-lint-ignore no-explicit-any
    const u = (await allUsers(sb)).find((x: any) => x.id === id);
    if (!u || !u.email) return { status: 404, body: { ok: false, reason: "No account for that person." } };
    const joined = !!(u.email_confirmed_at || u.last_sign_in_at);
    const { data: link, error } = await sb.auth.admin.generateLink({ type: joined ? "recovery" : "invite", email: u.email, options: { redirectTo: APP_URL } });
    if (error) return { status: 400, body: { ok: false, reason: error.message } };
    return { status: 200, body: { ok: true, kind: joined ? "password" : "join", link: link && link.properties && link.properties.action_link } };
  }

  if (step === "access") {
    const id = String(body?.id || ""), turnOn = !!body?.on;
    if (id === me.id) return { status: 400, body: { ok: false, reason: "You can't switch off your own access." } };
    const { data: p } = await sb.from("profiles").select("id, role").eq("id", id).single();
    if (!p) return { status: 404, body: { ok: false, reason: "No such person." } };
    if (p.role === "owner") return { status: 400, body: { ok: false, reason: "An owner's access can't be switched off here." } };
    const { error } = await sb.auth.admin.updateUserById(id, { ban_duration: turnOn ? "none" : "87600h" });
    if (error) return { status: 400, body: { ok: false, reason: error.message } };
    return { status: 200, body: { ok: true, accessOff: !turnOn } };
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
  const { data: p } = await sb.from("profiles").select("id, full_name, role").eq("id", u.user.id).single();
  return p || null;
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__TEAM_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "Could not parse request body" }, 400); }
    try {
      const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
      const r = await handle(sb, body, await caller(sb, req));
      return json(r.body, r.status);
    } catch (e) {
      console.error("team failed:", e);
      return json({ ok: false, reason: String((e as Error).message || e) }, 500);
    }
  });
}
