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
// What the contractor's page gets: the text and the deal line, never the bank details or the token.
// deno-lint-ignore no-explicit-any
export function publicView(sup: any, priv: any, state: string) {
  const a = priv.agreement || {};
  return {
    ok: true, state, company: String(sup.name || ""), person: String(sup.contact_person || ""), html: String(a.html || ""), dealLine: String(a.dealLine || ""),
    dealNote: String(a.dealNote || ""), version: Number(a.version) || 1, madeOn: String(a.made_at || "").slice(0, 10), ourSigner: String(a.made_by || ""),
    ...(state === "signed" && a.signed ? { signedAt: a.signed.at, signer: a.signed.name, signature: a.signed.signature } : {}),
  };
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
  if (state === "expired") return { status: 410, body: { ok: false, reason: "expired" } };
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
    return { status: 200, body: publicView(sup, priv, state) };
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
    return { status: 200, body: publicView(sup, { ...cur, agreement }, "signed") };
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
