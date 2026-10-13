// passkey: Face ID / fingerprint (WebAuthn passkeys) and the 30-minute Security "step-up" (settings round 2, phase 3:
// plan item 6, problem P4, mockup answers M6 3-5). Deploy with Verify JWT ON: the caller is a signed-in person.
//
// POST with the signed-in person's token, { action, ... }:
//   status       → { until, method } when THIS sign-in session is unlocked now, else nulls.
//   lock         → ends this session's unlock ("Lock now").
//   reg-options  → (unlocked only) the options for navigator.credentials.create on this device. The challenge is kept for
//                  5 minutes, for this sign-in session only.
//   reg-verify   → { response, deviceName, deviceKind } (unlocked only) checks the new key against that challenge (used
//                  once) and saves it in public.passkeys.
//   auth-options → the options for navigator.credentials.get, for this person's own keys (challenge kept 5 minutes).
//   auth-verify  → { response } checks the signature with the saved public key of THIS person's key; unlocks for 30 minutes
//                  (method 'passkey').
//   password     → { password, code? } re-checks the password (and the 6-digit code when two-step sign-in is on) by
//                  signing in a temporary session that is signed out again at once; unlocks ('password' /
//                  'password+code'). After 5 wrong tries in 15 minutes it refuses until the 15 minutes are over:
//                  each try is counted BEFORE the password is checked, in one database step
//                  (step_up_fail_reserve), so tries sent at the same time can't get past the limit. Only a real
//                  "wrong email or password" counts; any other Auth error answers 'server' and is not counted.
//                  The password is never stored and never logged.
//   google       → unlocks ('google') when this session signed in with Google in the last 5 minutes (and, with
//                  two-step sign-in on, also gave the code). ONLY for a person who signs in with Google alone (no
//                  password, M6 answer 3): on a phone already signed in to Google, signing in again asks for no
//                  secret, so a person who has a password must use it (or Face ID / fingerprint): 'use-password'.
// An unlock is a row in public.step_up for (person, the token's session_id) with an end time. public.has_step_up() reads
// it, so the database itself enforces it: Settings history rows, removing a key and the security part of the settings
// (see .claude/sql/settings-round2-phase3.sql, section G-faceid).
// No new secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are provided by Supabase itself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "https://esm.sh/@simplewebauthn/server@13.3.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// The app's public key (the same one index.html ships; not a secret), used only for the temporary password check.
export const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_CYDF61njgAU74Dm3PvkLGQ_4N6qfvIi";
export const RP_ID = "theguysgroup.github.io";
export const ORIGIN = "https://theguysgroup.github.io";
export const RP_NAME = "OPS Service";
export const STEP_UP_MINUTES = 30;        // the app's SEC_LOCK_MINUTES is the same (a test in the app checks)
export const CHALLENGE_MINUTES = 5;
export const FRESH_SIGNIN_SECONDS = 300;  // "Continue with Google" counts when that sign-in is at most 5 minutes old
export const MAX_FAILS = 5;
export const FAIL_WINDOW_MINUTES = 15;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// base64url without padding, as WebAuthn uses it.
export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str: string): Uint8Array {
  const t = String(str || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// The token's claims (sub, session_id, amr, aal), or null. Only read AFTER auth.getUser has checked the token.
// deno-lint-ignore no-explicit-any
export function jwtPayload(jwt: string): any {
  try {
    const part = String(jwt || "").split(".")[1];
    if (!part) return null;
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}
// A device name as the app sends it ("Ofek's iPhone"): no control characters, one space between words, 60 characters at most.
export function cleanDeviceName(s: unknown): string {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return t || "This device";
}
export function cleanKind(s: unknown): string {
  return ["Face ID", "Fingerprint", "Windows Hello"].includes(String(s)) ? String(s) : "Fingerprint";
}
// True when the token's sign-in methods include Google (oauth) at most maxAge seconds ago (never in the future).
// deno-lint-ignore no-explicit-any
export function freshOauth(amr: any, nowSec: number, maxAge: number): boolean {
  // deno-lint-ignore no-explicit-any
  return Array.isArray(amr) && amr.some((a: any) => a && a.method === "oauth" && typeof a.timestamp === "number" && nowSec - a.timestamp >= 0 && nowSec - a.timestamp <= maxAge);
}
// deno-lint-ignore no-explicit-any
export function hasVerifiedTotp(factors: any): boolean {
  // deno-lint-ignore no-explicit-any
  return Array.isArray(factors) && factors.some((f: any) => f && f.factor_type === "totp" && f.status === "verified");
}
// True when the person signs in with Google and has no password (no 'email' sign-in method), as the app's secGoogleOnly.
// deno-lint-ignore no-explicit-any
export function googleOnly(providers: any): boolean {
  return Array.isArray(providers) && providers.includes("google") && !providers.includes("email");
}
// What a failed Auth call means for the step-up: 'wrong' only for a real wrong password (or code); anything else (rate
// limit, outage, a bad API key, an unconfirmed email) is 'unavailable', never counted as a wrong try.
// deno-lint-ignore no-explicit-any
export function authErrorKind(error: any, what: "password" | "code"): "wrong" | "unavailable" {
  if (!error) return "unavailable";
  const code = String(error.code || ""), st = Number(error.status) || 0, msg = String(error.message || "");
  if (what === "password") return code === "invalid_credentials" || (!code && st === 400 && /invalid login credentials/i.test(msg)) ? "wrong" : "unavailable";
  return code === "mfa_verification_failed" || (!code && (st === 400 || st === 422) && /invalid (totp )?code/i.test(msg)) ? "wrong" : "unavailable";
}

// deno-lint-ignore no-explicit-any
function out(status: number, body: any) { return { status, body }; }
// deno-lint-ignore no-explicit-any
function must(r: any) { if (r && r.error) throw new Error(r.error.message || "database error"); return r; }

// deno-lint-ignore no-explicit-any
async function stepUpOf(sb: any, uid: string, sid: string, nowMs: number) {
  const { data } = must(await sb.from("step_up").select("until, method").eq("user_id", uid).eq("session_id", sid).maybeSingle());
  return data && Date.parse(data.until) > nowMs ? data : null;
}
// deno-lint-ignore no-explicit-any
async function grant(sb: any, uid: string, sid: string, method: string, nowMs: number) {
  const until = new Date(nowMs + STEP_UP_MINUTES * 60e3).toISOString();
  must(await sb.from("step_up").upsert({ user_id: uid, session_id: sid, until, method }, { onConflict: "user_id,session_id" }));
  return out(200, { ok: true, until, method, left: STEP_UP_MINUTES * 60 });
}
// deno-lint-ignore no-explicit-any
async function putChallenge(sb: any, uid: string, sid: string, kind: string, challenge: string, nowMs: number) {
  const expires_at = new Date(nowMs + CHALLENGE_MINUTES * 60e3).toISOString();
  must(await sb.from("passkey_challenges").upsert({ user_id: uid, session_id: sid, kind, challenge, expires_at }, { onConflict: "user_id,session_id,kind" }));
}
// The challenge for this session, taken out (each one works once). null when there is none or it is too old.
// deno-lint-ignore no-explicit-any
async function takeChallenge(sb: any, uid: string, sid: string, kind: string, nowMs: number): Promise<string | null> {
  const { data } = must(await sb.from("passkey_challenges").select("challenge, expires_at").eq("user_id", uid).eq("session_id", sid).eq("kind", kind).maybeSingle());
  must(await sb.from("passkey_challenges").delete().eq("user_id", uid).eq("session_id", sid).eq("kind", kind));
  if (!data || !(Date.parse(data.expires_at) > nowMs)) return null;
  return String(data.challenge || "") || null;
}

// One wrong-password try, counted in ONE database step before the password is checked (see the SQL section G-faceid):
// the count in the 15-minute window after it (a window older than 15 minutes starts again at 1).
// deno-lint-ignore no-explicit-any
async function reserveTry(sb: any, uid: string): Promise<number> {
  const { data } = must(await sb.rpc("step_up_fail_reserve", { p_user: uid, p_window_minutes: FAIL_WINDOW_MINUTES }));
  const n = Number(Array.isArray(data) ? data[0] : data);
  if (!Number.isFinite(n)) throw new Error("try counter gave no answer");
  return n;
}
// Gives a reserved try back (the password was right but the code is still to come, or the check couldn't run).
// deno-lint-ignore no-explicit-any
async function releaseTry(sb: any, uid: string) { must(await sb.rpc("step_up_fail_release", { p_user: uid })); }

// deps = { sb (service-role client), wa: { genReg, verReg, genAuth, verAuth } (the WebAuthn library), password(email,
// password, code) → { ok, withCode } | { needCode } | { wrong: 'password' | 'code' } (throws when it can't check), now() → ms }.
// who = { userId, email, sessionId, payload (token claims), factors, providers, name } or null. Returns { status, body }.
// deno-lint-ignore no-explicit-any
export async function handle(deps: any, body: any, who: any) {
  if (!who || !who.userId || !UUID_RE.test(String(who.sessionId || ""))) return out(401, { ok: false, reason: "signed-out" });
  const { sb, wa } = deps;
  const nowMs = Number(deps.now());
  const nowIso = new Date(nowMs).toISOString();
  const uid = String(who.userId), sid = String(who.sessionId);
  const action = String(body?.action || "");
  const ACTIONS = ["status", "lock", "reg-options", "reg-verify", "auth-options", "auth-verify", "password", "google"];
  if (!ACTIONS.includes(action)) return out(400, { ok: false, reason: "unknown action" });

  // Old unlocks and challenges of this person go first, so the tables stay small.
  must(await sb.from("step_up").delete().eq("user_id", uid).lt("until", nowIso));
  must(await sb.from("passkey_challenges").delete().eq("user_id", uid).lt("expires_at", nowIso));

  if (action === "status") {
    const s = await stepUpOf(sb, uid, sid, nowMs);
    return out(200, { ok: true, until: s ? s.until : null, method: s ? s.method : null, left: s ? Math.max(0, Math.floor((Date.parse(s.until) - nowMs) / 1000)) : 0 });
  }
  if (action === "lock") {
    must(await sb.from("step_up").delete().eq("user_id", uid).eq("session_id", sid));
    return out(200, { ok: true });
  }

  if (action === "reg-options") {
    if (!(await stepUpOf(sb, uid, sid, nowMs))) return out(403, { ok: false, reason: "locked" });
    const { data: keys } = must(await sb.from("passkeys").select("credential_id, transports").eq("user_id", uid));
    const options = await wa.genReg({
      rpName: RP_NAME, rpID: RP_ID,
      userName: String(who.email || uid), userID: new TextEncoder().encode(uid), userDisplayName: String(who.name || who.email || uid),
      attestationType: "none",
      // deno-lint-ignore no-explicit-any
      excludeCredentials: (keys || []).map((k: any) => ({ id: k.credential_id, transports: Array.isArray(k.transports) && k.transports.length ? k.transports : undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
      timeout: 60000,
    });
    await putChallenge(sb, uid, sid, "reg", options.challenge, nowMs);
    return out(200, { ok: true, options });
  }

  if (action === "reg-verify") {
    if (!(await stepUpOf(sb, uid, sid, nowMs))) return out(403, { ok: false, reason: "locked" });
    const challenge = await takeChallenge(sb, uid, sid, "reg", nowMs);
    if (!challenge) return out(400, { ok: false, reason: "expired" });
    // deno-lint-ignore no-explicit-any
    let v: any = null;
    try { v = await wa.verReg({ response: body?.response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true }); }
    catch (_) { v = null; }
    if (!v || !v.verified || !v.registrationInfo || !v.registrationInfo.credential) return out(400, { ok: false, reason: "not-verified" });
    const info = v.registrationInfo, cred = info.credential;
    const row = {
      user_id: uid, credential_id: String(cred.id), public_key: b64urlEncode(cred.publicKey), counter: Number(cred.counter) || 0,
      transports: Array.isArray(cred.transports) ? cred.transports : [], device_name: cleanDeviceName(body?.deviceName), device_kind: cleanKind(body?.deviceKind),
      device_type: info.credentialDeviceType || null, backed_up: !!info.credentialBackedUp,
    };
    const { data, error } = await sb.from("passkeys").insert(row).select("id, credential_id, device_name, device_kind, created_at").single();
    if (error) {
      if (String(error.code) === "23505") return out(409, { ok: false, reason: "already" });
      throw new Error(error.message || "insert failed");
    }
    return out(200, { ok: true, passkey: data });
  }

  if (action === "auth-options") {
    const { data: keys } = must(await sb.from("passkeys").select("credential_id, transports").eq("user_id", uid));
    if (!keys || !keys.length) return out(404, { ok: false, reason: "no-passkey" });
    const options = await wa.genAuth({
      rpID: RP_ID,
      // deno-lint-ignore no-explicit-any
      allowCredentials: keys.map((k: any) => ({ id: k.credential_id, transports: Array.isArray(k.transports) && k.transports.length ? k.transports : undefined })),
      userVerification: "required", timeout: 60000,
    });
    await putChallenge(sb, uid, sid, "auth", options.challenge, nowMs);
    return out(200, { ok: true, options });
  }

  if (action === "auth-verify") {
    const credId = String(body?.response?.id || "");
    // Only THIS person's key counts: a key of someone else never unlocks this session.
    const { data: key } = credId ? must(await sb.from("passkeys").select("id, credential_id, public_key, counter, transports").eq("credential_id", credId).eq("user_id", uid).maybeSingle()) : { data: null };
    if (!key) return out(404, { ok: false, reason: "not-found" });
    const challenge = await takeChallenge(sb, uid, sid, "auth", nowMs);
    if (!challenge) return out(400, { ok: false, reason: "expired" });
    // deno-lint-ignore no-explicit-any
    let v: any = null;
    try {
      v = await wa.verAuth({
        response: body?.response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        credential: { id: key.credential_id, publicKey: b64urlDecode(key.public_key), counter: Number(key.counter) || 0, transports: Array.isArray(key.transports) && key.transports.length ? key.transports : undefined },
        requireUserVerification: true,
      });
    } catch (_) { v = null; }
    if (!v || !v.verified) return out(400, { ok: false, reason: "not-verified" });
    const newCounter = Number(v.authenticationInfo && v.authenticationInfo.newCounter);
    must(await sb.from("passkeys").update({ counter: Number.isFinite(newCounter) ? newCounter : Number(key.counter) || 0, last_used_at: nowIso }).eq("id", key.id));
    return grant(sb, uid, sid, "passkey", nowMs);
  }

  if (action === "password") {
    const password = String(body?.password || "");
    const code = String(body?.code || "").replace(/\D/g, "");
    if (!password) return out(400, { ok: false, reason: "wrong-password" });
    // The try is counted first (atomically), so tries sent at the same time each get their own number.
    if ((await reserveTry(sb, uid)) > MAX_FAILS) return out(429, { ok: false, reason: "too-many" });
    // deno-lint-ignore no-explicit-any
    let r: any;
    try { r = await deps.password(String(who.email || ""), password, code || undefined); }
    catch (e) { await releaseTry(sb, uid).catch(() => {}); throw e; }
    if (r && r.wrong) return out(401, { ok: false, reason: r.wrong === "code" ? "wrong-code" : "wrong-password" });   // stays counted
    if (r && r.needCode) { await releaseTry(sb, uid); return out(200, { ok: false, needCode: true }); }
    if (!r || !r.ok) { await releaseTry(sb, uid).catch(() => {}); throw new Error("password check gave no answer"); }
    must(await sb.from("step_up_fails").delete().eq("user_id", uid));
    return grant(sb, uid, sid, r.withCode ? "password+code" : "password", nowMs);
  }

  // action === "google": only for a person with no password (M6-3). Someone who has one uses it, or Face ID / fingerprint.
  if (!googleOnly(who.providers)) return out(401, { ok: false, reason: "use-password" });
  const p = who.payload || {};
  if (!freshOauth(p.amr, Math.floor(nowMs / 1000), FRESH_SIGNIN_SECONDS) || (hasVerifiedTotp(who.factors) && p.aal !== "aal2")) return out(401, { ok: false, reason: "not-fresh" });
  return grant(sb, uid, sid, "google", nowMs);
}

// ── production wiring (not used by the tests) ──
// The password check: a temporary sign-in that is ALWAYS signed out again (scope local: only that temporary session).
async function checkPassword(email: string, password: string, code?: string) {
  const temp = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  try {
    const { data, error } = await temp.auth.signInWithPassword({ email, password });
    if (error) {
      // Only a real wrong password counts; too many sign-ins, an outage or a setup problem is not one (and is not counted).
      // deno-lint-ignore no-explicit-any
      if (authErrorKind(error, "password") !== "wrong") throw new Error("sign-in check unavailable (" + (Number((error as any).status) || 0) + ")");
      return { wrong: "password" };
    }
    if (!data || !data.user) return { wrong: "password" };
    // deno-lint-ignore no-explicit-any
    const factor = ((data.user as any).factors || []).find((f: any) => f && f.factor_type === "totp" && f.status === "verified");
    if (!factor) return { ok: true, withCode: false };
    if (!code) return { needCode: true };
    const { error: e2 } = await temp.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (e2) {
      // deno-lint-ignore no-explicit-any
      if (authErrorKind(e2, "code") !== "wrong") throw new Error("code check unavailable (" + (Number((e2 as any).status) || 0) + ")");
      return { wrong: "code" };
    }
    return { ok: true, withCode: true };
  } finally {
    try { await temp.auth.signOut({ scope: "local" }); } catch (_) { /* best effort: the temporary session ends with its token anyway */ }
  }
}

// The signed-in person, from the token (checked by Supabase Auth), or null.
// deno-lint-ignore no-explicit-any
async function caller(sb: any, req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data: u, error } = await sb.auth.getUser(jwt);
  if (error || !u || !u.user) return null;
  const payload = jwtPayload(jwt);
  if (!payload || payload.sub !== u.user.id) return null;
  const { data: p } = await sb.from("profiles").select("full_name").eq("id", u.user.id).maybeSingle();
  // The sign-in methods (as the app reads them: app_metadata.providers; the identities when that list is missing).
  const meta = u.user.app_metadata && Array.isArray(u.user.app_metadata.providers) ? u.user.app_metadata.providers : null;
  // deno-lint-ignore no-explicit-any
  const providers = (meta || (u.user.identities || []).map((i: any) => i && i.provider)).filter(Boolean).map(String);
  return { userId: u.user.id, email: u.user.email || "", sessionId: String(payload.session_id || ""), payload, factors: u.user.factors || [], providers, name: (p && p.full_name) || "" };
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__PASSKEY_TEST__) {
  const wa = { genReg: generateRegistrationOptions, verReg: verifyRegistrationResponse, genAuth: generateAuthenticationOptions, verAuth: verifyAuthenticationResponse };
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json({ ok: false, reason: "Could not parse request body" }, 400); }
    try {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const r = await handle({ sb, wa, password: checkPassword, now: () => Date.now() }, body, await caller(sb, req));
      return json(r.body, r.status);
    } catch (e) {
      // Only the error's message: never the request body (it can hold the password).
      console.error("passkey failed:", (e as Error).message);
      return json({ ok: false, reason: "server" }, 500);
    }
  });
}
