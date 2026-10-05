// Tests for push/index.ts. Run: bash supabase/functions/push/run_tests.sh
// deno-lint-ignore-file no-explicit-any

function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { app_keys: [], push_subscriptions: [], payroll_weeks: [], profiles: [], ...seed };
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, lim = Infinity, single = false;
    const b: any = {
      select() { return b; }, insert(p: any) { op = "insert"; payload = p; return b; }, delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      in(k: string, list: any[]) { filters.push((r) => list.includes(r[k])); return b; },
      limit(n: number) { lim = n; return b; }, single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const m = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") { if (table === "app_keys" && rows().some((r) => r.name === payload.name)) return { data: null, error: { message: "duplicate" } }; rows().push({ ...payload }); return { data: null, error: null }; }
      if (op === "delete") { const gone = m(); T[table] = rows().filter((r) => !gone.includes(r)); return { data: gone, error: null }; }
      const out = m().slice(0, lim).map((r) => ({ ...r }));
      return { data: single ? out[0] || null : out, error: null };
    }
    return b;
  }
  return { T, from: q };
}
let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }

const sent: any[] = [];
let gone = new Set<string>();
let made = 0;
io.generate = () => { made++; return { publicKey: "PUB" + made, privateKey: "PRIV" + made }; };
io.send = async (sub: any, payload: string) => { if (gone.has(sub.endpoint)) { const e: any = new Error("gone"); e.statusCode = 410; throw e; } sent.push({ to: sub.endpoint, msg: JSON.parse(payload) }); return { statusCode: 201 }; };
io.build = () => ({ method: "POST", headers: { Authorization: "vapid t=x, k=y" }, body: new Uint8Array(120) });

const OFEK = { id: "u-ofek", role: "owner", full_name: "Ofek", technician_name: "Ofek" };
const NOAM = { id: "u-noam", role: "owner", full_name: "Noam", technician_name: "Noam" };
const GUY = { id: "u-guy", role: "technician", full_name: "Guy Galili", technician_name: "Guy" };
const DOLEV = { id: "u-dolev", role: "technician", full_name: "Dolev", technician_name: "Dolev" };

(async () => {
  eq(weekText("2026-10-04"), "4–10 Oct", "weekText: one month");
  eq(weekText("2026-09-27"), "27 Sep – 3 Oct", "weekText: across two months");

  const db = fakeDb({
    profiles: [OFEK, NOAM, GUY, DOLEV],
    push_subscriptions: [
      { id: "s1", user_id: "u-ofek", endpoint: "https://push/ofek-phone", p256dh: "k", auth: "a" },
      { id: "s2", user_id: "u-noam", endpoint: "https://push/noam-phone", p256dh: "k", auth: "a" },
      { id: "s3", user_id: "u-noam", endpoint: "https://push/noam-old", p256dh: "k", auth: "a" },
      { id: "s4", user_id: "u-guy", endpoint: "https://push/guy-phone", p256dh: "k", auth: "a" },
    ],
    payroll_weeks: [{ week_start: "2026-10-04", person: "Guy", salary_invoice_file: "sb:payroll/2026-10-04/Guy/salary-invoice-1.pdf" }, { week_start: "2026-10-04", person: "Dolev", salary_invoice_file: null }],
  });

  // the key pair: made once, then the same one every time; anyone may ask for the public half
  const k1 = await handle(db, { step: "key" }, null), k2 = await handle(db, { step: "key" }, null);
  eq([k1.status, k1.body.publicKey, k2.body.publicKey, made, db.T.app_keys.length], [200, "PUB1", "PUB1", 1, 1], "key: made on first use, kept, the same after");
  eq(JSON.stringify(k1.body).includes("PRIV"), false, "key: the private half never leaves");

  // a technician's commission invoice → every owner's devices, not the technician's
  gone = new Set(["https://push/noam-old"]);
  const r = await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, GUY);
  eq([r.status, r.body.sent, r.body.failed, r.body.removed], [200, 2, 1, 1], "invoice: both owners' phones get it; a phone that is gone is removed");
  eq(sent.map((x) => x.to), ["https://push/ofek-phone", "https://push/noam-phone"], "invoice: only the owners' devices");
  eq([sent[0].msg.title, sent[0].msg.body, sent[0].msg.url], ["Invoice in: Guy", "Guy sent his commission invoice for 4–10 Oct. You can pay him.", "https://theguysgroup.github.io/the-guys-ops-app/?tab=payroll&week=2026-10-04"], "invoice: what the notification says and where it opens");
  eq(db.T.push_subscriptions.some((s) => s.id === "s3"), false, "invoice: the gone device is deleted");

  // who may ask
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, DOLEV)).status, 403, "invoice: another technician cannot send it for Guy");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Dolev" }, DOLEV)).status, 409, "invoice: nothing is sent when there is no invoice on the week");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, null)).status, 401, "invoice: not signed in");
  eq((await handle(db, { step: "invoice", week: "4 Oct", person: "Guy" }, OFEK)).status, 400, "invoice: a bad week is refused");
  eq((await handle(db, { step: "invoice", week: "2026-10-04", person: "Guy" }, OFEK)).body.sent, 2, "invoice: an owner may send it for a technician too");

  // test and selftest: owners only, to their own devices
  sent.length = 0;
  const t = await handle(db, { step: "test" }, OFEK);
  eq([t.body.ok, sent.map((x) => x.to)], [true, ["https://push/ofek-phone"]], "test: only the caller's own devices");
  eq((await handle(db, { step: "test" }, GUY)).status, 403, "test: owners only");
  const st = await handle(db, { step: "selftest" }, OFEK);
  eq([st.status, st.body.ok, st.body.method], [200, true, "POST"], "selftest: builds a signed, encrypted message without sending it");
  eq((await handle(db, { step: "nope" }, OFEK)).status, 400, "unknown step");

  console.log(`push: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
