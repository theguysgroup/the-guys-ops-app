
// ── tests ──
let pass = 0, fail = 0;
function eq(got: unknown, want: unknown, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }
// A tiny in-memory stand-in for the Supabase client: select / eq / in / limit / update (with "col->>key" filters).
function fakeDb(priv: any[], sup: any[]) {
  const T: Record<string, any[]> = { contractor_private: priv, suppliers: sup };
  const from = (t: string) => {
    const st: any = { f: [] as any[], upd: null as any };
    const rows = () => (T[t] || []).filter((r) => st.f.every((f: any) => f(r)));
    const val = (r: any, k: string) => { const m = k.match(/^(\w+)->>(\w+)$/); return m ? (r[m[1]] || {})[m[2]] : r[k]; };
    const api: any = {
      select: () => api, limit: () => api,
      eq: (k: string, v: any) => { st.f.push((r: any) => val(r, k) === v); return api; },
      in: (k: string, vs: any[]) => { st.f.push((r: any) => vs.includes(val(r, k))); return api; },
      update: (o: any) => { st.upd = o; return api; },
      then: (ok: any, bad: any) => { if (st.upd) { const hit = rows(); hit.forEach((r: any) => Object.assign(r, st.upd)); return Promise.resolve({ data: hit.map((r: any) => ({ supplier_id: r.supplier_id })), error: null }).then(ok, bad); } return Promise.resolve({ data: rows(), error: null }).then(ok, bad); },
    };
    return api;
  };
  return { T, from };
}
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345", NOW = Date.parse("2026-10-14T00:00:00Z");
const SIG = "data:image/png;base64," + "iVBORw0KGgo".repeat(30);
const mk = (over: any = {}) => fakeDb(
  [{ supplier_id: "s1", sign_token: TOKEN, sign_token_expires: "2026-10-27T00:00:00Z", legal_name: "x", abn: "51 824 753 556", bank_account: "10004821",
     agreement: { version: 1, state: "sent", html: "<h4>1. Who</h4><p>Spark</p>", dealLine: "We get 10% of every job we pass to Spark.", made_at: "2026-10-13T01:00:00Z", ...over } }],
  [{ id: "s1", name: "Spark Line Electrical", contact_person: "Jake Morrison", agreement_status: "sent" }]);
(async () => {
  eq([tokenOk(TOKEN), tokenOk("short"), tokenOk("x".repeat(65)), tokenOk("bad token with spaces!!!!!!")], [true, false, false, false], "only well-formed tokens");
  eq([signError("Jake Morrison", true, SIG), signError("J", true, SIG), signError("Jake", false, SIG), signError("Jake", "true", SIG), signError("Jake", true, "data:image/jpeg;base64,xx"), signError("Jake", true, "data:image/png;base64,abc")],
    [null, "name", "agree", "agree", "signature", "signature"], "a name, the tick (a real true) and a drawn PNG are needed");
  // "See what they see" from the app: the contractor's card does not change.
  let db = mk();
  await handle(db, { step: "get", t: TOKEN, preview: true }, "", "", NOW);
  eq([db.T.contractor_private[0].agreement.state, db.T.suppliers[0].agreement_status], ["sent", "sent"], "a preview from the office is not counted as opened");
  const made = mk({ state: "ready" }); made.T.suppliers[0].agreement_status = "ready";
  await handle(made, { step: "get", t: TOKEN }, "", "", NOW);
  eq([made.T.contractor_private[0].agreement.state, made.T.suppliers[0].agreement_status], ["ready", "ready"], "a link not sent yet is not counted as opened");
  // Reading: the text and the deal, never the bank details or the token; the first look marks it opened.
  let r = await handle(db, { step: "get", t: TOKEN }, "1.2.3.4", "iPhone", NOW);
  eq([r.status, (r.body as any).company, (r.body as any).dealLine, JSON.stringify(r.body).includes("10004821"), JSON.stringify(r.body).includes(TOKEN)], [200, "Spark Line Electrical", "We get 10% of every job we pass to Spark.", false, false], "the contractor reads the agreement, no bank or token in the reply");
  eq([db.T.contractor_private[0].agreement.state, !!db.T.contractor_private[0].agreement.opened_at, db.T.suppliers[0].agreement_status], ["opened", true, "opened"], "first look: opened on the card");
  // Signing: saved once with name, time, IP and device; the card shows signed.
  r = await handle(db, { step: "sign", t: TOKEN, name: "  Jake Morrison ", agree: true, signature: SIG }, "1.2.3.4, 10.0.0.1", "iPhone Safari", NOW);
  const a = db.T.contractor_private[0].agreement;
  eq([r.status, a.state, a.signed.name, a.signed.ip, a.signed.ua, a.signed.at, db.T.suppliers[0].agreement_status, db.T.suppliers[0].agreement_signer], [200, "signed", "Jake Morrison", "1.2.3.4, 10.0.0.1", "iPhone Safari", "2026-10-14T00:00:00.000Z", "signed", "Jake Morrison"], "signed: name, time, IP and device kept; the card says signed");
  r = await handle(db, { step: "sign", t: TOKEN, name: "Someone Else", agree: true, signature: SIG }, "9.9.9.9", "x", NOW);
  eq([r.status, (r.body as any).reason, db.T.contractor_private[0].agreement.signed.name], [409, "already_signed", "Jake Morrison"], "a second signature is refused");
  r = await handle(db, { step: "get", t: TOKEN }, "", "", NOW + 30 * 864e5);
  eq([r.status, (r.body as any).state, (r.body as any).signer], [200, "signed", "Jake Morrison"], "after signing the link still shows the signed copy (even after 14 days)");
  // Expired, unknown and bad requests.
  db = mk();
  eq((await handle(db, { step: "get", t: TOKEN }, "", "", Date.parse("2026-10-28T00:00:00Z"))).status, 410, "an unsigned link stops working after it expires");
  eq((await handle(db, { step: "get", t: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }, "", "", NOW)).status, 404, "an unknown token finds nothing");
  eq((await handle(db, { step: "sign", t: TOKEN, name: "Jake", agree: true, signature: "nope" }, "", "", NOW)).body, { ok: false, reason: "signature" }, "no drawn signature, no signing");
  eq(db.T.contractor_private[0].agreement.state, "sent", "a refused signature changes nothing");
  // The row changed between reading and saving (signed a moment ago, or a new agreement with a new link): refused, nothing overwritten.
  db = mk();
  const realFrom = db.from; let reads = 0;
  (db as any).from = (t: string) => { const q = realFrom(t); if (t === "contractor_private" && ++reads === 2) db.T.contractor_private[0].sign_token = "NewTokenNewTokenNewToken0000"; return q; };
  r = await handle(db, { step: "sign", t: TOKEN, name: "Jake Morrison", agree: true, signature: SIG }, "", "", NOW);
  eq([r.status, (r.body as any).reason, db.T.contractor_private[0].agreement.state, db.T.suppliers[0].agreement_status], [409, "already_signed", "sent", "sent"], "a signature on a replaced link changes nothing");
  eq((await handle(mk({ html: "" }), { step: "get", t: TOKEN }, "", "", NOW)).status, 404, "no agreement text: nothing to sign");
  console.log(`contractor-sign: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
