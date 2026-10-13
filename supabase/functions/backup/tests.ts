// Tests for backup/index.ts. Run: bash supabase/functions/backup/run_tests.sh
// (the runner swaps the esm.sh import for a stub, gives a pretend Deno.env, appends this file and runs it with npx tsx).
// deno-lint-ignore-file no-explicit-any
import * as nodeCrypto from "node:crypto";
import * as zlib from "node:zlib";

const ENV = (globalThis as any).__BACKUP_ENV__ as Record<string, string>;
const PASSWORD = "correct horse battery staple 42";
const CRON = "cron-secret-value-0123456789";
const FAST = 1000;   // PBKDF2 iterations in the tests (the real number is ITERATIONS, asserted below)
io.kdfIterations = () => FAST;

let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
function ok(cond: any, name: string, extra?: any) { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); } }
async function throws(p: Promise<any>) { try { await p; return false; } catch (_) { return true; } }
const te = new TextEncoder(), td = new TextDecoder();

// ── a small in-memory stand-in for the Supabase client: tables, rpc, storage ──
function fakeDb(seed: Record<string, any[]> = {}) {
  const T: Record<string, any[]> = { backup_settings: [], backup_state: [], backup_runs: [], backup_files: [], activity_log: [], step_up: [], ...seed };
  const calls: string[] = [];
  const store = new Map<string, Uint8Array>();          // "bucket/path" → bytes
  const objMeta = new Map<string, { mimetype: string }>();
  const unique = (table: string, r: any) => table === "backup_runs" && r.kind === "weekly" && T.backup_runs.some((x) => x.kind === "weekly" && x.slot === r.slot && Number(x.attempt || 1) === Number(r.attempt || 1));
  function q(table: string) {
    const rows = () => (T[table] = T[table] || []);
    const filters: ((r: any) => boolean)[] = [];
    let op = "select", payload: any = null, opts: any = {}, single = false, maybe = false, lim = Infinity, range: [number, number] | null = null;
    const orders: [string, boolean][] = [];
    const b: any = {
      select(_c?: string) { return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o || {}; return b; },
      delete() { op = "delete"; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      lt(k: string, v: any) { filters.push((r) => r[k] != null && String(r[k]) < String(v)); return b; },
      gte(k: string, v: any) { filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return b; },
      or(expr: string) {
        const m = /^lease_until\.is\.null,lease_until\.lt\.(.+)$/.exec(expr);
        if (!m) throw new Error("fake or(): " + expr);
        filters.push((r) => r.lease_until == null || String(r.lease_until) < m[1]); return b;
      },
      order(k: string, o?: any) { orders.push([k, !(o && o.ascending === false)]); return b; },
      limit(x: number) { lim = x; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      single() { single = true; return b; },
      maybeSingle() { maybe = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      calls.push(`${table}.${op}`);
      if (T[table] === undefined && (seed as any)["__missing_" + table]) return { data: null, error: { message: "relation does not exist" } };
      const match = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const defaults = table === "backup_runs" ? { errors: 0, progress: {}, packs: [], attempt: 1 } : {};
        const list = (Array.isArray(payload) ? payload : [payload]).map((r: any) => (table === "activity_log" ? { ...r } : { id: r.id || crypto.randomUUID(), ...defaults, ...r }));
        if (list.some((r: any) => unique(table, r))) return { data: null, error: { code: "23505", message: "duplicate key" } };
        rows().push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (op === "upsert") {
        const keys = String(opts.onConflict || "id").split(",");
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          const i = rows().findIndex((r) => keys.every((k) => r[k] === p[k]));
          if (i >= 0) rows()[i] = { ...rows()[i], ...p }; else rows().push({ ...p });
        }
        return { data: null, error: null };
      }
      if (op === "update") { const m = match(); m.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload)))); return { data: m.map((r) => ({ ...r })), error: null }; }
      if (op === "delete") { const m = match(); T[table] = rows().filter((r) => !m.includes(r)); return { data: m, error: null }; }
      let m = match();
      if (orders.length) m = m.slice().sort((a, z) => { for (const [k, asc] of orders) { const x = String(a[k] ?? ""), y = String(z[k] ?? ""); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1); } return 0; });
      if (range) m = m.slice(range[0], range[1] + 1);
      m = m.slice(0, lim);
      if (single || maybe) return { data: m[0] ? { ...m[0] } : null, error: null };
      return { data: m.map((r) => ({ ...r })), error: null };
    }
    return b;
  }
  // public's tables as backup_tables() lists them: what REST serves, plus this function's own (which must be left out).
  const tableList = () => [...Object.keys(REST), "backup_state", "backup_files", "backup_runs", "step_up"].map((n) => ({ table_name: n, order_cols: ["id"] }));
  const sb: any = {
    T, calls, store,
    from: q,
    rpc(name: string) {
      calls.push("rpc:" + name);
      let range: [number, number] | null = null;
      const b: any = {
        range(a: number, z: number) { range = [a, z]; return b; },
        then(res: any, rej: any) {
          let data: any[] = [];
          if (name === "backup_tables") data = (sb.tables || tableList());
          if (name === "backup_objects") data = [...store.keys()].filter((k) => !k.startsWith("backups/")).sort().map((k) => { const i = k.indexOf("/"); return { bucket_id: k.slice(0, i), name: k.slice(i + 1), size: store.get(k)!.length, mimetype: (objMeta.get(k) || {}).mimetype || "application/octet-stream" }; });
          if (range) data = data.slice(range[0], range[1] + 1);
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    },
    put(bucket: string, path: string, bytes: Uint8Array, type = "application/pdf") { store.set(bucket + "/" + path, bytes); objMeta.set(bucket + "/" + path, { mimetype: type }); },
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) { calls.push("storage.download"); if (sb.failDownload && sb.failDownload(bucket, path)) return { data: null, error: { message: "boom" } }; const b = store.get(bucket + "/" + path); return b ? { data: { arrayBuffer: async () => b.slice().buffer }, error: null } : { data: null, error: { message: "not found" } }; },
          async upload(path: string, body: any, o: any) {
            calls.push("storage.upload");
            if (bucket !== "backups" || o.upsert !== false) throw new Error("bad upload");
            if (!(body instanceof Blob)) throw new Error("the upload should be one Blob of the parts");
            if (store.has(bucket + "/" + path)) return { error: { message: "exists" } };
            store.set(bucket + "/" + path, new Uint8Array(await body.arrayBuffer())); return { data: { path }, error: null };
          },
          async remove(paths: string[]) { calls.push("storage.remove"); paths.forEach((p) => store.delete(bucket + "/" + p)); return { data: [], error: null }; },
          async list(prefix: string, o: any) {
            calls.push("storage.list");
            const pre = bucket + "/" + prefix + "/";
            const items = [...store.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).sort().map((k) => ({ name: k.slice(pre.length), id: "x" + k, metadata: { size: store.get(k)!.length } }));
            return { data: items.slice(o.offset, o.offset + o.limit), error: null };
          },
          async createSignedUrl(path: string, secs: number, o: any) { calls.push("storage.sign"); return { data: { signedUrl: `https://signed.example/${bucket}/${path}?e=${secs}&dl=${encodeURIComponent(o.download)}&token=SIGNEDTOKEN` }, error: null }; },
          async createSignedUrls(paths: string[], secs: number) { calls.push("storage.signMany"); return { data: paths.map((p) => (sb.failSign && sb.failSign(bucket, p) ? { path: p, signedUrl: null, error: "Either the object does not exist or you do not have access to it" } : { path: p, signedUrl: `https://signed.example/${bucket}/${p}?e=${secs}&token=SIGNEDTOKEN` })), error: null }; },
        };
      },
    },
  };
  return sb;
}

// The tables PostgREST would serve (rows in order). io.rest answers from it, with Content-Range like the real one.
let REST: Record<string, any[]> = {};
const restCalls: string[] = [];
let restCountLie: Record<string, number> = {};
io.rest = async (table: string, query: string, prefer?: string) => {
  restCalls.push(table);
  const rows = REST[table];
  if (!rows) return { status: 404, text: '{"message":"not found"}', contentRange: "" };
  const p = new URLSearchParams(query), off = Number(p.get("offset")), lim = Number(p.get("limit"));
  const page = rows.slice(off, off + lim), total = restCountLie[table] ?? rows.length;
  const cr = (page.length ? `${off}-${off + page.length - 1}` : "*") + (prefer === "count=exact" ? `/${total}` : "/*");
  return { status: 200, text: " " + JSON.stringify(page) + "\n", contentRange: cr };
};
function baseTables(): Record<string, any[]> {
  const t: Record<string, any[]> = {};
  REQUIRED_TABLES.forEach((n) => { t[n] = [{ id: 1, n }]; });
  t.contacts = [{ id: "c1", full_name: "Sarah ]} \"Jones\"" }, { id: "c2", full_name: "Bob" }];
  return t;
}
let pending: Promise<any>[] = [];
io.waitUntil = (p: Promise<any>) => { pending.push(p); };
async function settle() { while (pending.length) { const ps = pending; pending = []; await Promise.all(ps); } }
let NOW = Date.parse("2026-10-17T16:07:00Z");   // Sun 18 Oct 2026 03:07 Sydney (AEDT)
io.now = () => NOW;
const H = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const SID = "11111111-2222-4333-8444-555555555555";
const OWNER = { id: "u-own", full_name: "Ofek Shamir", role: "owner", sessionId: SID };
function cfgRow(o: any = {}) { return { id: 1, email: "info@theguyservicegroup.com", send_day: 0, send_time: "03:00", updated_at: "2026-10-01T00:00:00.000Z", updated_by: null, ...o }; }

// node:crypto opener written from the format text in index.ts, independent of the code under test.
function nodeOpen(password: string, u8: Uint8Array) {
  const buf = Buffer.from(u8);
  if (buf.subarray(0, 6).toString("ascii") !== "TGBKUP" || buf[6] !== 1) throw new Error("magic");
  const iterations = buf.readUInt32BE(8), salt = buf.subarray(12, 28), iv = buf.subarray(28, 40);
  const key = nodeCrypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(buf.subarray(0, 40));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return { kind: buf[7], plain: Buffer.concat([d.update(buf.subarray(40, buf.length - 16)), d.final()]) };
}

(async () => {
  // ── CRYPTO ──
  eq(ITERATIONS, 600000, "PBKDF2 iterations are 600,000");
  eq([PACK_MAX, OBJECT_MAX, DATA_MAX, STORAGE_SAFE, LINK_DAYS, KEEP_RUNS, TICK_BUDGET_MS, MAX_ERRORS, MAX_ATTEMPTS, CATCH_UP_MS, BUCKET], [16 * 1024 * 1024, 20 * 1024 * 1024, 48 * 1024 * 1024, 800 * 1024 * 1024, 7, 4, 90000, 3, 3, 86400000, "backups"], "limits: 16 MB packs and 20 MB files (memory), 48 MB data file, 800 MB of the free plan's 1 GB");
  const salt = new Uint8Array(16).map((_, i) => i + 1);
  const k = await deriveKey(PASSWORD, salt, FAST);
  const plain = te.encode("hello, backup ✓");
  const s1 = await sealObject(k, 1, plain), s2 = await sealObject(k, 1, plain);
  const h1 = parseHeader(s1)!;
  eq([td.decode(s1.subarray(0, 6)), s1[6], s1[7], h1.iterations, new DataView(s1.buffer).getUint32(8, false), Array.from(h1.salt), h1.iv.length, s1.length], ["TGBKUP", 1, 1, FAST, FAST, Array.from(salt), 12, 40 + plain.length + 16], "header: magic, version, kind, iterations big-endian, salt, 12-byte IV");
  ok(toHex(h1.iv) !== toHex(parseHeader(s2)!.iv) && toHex(s1.subarray(40)) !== toHex(s2.subarray(40)), "two seals of the same plaintext have different IVs and ciphertexts");
  eq(td.decode((await openObject(PASSWORD, s1)).plain), "hello, backup ✓", "kind 1 round-trips");
  const pk = await sealObject(k, 2, new Uint8Array([0, 1, 2, 255]));
  eq([(await openObject(PASSWORD, pk)).kind, Array.from((await openObject(PASSWORD, pk)).plain)], [2, [0, 1, 2, 255]], "kind 2 round-trips exactly");
  ok(await throws(openObject("wrong password", s1)), "a wrong password fails");
  for (const i of [7, 9, 13, 30]) { const t = s1.slice(); t[i] ^= 1; ok(await throws(openObject(PASSWORD, t)), `changing header byte ${i} fails (authenticated)`); }
  { const t = s1.slice(); t[45] ^= 1; ok(await throws(openObject(PASSWORD, t)), "changing a ciphertext byte fails"); }
  { const t = s1.slice(); t[11] = (t[11] + 1) & 255; ok(await throws(openObject(PASSWORD, t)), "changing the iterations fails"); }
  eq(parseHeader(te.encode("{\"format\":\"the-guys-backup\"} plain json file....................")), null, "a plain file is not a locked backup");
  // ── INTEROP: node:crypto opens what the function sealed ──
  { const o = nodeOpen(PASSWORD, s1); eq([o.kind, o.plain.toString("utf8")], [1, "hello, backup ✓"], "node:crypto (pbkdf2Sync + aes-256-gcm, header as AAD) decrypts a sealed object"); }
  ok((() => { try { nodeOpen("nope", s1); return false; } catch (_) { return true; } })(), "node:crypto refuses the wrong password");
  // ── VERIFIER ──
  const kSame = await deriveKey(PASSWORD, salt, FAST), kOther = await deriveKey(PASSWORD + "!", salt, FAST);
  eq([kSame.verifier === k.verifier, kOther.verifier === k.verifier, /^[0-9a-f]{64}$/.test(k.verifier)], [true, false, true], "verifier: same password+salt → same; another password → another");
  eq([needsPack({ bucket: "b", path: "p", size: 3, type: "" }, { size: 3, key_id: k.verifier }, k.verifier), needsPack({ bucket: "b", path: "p", size: 3, type: "" }, { size: 3, key_id: k.verifier }, kOther.verifier), needsPack({ bucket: "b", path: "p", size: 4, type: "" }, { size: 3, key_id: k.verifier }, k.verifier), needsPack({ bucket: "b", path: "p", size: 3, type: "" }, null, k.verifier)], [false, true, true, true], "after a password change every file packed under the old key counts as to do");

  // ── PACKS ──
  const MB = 1024 * 1024;
  const f = (path: string, size: number) => ({ bucket: "job-attachments", path, size, type: "image/png" });
  const plan = planPacks([f("c", 10 * MB), f("a", 7 * MB), f("b", 6 * MB), f("big", 17 * MB), f("huge", 21 * MB), f("d", 5 * MB)]);
  eq(plan.packs.map((p) => p.map((x) => x.path)), [["a", "b"], ["big"], ["c", "d"]], "planPacks: name order, ≤ 16 MB each, a 17 MB file gets its own pack");
  eq(plan.missing.map((m) => [m.path, m.reason]), [["huge", "too big"]], "planPacks: a 21 MB file is listed as missing, too big");
  eq(planPacks([]).packs.length, 0, "no files → no pack");
  eq(planPacks([f("a", 1), f("b", 1), f("c", 1)], new Set(["job-attachments/a", "job-attachments/b"])).packs.map((p) => p.map((x) => x.path)), [["a"], ["b"], ["c"]], "planPacks: the files of a pack that was cut off get a pack each");
  {
    const g = (n: number) => [f("x" + n, n)];
    const r = fitStorage([g(100), g(200), g(50)], 700, 1000);
    eq([r.fit.map((p) => p[0].size), r.noRoom.map((x) => x.size)], [[100, 200], [50]], "fitStorage: packs fit while the total stays under the limit; once one doesn't, the rest wait (no gaps)");
    eq([fitStorage([g(10)], 0).fit.length, fitStorage([g(10)], STORAGE_SAFE).noRoom.length, fitStorage([], 5).fit.length], [1, 1, 0], "fitStorage: STORAGE_SAFE by default");
  }
  { const k2 = await deriveKey(PASSWORD, salt, FAST), p = await sealParts(k2, 2, new Uint8Array([4, 5, 6])); eq([p.header.length, p.length, p.ct.length, Array.from((await openObject(PASSWORD, concatBytes([p.header, p.ct]))).plain)], [40, 40 + 3 + 16, 3 + 16, [4, 5, 6]], "sealParts: the header and the ciphertext separately, one after the other = the locked file"); }
  const files = [{ ...f("x/one.png", 3), bytes: new Uint8Array([1, 2, 3]) }, { ...f("two.pdf", 0), bytes: new Uint8Array(0) }, { ...f("three", 2), bytes: new Uint8Array([9, 8]) }];
  const built = buildPack("20261018-abcd1234", files);
  const rp = readPack(built.bytes)!;
  eq([rp.id, rp.files.map((x: any) => [x.path, x.offset, x.size]), Array.from(built.bytes.subarray(rp.start + 3 + 0, rp.start + 5))], ["20261018-abcd1234", [["x/one.png", 0, 3], ["two.pdf", 3, 0], ["three", 3, 2]], [9, 8]], "buildPack/readPack: offsets add up and give the exact bytes");
  eq(Array.from(built.bytes.subarray(rp.start, rp.start + 3)), [1, 2, 3], "the first file's bytes");
  { const bad = built.bytes.slice(); new DataView(bad.buffer).setUint32(0, 99999, false); eq(readPack(bad), null, "a header length beyond the buffer → null"); }
  eq(readPack(built.bytes.slice(0, built.bytes.length - 1)), null, "a file running past the end → null");

  // ── SLOTS (Sydney, daylight saving) ──
  const SUN3 = { send_day: 0, send_time: "03:00" };
  eq(new Date(lastSlot(SUN3, Date.parse("2026-10-04T17:00:00Z"))!).toISOString(), "2026-10-03T16:00:00.000Z", "Sunday 4 Oct 03:00 (the day summer time starts) = 16:00 UTC (AEDT)");
  eq(new Date(lastSlot(SUN3, Date.parse("2026-10-03T15:59:00Z"))!).toISOString(), "2026-09-26T17:00:00.000Z", "a minute before it: the week before, 27 Sep 03:00 AEST");
  eq(new Date(nextSlot(SUN3, Date.parse("2026-10-03T15:59:00Z"))!).toISOString(), "2026-10-03T16:00:00.000Z", "nextSlot over the change");
  eq(new Date(lastSlot(SUN3, Date.parse("2026-04-05T20:00:00Z"))!).toISOString(), "2026-04-04T17:00:00.000Z", "Sunday 5 Apr 03:00 (summer time ends at 03:00, back to 02:00) = 03:00 AEST = 17:00 UTC");
  eq(new Date(lastSlot(SUN3, Date.parse("2026-04-12T20:00:00Z"))!).toISOString(), "2026-04-11T17:00:00.000Z", "the next Sunday 03:00 AEST = 17:00 UTC too");
  { const t = lastSlot({ send_day: 0, send_time: "02:30" }, Date.parse("2026-10-05T00:00:00Z"))!; eq([sydParts(t).day, t === lastSlot({ send_day: 0, send_time: "02:30" }, Date.parse("2026-10-05T00:00:00Z"))], ["2026-10-04", true], "02:30 on 4 Oct does not exist: the slot stays on that Sunday and is the same each time"); }
  eq(new Date(lastSlot({ send_day: 1, send_time: "23:30" }, Date.parse("2026-10-19T13:00:00Z"))!).toISOString(), "2026-10-19T12:30:00.000Z", "Monday 23:30 Sydney = 12:30 UTC the same Monday");
  eq(new Date(nextSlot({ send_day: 1, send_time: "23:30" }, Date.parse("2026-10-19T12:31:00Z"))!).toISOString(), "2026-10-26T12:30:00.000Z", "and the next one is a week later");
  eq(lastSlot({ send_day: 7, send_time: "03:00" }, NOW), null, "unreadable settings → no slot");
  eq([sydWhen(Date.parse("2026-10-18T16:07:00Z")), sydDateShort(Date.parse("2026-10-18T16:07:00Z")), sydDateLong(Date.parse("2026-10-25T16:07:00Z")), timeText("15:05"), timeText("00:00")], ["Monday 19 Oct 2026, 3:07 am", "Mon 19 Oct 2026", "Monday 26 Oct", "3:05 pm", "12:00 am"], "Sydney texts");

  // ── DUE RULES ──
  const slot = Date.parse("2026-10-17T16:00:00Z");   // Sun 18 Oct 03:00 AEDT
  const due = (nowMs: number, o: any = {}) => slotDue({ cfg: cfgRow(o.cfg), state: o.state || { password_seen_at: "2026-10-01T00:00:00Z" }, runs: o.runs || [], nowMs, passwordSet: o.pw !== false });
  eq(due(slot - 60000).slot === slot, false, "not due before the slot (the latest slot is last week's... ");
  eq(due(slot - 60000).due, false, "...and last week's is more than 24 h ago: not due");
  eq([due(slot).due, due(slot + 14 * 60000).due, due(slot + 14 * 60000).attempt], [true, true, 1], "due at the slot and within 15 minutes after it");
  eq(due(slot + CATCH_UP_MS + 1).due, false, "not due more than 24 h after the slot");
  eq(due(slot + 60000, { cfg: { updated_at: new Date(slot + 1000).toISOString() } }).due, false, "a time changed after the slot doesn't trigger a run at once");
  eq(due(slot + 60000, { state: { password_seen_at: new Date(slot + 1000).toISOString() } }).due, false, "a slot before the password was first seen is skipped");
  eq(due(slot + 60000, { pw: false, state: { password_seen_at: null } }).due, true, "without the password the slot is still 'due' (it records waiting for the password)");
  eq(due(slot + 60000, { runs: [{ status: "done", attempt: 1 }] }).due, false, "not due when this slot already has a run");
  eq(due(slot + 60000, { runs: [{ status: "waiting_password", attempt: 1 }] }).due, false, "not due when this slot is waiting for the password");
  eq([due(slot + 60000, { runs: [{ status: "failed", attempt: 1 }] }).due, due(slot + 60000, { runs: [{ status: "failed", attempt: 1 }] }).attempt], [true, 2], "due again (attempt 2) after a failed attempt 1");
  eq(due(slot + 60000, { runs: [1, 2, 3].map((a) => ({ status: "failed", attempt: a })) }).due, false, "never after MAX_ATTEMPTS");

  // ── TABLES ──
  eq([pageInner("[]"), pageInner(' [{"a":"]"}] '), pageInner("[\n]")], ["", '{"a":"]"}', ""], "pageInner");
  ok(await throws((async () => pageInner('{"message":"x"}'))()), "a page that isn't a list throws");
  eq(orderParam(["id", 'we"ird']), '"id".asc,"we\\"ird".asc', "orderParam quotes the columns");
  eq([rowsInPage("0-999/2350", ""), rowsInPage("*/0", ""), rowsInPage("", '{"a":1},{"a":2}'), totalOf("0-999/2350"), totalOf("0-9/*")], [1000, 0, 2, 2350, null], "Content-Range");
  {
    REST = { big: Array.from({ length: 2350 }, (_, i) => ({ id: i, t: "r" + i })) };
    restCalls.length = 0;
    const chunks: Uint8Array[] = [];
    const w = makeJsonWriter((b) => { chunks.push(b); });
    const warnings: any[] = [];
    const counts = await writeData(w, { kind: "download", nowMs: NOW, files: [], files_missing: [] }, [{ table_name: "big", order_cols: ["id"] }], warnings);
    const out = JSON.parse(td.decode(concatBytes(chunks)));
    eq([restCalls.length, counts.big, out.tables.big.length, out.tables.big[2349].id, out.tables.big.every((r: any, i: number) => r.id === i), Object.keys(out), w.bytes() === concatBytes(chunks).length],
      [3, 2350, 2350, 2349, true, ["format", "version", "kind", "created_at", "created_sydney", "files", "files_missing", "tables", "counts", "warnings"], true], "2,350 rows in 3 pages → valid JSON, in order, keys in order");
    restCountLie = { big: 2351 };
    restCalls.length = 0;
    const w2: any[] = [];
    await writeData(makeJsonWriter(() => {}), { kind: "download", nowMs: NOW, files: [], files_missing: [] }, [{ table_name: "big", order_cols: ["id"] }], w2);
    eq([restCalls.length, w2], [6, [{ table: "big", expected: 2351, got: 2350 }]], "a count mismatch reads the table again once, then records a warning");
    restCountLie = {};
  }
  {
    const db = fakeDb();
    const all = REQUIRED_TABLES.filter((n) => n !== "ghl_archive").map((n) => ({ table_name: n, order_cols: ["id"] }));
    db.tables = all;
    eq(await backupTables(db).then(() => "ok", (e) => e.message), "missing table ghl_archive", "a missing required table fails loudly");
    db.tables = [...all, { table_name: "ghl_archive", order_cols: ["id"] }, ...EXCLUDED_TABLES.map((n) => ({ table_name: n, order_cols: ["id"] })), { table_name: "zz_new_table", order_cols: [] }];
    const list = (await backupTables(db)).map((t: any) => t.table_name);
    eq([EXCLUDED_TABLES.some((n) => list.includes(n)), list.includes("zz_new_table"), list[0], list.length], [false, true, "activity_log", REQUIRED_TABLES.length + 1], "excluded tables are left out; a new table is in; sorted by name");
    eq(["app_keys", "push_subscriptions", "backup_state", "backup_files", "backup_runs", "step_up", "passkeys", "passkey_challenges", "step_up_fails"].every((n) => EXCLUDED_TABLES.includes(n)), true, "the secrets and internals are excluded");
  }

  // ── EMAIL (pure) ──
  {
    const m = emailFor({ run: { slot: "2026-10-17T16:00:00.000Z" }, cfg: { email: "me@x.com" }, dataLink: { url: "https://d/1", bytes: 3.2 * MB }, packs: [{ url: "https://p/new", bytes: 12 * MB, isNew: true }, { url: "https://p/old", bytes: 30 * MB, isNew: false }], expiresAt: Date.parse("2026-10-24T16:07:00Z") });
    eq([m.to, m.subject], ["me@x.com", "Weekly backup of the OPS app, Sun 18 Oct 2026 (locked)"], "email: to the chosen address, the approved subject");
    eq(m.text.split("\n").slice(0, 7), ["The weekly backup is ready: every area of the app, and the uploaded files.", "It is locked with your backup password (the BACKUP_PASSWORD secret in Supabase).", "", "Download within 7 days (the links stop working on Sunday 25 Oct):", "", "Data, all areas (3.2 MB):", "https://d/1"], "email: the opening lines and the data link");
    ok(m.text.includes("Uploaded files, new this week (1 part, 12.0 MB):\nhttps://p/new") && m.text.includes("Uploaded files sent in earlier weeks (only if you don't have them yet):\nhttps://p/old") && m.text.includes("Open a locked backup") && m.text.includes("There is no restore button, on purpose"), "email: new parts, earlier parts, how to open, no restore", m.text);
    ok(m.text.includes(APP_URL + "?open=backup") && m.text.includes("No sign-in needed") && m.text.includes("sign-in page") && !m.text.includes("NOT in this backup"), "email: the files open from the sign-in page, without signing in", m.text);
    const full = emailFor({ run: { slot: "2026-10-17T16:00:00.000Z" }, cfg: { email: "me@x.com" }, dataLink: { url: "u", bytes: 1 }, packs: [], expiresAt: NOW, noRoom: 3 });
    ok(full.text.includes("3 uploaded files are NOT in this backup: the project's storage on the free Supabase plan (1 GB) is nearly full."), "email: files left out for lack of storage are named", full.text);
    ok(!emailFor({ run: { slot: "2026-10-17T16:00:00.000Z" }, cfg: { email: "me@x.com" }, dataLink: { url: "u", bytes: 1 }, packs: [], expiresAt: NOW }).text.includes("Uploaded files"), "email: no file lines when there are no packs");
  }

  // ── AUTH ──
  {
    ENV.BACKUP_PASSWORD = PASSWORD; ENV.BACKUP_CRON_SECRET = CRON;
    const db = fakeDb({ backup_settings: [cfgRow()], backup_state: [{ id: 1 }] });
    for (const [name, hdr] of [["no header", {}], ["a wrong header", { "x-backup-secret": "nope" }]] as [string, any][]) {
      const r = await handle(db, { step: "tick" }, null, H(hdr), NOW);
      eq([r.status, await r.json(), db.calls.length, pending.length], [401, { ok: false, error: "unauthorized" }, 0, 0], `tick with ${name} → 401, nothing read`);
    }
    ENV.BACKUP_CRON_SECRET = "";
    { const r = await handle(db, { step: "tick" }, null, H({ "x-backup-secret": "" }), NOW); eq([r.status, db.calls.length], [401, 0], "tick with an empty BACKUP_CRON_SECRET → 401"); }
    ENV.BACKUP_CRON_SECRET = CRON;
    eq([sameSecret("abc", "abc"), sameSecret("abc", "abd"), sameSecret("", ""), sameSecret("abc", "abcd")], [true, false, false, false], "secret compare");
    for (const step of ["status", "config", "download"]) {
      for (const me of [null, { ...OWNER, role: "manager" }, { ...OWNER, role: "va" }, { ...OWNER, role: "technician" }]) {
        const r = await handle(db, { step, email: "a@b.co" }, me, H({}), NOW);
        eq([r.status, (await r.json()).reason], [403, "owners only"], `${step} as ${me ? me.role : "nobody"} → 403`);
      }
    }
    eq((await handle(db, { step: "nope" }, OWNER, H({}), NOW)).status, 400, "unknown step → 400");
    eq(db.calls.length, 0, "refused calls read nothing");
    { const r = await handle(db, { step: "download" }, OWNER, H({}), NOW); eq([r.status, (await r.json()).reason], [403, "step_up"], "download without a step-up → 403 step_up"); }
    db.T.step_up.push({ user_id: OWNER.id, session_id: SID, until: new Date(NOW - 1000).toISOString() });
    { const r = await handle(db, { step: "download" }, OWNER, H({}), NOW); eq((await r.json()).reason, "step_up", "an expired step-up doesn't count"); }
    { const r = await handle(db, { step: "download" }, { ...OWNER, sessionId: "33333333-2222-4333-8444-555555555555" }, H({}), NOW); eq((await r.json()).reason, "step_up", "another session's step-up doesn't count"); }
    db.T.step_up = [];
    { const r = await handle(db, { step: "config", email: "New@Example.com " }, OWNER, H({}), NOW); eq([r.status, (await r.json()).reason, db.T.backup_settings[0].email], [403, "step_up", "info@theguyservicegroup.com"], "a new address without a step-up → 403 step_up, nothing saved"); }
    for (const [b, why] of [[{ email: "a@b" }, "email"], [{ email: "x".repeat(250) + "@b.co" }, "email"], [{ day: 7 }, "day"], [{ day: "1.5" }, "day"], [{ time: "24:00" }, "time"], [{ time: "3:00" }, "time"]] as [any, string][]) {
      const r = await handle(db, { step: "config", ...b }, OWNER, H({}), NOW);
      eq([r.status, (await r.json()).reason], [400, why], `config ${JSON.stringify(b).slice(0, 30)} → 400 ${why}`);
    }
    {
      const r = await handle(db, { step: "config", day: 3, time: "23:30" }, OWNER, H({}), NOW);
      const o = await r.json();
      eq([r.status, o.ok, o.config.day, o.config.time, db.T.backup_settings[0].send_day, db.T.backup_settings[0].updated_by, db.T.activity_log.length, db.T.activity_log[0]], [200, true, 3, "23:30", 3, "Ofek Shamir", 1, { record_kind: "settings", record_id: "global", actor: "Ofek Shamir", text: "Data: the weekly backup is sent on Wednesday at 11:30 pm", manual: true }], "day and time need no step-up; one Settings history row");
      eq(o.nextAt, "2026-10-21T12:30:00.000Z", "nextAt: Wednesday 21 Oct 23:30 Sydney");
    }
    db.T.step_up.push({ user_id: OWNER.id, session_id: SID, until: new Date(NOW + 60000).toISOString() });
    {
      const r = await handle(db, { step: "config", email: " Backup@Example.COM" }, OWNER, H({}), NOW);
      const o = await r.json();
      eq([r.status, db.T.backup_settings[0].email, o.text, db.T.activity_log.length], [200, "backup@example.com", "Data: the weekly backup goes to backup@example.com (was info@theguyservicegroup.com)", 2], "a new address with a step-up is saved (lowercase) and logged once");
      const same = await (await handle(db, { step: "config", email: "backup@example.com" }, OWNER, H({}), NOW)).json();
      eq([same.ok, same.text, db.T.activity_log.length], [true, "", 2], "the same value again changes and logs nothing");
    }
  }

  // ── NO PASSWORD ──
  {
    ENV.BACKUP_PASSWORD = "";
    const db = fakeDb({ backup_settings: [cfgRow()], backup_state: [{ id: 1, password_seen_at: null }] });
    NOW = slot + 5 * 60000;
    const r = await handle(db, { step: "tick" }, null, H({ "x-backup-secret": CRON }), NOW);
    eq([r.status, await r.json()], [202, { ok: true }], "tick answers 202 at once");
    await settle();
    eq([db.T.backup_runs.length, db.T.backup_runs[0].status, db.T.backup_runs[0].slot, db.T.backup_state[0].password_seen_at], [1, "waiting_password", new Date(slot).toISOString(), null], "no password: one 'waiting_password' run, password_seen_at stays empty");
    eq([db.calls.filter((c: string) => c.startsWith("storage") || c.startsWith("rpc")).length, db.T.backup_runs[0].email_status ?? null], [0, null], "no password: no storage, no rpc, no email");
    restCalls.length = 0;
    await handle(db, { step: "tick" }, null, H({ "x-backup-secret": CRON }), NOW + 15 * 60000); await settle();
    eq([db.T.backup_runs.length, restCalls.length], [1, 0], "a second tick in the same slot adds nothing and reads no table");
    const st = await (await handle(db, { step: "status" }, OWNER, H({}), NOW)).json();
    eq([st.ok, st.passwordSet, st.timerOk, st.last.status, st.config.email], [true, false, true, "waiting_password", "info@theguyservicegroup.com"], "status: password not set, timer running, waiting");
  }

  // ── FULL WEEKLY RUN ──
  ENV.BACKUP_PASSWORD = PASSWORD;
  const weeklyDb = () => {
    const db = fakeDb({ backup_settings: [cfgRow({ email: "owner@example.com" })], backup_state: [{ id: 1, password_seen_at: "2026-10-01T00:00:00.000Z" }] });
    db.put("job-attachments", "contractors/c1/insurance-1.pdf", new Uint8Array([1, 2, 3, 4]), "application/pdf");
    db.put("employee-documents", "e1/licence-2.png", new Uint8Array([5, 6]), "image/png");
    db.put("branding", "logo-3.svg", te.encode("<svg/>"), "image/svg+xml");
    return db;
  };
  REST = baseTables();
  async function tick(db: any, at: number) { NOW = at; const r = await handle(db, { step: "tick" }, null, H({ "x-backup-secret": CRON }), NOW); await settle(); return r.status; }
  async function openData(db: any, run: any) {
    const o = await openObject(PASSWORD, db.store.get("backups/" + run.data_path));
    return { kind: o.kind, data: JSON.parse(zlib.gunzipSync(Buffer.from(o.plain)).toString("utf8")) };
  }
  const db1 = weeklyDb();
  restCalls.length = 0;
  eq(await tick(db1, slot + 5 * 60000), 202, "weekly tick accepted");
  const run1 = db1.T.backup_runs[0];
  const keys1 = [...db1.store.keys()].filter((x: string) => x.startsWith("backups/"));
  eq([run1.status, run1.email_status, run1.email_to, run1.links_expire_at, keys1.length, keys1.every((x: string) => x.endsWith(".locked")), run1.packs.length, run1.files_total, run1.lease_until],
    ["done", "queued", "owner@example.com", new Date(slot + 5 * 60000 + 7 * 864e5).toISOString(), 2, true, 1, 3, null], "one tick: 1 pack + 1 data file, done, email queued to the chosen address, links for 7 days");
  ok(!restCalls.some((t) => EXCLUDED_TABLES.includes(t)), "excluded tables are never requested", restCalls);
  {
    const { kind, data } = await openData(db1, run1);
    eq([kind, data.format, data.version, data.kind, Object.keys(data.tables).length, data.counts.contacts, data.tables.contacts[0].full_name, data.created_sydney], [1, "the-guys-backup", 1, "weekly", REQUIRED_TABLES.length, 2, 'Sarah ]} "Jones"', "Sunday 18 Oct 2026, 3:05 am"], "the data file opens, gunzips and has every table with its counts");
    eq(data.files.map((x: any) => [x.bucket, x.path, x.size, x.pack === run1.packs[0]]), [["branding", "logo-3.svg", 6, true], ["employee-documents", "e1/licence-2.png", 2, true], ["job-attachments", "contractors/c1/insurance-1.pdf", 4, true]], "each file is mapped to its pack");
    const pack = await openObject(PASSWORD, db1.store.get("backups/packs/" + run1.packs[0] + ".locked"));
    const rp1 = readPack(pack.plain)!;
    const ins = data.files.find((x: any) => x.path.endsWith("insurance-1.pdf"));
    eq([pack.kind, rp1.id, Array.from(pack.plain.subarray(rp1.start + ins.offset, rp1.start + ins.offset + ins.size))], [2, run1.packs[0], [1, 2, 3, 4]], "the pack opens by itself and the offset gives the file's bytes");
    ok(nodeOpen(PASSWORD, db1.store.get("backups/" + run1.data_path)).kind === 1, "node:crypto opens the weekly data file too");
  }
  ok(run1.email_body.includes("https://signed.example/backups/" + run1.data_path) && run1.email_body.includes("Uploaded files, new this week (1 part,") && !run1.email_body.includes(PASSWORD), "the email has the links and not the password", run1.email_body);
  ok(run1.email_body.includes("the links stop working on Sunday 25 Oct"), "the email says when the links stop");
  {
    const st = await (await handle(db1, { step: "status" }, OWNER, H({}), NOW)).json();
    const body = JSON.stringify(st);
    eq([st.passwordSet, st.last.status, st.last.email_status, st.last.files_total], [true, "done", "queued", 3], "status after the run");
    ok(!body.includes(PASSWORD) && !body.includes(CRON) && !body.includes("SIGNEDTOKEN") && !body.includes("email_body") && !body.includes("Download within"), "status never shows the password, the timer secret, the email or any link", body);
  }
  await tick(db1, slot + 20 * 60000);
  eq(db1.T.backup_runs.length, 1, "a later tick in the same week does nothing more");

  // ── RESUME ──
  {
    const db = weeklyDb();
    db.put("job-attachments", "receipts/big-a.jpg", new Uint8Array(12 * MB), "image/jpeg");
    db.put("job-attachments", "receipts/big-b.jpg", new Uint8Array(12 * MB), "image/jpeg");
    const realUpload = io.upload;
    let uploads = 0;
    io.upload = async (s: any, p: string, b: Uint8Array) => { await realUpload(s, p, b); uploads++; if (uploads === 1) NOW += TICK_BUDGET_MS; };
    await tick(db, slot + 5 * 60000);
    const r = db.T.backup_runs[0];
    eq([r.status, r.lease_until, r.progress.new_packs.length, db.T.backup_files.length > 0], ["running", null, 1, true], "budget used up after the first pack: still running, lease let go, progress saved");
    const packedFirst = db.T.backup_files.map((x: any) => x.path + ":" + x.pack).sort().join();
    r.lease_until = new Date(NOW + 60000).toISOString();
    eq(await continueRun(db, { ...r }), "busy", "a second continue can't claim the lease while it is in the future");
    r.lease_until = null;
    const downloadsBefore = db.calls.filter((c: string) => c === "storage.download").length;
    await tick(db, NOW + 15 * 60000);
    io.upload = realUpload;
    const r2 = db.T.backup_runs[0];
    const firstStill = packedFirst.split(",").every((x: string) => db.T.backup_files.some((y: any) => y.path + ":" + y.pack === x));
    eq([r2.status, r2.progress.new_packs.length, firstStill, db.calls.filter((c: string) => c === "storage.download").length - downloadsBefore], ["done", 2, true, 1], "the next tick finishes it without repacking what was packed (1 more download)");
    ok(r2.email_body.includes("Uploaded files, new this week (2 parts,"), "both new parts are in the email");
  }

  // ── INCREMENTAL + RETENTION ──
  {
    const db = db1;
    const week = 7 * 864e5;
    db.put("job-attachments", "receipts/new-week2.jpg", new Uint8Array([7, 7, 7]), "image/jpeg");
    await tick(db, slot + week + 5 * 60000);
    const w2 = db.T.backup_runs.find((r: any) => r.slot === new Date(slot + week).toISOString());
    eq([w2.status, w2.progress.new_packs.length, w2.packs.length], ["done", 1, 2], "week 2: exactly 1 new pack, the index uses 2");
    const iNew = w2.email_body.indexOf("new this week"), iOld = w2.email_body.indexOf("earlier weeks");
    ok(iNew > 0 && iOld > iNew && w2.email_body.slice(iNew, iOld).includes(w2.progress.new_packs[0].id) && w2.email_body.slice(iOld).includes(run1.packs[0]), "the email lists the new pack as new and the old one under earlier weeks");
    // the file of week 1 is deleted from the app: its pack stays while a kept run needs it
    db.store.delete("employee-documents/e1/licence-2.png");
    db.store.delete("branding/logo-3.svg");
    db.store.delete("job-attachments/contractors/c1/insurance-1.pdf");
    for (let wk = 2; wk <= KEEP_RUNS + 1; wk++) await tick(db, slot + wk * week + 5 * 60000);
    const done = db.T.backup_runs.filter((r: any) => r.status === "done").sort((a: any, z: any) => (a.slot < z.slot ? -1 : 1));
    eq([done.length, done[0].data_path, db.store.has("backups/" + run1.data_path), done.slice(1).every((r: any) => r.data_path && db.store.has("backups/" + r.data_path))], [KEEP_RUNS + 2, null, false, false], "after more than KEEP_RUNS runs the oldest data files are removed (data_path null)");
    const keptRuns = done.slice(-KEEP_RUNS);
    eq([keptRuns.every((r: any) => r.data_path && db.store.has("backups/" + r.data_path)), done.slice(0, 2).every((r: any) => r.data_path === null)], [true, true], "the newest KEEP_RUNS data files stay");
    eq([db.store.has("backups/packs/" + run1.packs[0] + ".locked"), db.T.backup_files.some((x: any) => x.pack === run1.packs[0])], [false, false], "a pack used only by removed runs is deleted with its rows");
    const newPack = w2.progress.new_packs[0].id;
    eq([db.store.has("backups/packs/" + newPack + ".locked"), db.T.backup_files.some((x: any) => x.pack === newPack)], [true, true], "the pack kept runs need stays");
  }

  // ── ERRORS ──
  {
    const db = weeklyDb();
    db.failDownload = (b: string, p: string) => p === "e1/licence-2.png";
    await tick(db, slot + 5 * 60000);
    const r = db.T.backup_runs[0];
    const { data } = await openData(db, r);
    eq([r.status, data.files.length, data.files_missing.map((x: any) => [x.path, x.reason]), data.warnings.length], ["done", 2, [["e1/licence-2.png", "could not be read"]], 1], "a file that can't be read: a warning, listed as missing, the run still finishes");
    db.failDownload = null;
    await tick(db, slot + 7 * 864e5 + 5 * 60000);
    const r2 = db.T.backup_runs.find((x: any) => x.slot === new Date(slot + 7 * 864e5).toISOString());
    const d2 = (await openData(db, r2)).data;
    eq([r2.progress.new_packs.length, d2.files.length, d2.files_missing.length], [1, 3, 0], "next week it is tried again and packed");
  }
  {
    const db = weeklyDb();
    const keep = io.listTables;
    io.listTables = async () => { throw new Error("database down"); };
    for (let i = 1; i <= MAX_ERRORS; i++) {
      await tick(db, slot + 5 * 60000 + i * 15 * 60000);
      const r = db.T.backup_runs[0];
      eq([r.errors, r.status, r.error, r.lease_until], [i, i < MAX_ERRORS ? "running" : "failed", "database down", null], `an error in the data phase: errors ${i}`);
    }
    io.listTables = keep;
    await tick(db, slot + 5 * 60000 + 4 * 15 * 60000);
    eq([db.T.backup_runs.length, db.T.backup_runs[1].attempt, db.T.backup_runs[1].status], [2, 2, "done"], "after a failed attempt the next tick starts attempt 2");
  }
  {
    // a failure after the data file was stored: the next tick stores a new copy (an upload never overwrites) and the
    // earlier copy goes
    const db = weeklyDb();
    const keep = io.signedUrl;
    io.signedUrl = async () => { throw new Error("links down"); };
    await tick(db, slot + 5 * 60000);
    const r = db.T.backup_runs[0], first = r.data_path;
    eq([r.status, r.errors, !!first && db.store.has("backups/" + first)], ["running", 1, true], "links failed after the data was stored: still running, 1 error");
    io.signedUrl = keep;
    await tick(db, slot + 20 * 60000);
    const runsData = [...db.store.keys()].filter((k: string) => k.startsWith("backups/runs/"));
    eq([r.status, r.data_path !== first, db.store.has("backups/" + first), runsData.length], ["done", true, false, 1], "the next tick finishes with a new data file and removes the earlier copy");
  }
  {
    const db = weeklyDb();
    db.T.backup_runs.push({ id: "r-old", kind: "weekly", slot: new Date(slot).toISOString(), attempt: 1, status: "running", started_at: new Date(slot - 7 * 3600e3).toISOString(), errors: 0, progress: {}, packs: [] });
    await tick(db, slot + 5 * 60000);
    eq([db.T.backup_runs[0].status, db.T.backup_runs[0].error], ["failed", "took too long"], "a run started more than 6 h ago is marked failed");
  }
  {
    const db = weeklyDb();
    db.T.backup_settings[0].email = "not-an-email";
    await tick(db, slot + 5 * 60000);
    eq([db.T.backup_runs.length, db.T.backup_runs[0].status, db.calls.filter((c: string) => c.startsWith("storage")).length], [1, "no_email", 0], "no valid address: 'no_email', nothing read");
  }
  {
    // a changed password repacks every file under the new one
    const db = weeklyDb();
    await tick(db, slot + 5 * 60000);
    const v1 = db.T.backup_state[0].verifier;
    ENV.BACKUP_PASSWORD = "a brand new passphrase";
    await tick(db, slot + 7 * 864e5 + 5 * 60000);
    const r2 = db.T.backup_runs[1];
    eq([db.T.backup_state[0].verifier !== v1, r2.progress.new_packs.length, db.T.backup_files.every((x: any) => x.key_id === db.T.backup_state[0].verifier)], [true, 1, true], "a new password: new verifier, every file packed again");
    ok(await throws(openObject(PASSWORD, db.store.get("backups/" + r2.data_path))) && !!(await openObject("a brand new passphrase", db.store.get("backups/" + r2.data_path))), "the new data file opens only with the new password");
    ENV.BACKUP_PASSWORD = PASSWORD;
  }

  // ── A PACK CUT OFF (the worker stopped mid-pack: no catch ran) ──
  {
    const db = weeklyDb();
    const F = (bucket: string, path: string, size: number) => ({ bucket, path, size });
    db.T.backup_runs.push({ id: "r-cut", kind: "weekly", slot: new Date(slot).toISOString(), attempt: 1, status: "running", started_at: new Date(slot + 60000).toISOString(), errors: 0, packs: [], email_to: "owner@example.com",
      progress: { new_packs: [], skipped: [], inflight: { files: [F("branding", "logo-3.svg", 6), F("employee-documents", "e1/licence-2.png", 2)] } } });
    await tick(db, slot + 20 * 60000);
    const r = db.T.backup_runs[0];
    const packOf = (p: string) => db.T.backup_files.find((x: any) => x.path === p).pack;
    eq([r.status, r.progress.new_packs.length, packOf("logo-3.svg") !== packOf("e1/licence-2.png"), packOf("e1/licence-2.png") !== packOf("contractors/c1/insurance-1.pdf"), r.progress.inflight, r.warnings.some((w: any) => /packed one by one/.test(w.note || ""))], ["done", 3, true, true, null, true], "a pack that was cut off: its files are packed one by one next time, the run finishes and says why");
  }
  {
    const db = weeklyDb();
    db.T.backup_runs.push({ id: "r-cut1", kind: "weekly", slot: new Date(slot).toISOString(), attempt: 1, status: "running", started_at: new Date(slot + 60000).toISOString(), errors: 0, packs: [], email_to: "owner@example.com",
      progress: { new_packs: [], skipped: [], inflight: { files: [{ bucket: "branding", path: "logo-3.svg", size: 6 }] } } });
    const before = db.calls.filter((c: string) => c === "storage.download").length;
    await tick(db, slot + 20 * 60000);
    const r = db.T.backup_runs[0], { data } = await openData(db, r);
    eq([r.status, db.calls.filter((c: string) => c === "storage.download").length - before, data.files_missing.map((x: any) => [x.path, x.reason])], ["done", 2, [["logo-3.svg", "could not be packed (the backup stopped while packing it)"]]], "a single file that was cut off is left out (never tried for ever), with the reason; the others are packed");
  }
  {
    // the progress is noted BEFORE a pack's downloads, and cleared once its upload is saved
    const db = weeklyDb();
    const seen: any[] = [];
    const keepDl = io.download;
    io.download = async (s: any, b: string, p: string) => { seen.push(JSON.parse(JSON.stringify(db.T.backup_runs[0].progress.inflight || null))); return keepDl(s, b, p); };
    await tick(db, slot + 5 * 60000);
    io.download = keepDl;
    eq([seen.length, seen.every((x: any) => x && x.files.length === 3), db.T.backup_runs[0].progress.inflight], [3, true, null], "inflight: saved with the pack's files before its downloads, cleared after its upload");
  }

  {
    // an ordinary error mid-pack (the catch ran): the pack is tried again whole next time, nothing is left out
    const db = weeklyDb();
    const keepUp = io.upload;
    let n = 0;
    io.upload = async (s: any, p: string, b: Uint8Array[]) => { if (++n === 1) throw new Error("storage 502"); return keepUp(s, p, b); };
    await tick(db, slot + 5 * 60000);
    const r1 = JSON.parse(JSON.stringify(db.T.backup_runs[0]));
    await tick(db, slot + 20 * 60000);
    io.upload = keepUp;
    const r = db.T.backup_runs[0], { data } = await openData(db, r);
    eq([r1.status, r1.errors, r1.progress.inflight, r.status, r.progress.new_packs.length, data.files.length, data.files_missing.length], ["running", 1, null, "done", 1, 3, 0], "an upload error mid-pack: counted once, the same pack is made whole on the next tick");
  }

  // ── STORAGE (free plan: 1 GB of files) ──
  {
    const db = weeklyDb();
    // an earlier week's data file that (pretend) nearly fills the plan
    db.T.backup_runs.push({ id: "r-big", kind: "weekly", slot: new Date(slot - 7 * 864e5).toISOString(), attempt: 1, status: "done", started_at: new Date(slot - 7 * 864e5).toISOString(), finished_at: new Date(slot - 7 * 864e5 + 60000).toISOString(), errors: 0, packs: [], data_path: "runs/old/data-1.locked", data_bytes: STORAGE_SAFE - 5, progress: {} });
    await tick(db, slot + 5 * 60000);
    const r = db.T.backup_runs.find((x: any) => x.slot === new Date(slot).toISOString());
    const { data } = await openData(db, r);
    eq([r.status, r.packs.length, db.calls.filter((c: string) => c === "storage.download").length, data.files.length, data.files_missing.map((x: any) => x.reason), data.counts.contacts], ["done", 0, 0, 0, ["not enough storage on the free plan", "not enough storage on the free plan", "not enough storage on the free plan"], 2], "not enough room: no file is packed (nothing downloaded), the data file is still made with every table");
    ok(r.warnings.some((w: any) => w.storage_full && w.files === 3) && r.email_body.includes("3 uploaded files are NOT in this backup"), "the run's warnings and the email say so", r.email_body);
    const st = await (await handle(db, { step: "status" }, OWNER, H({}), NOW)).json();
    eq([st.last.status, st.last.storage_full], ["done", 3], "status tells the Data page: 3 files left out for lack of storage");
  }

  // ── RETENTION FAILS AFTER THE RUN IS DONE ──
  {
    const db = weeklyDb();
    for (let wk = 1; wk <= KEEP_RUNS; wk++) {
      const sl = new Date(slot - wk * 7 * 864e5).toISOString(), dp = `runs/old-${wk}/data.locked`;
      db.store.set("backups/" + dp, new Uint8Array([1]));
      db.T.backup_runs.push({ id: "r-old-" + wk, kind: "weekly", slot: sl, attempt: 1, status: "done", started_at: sl, finished_at: sl, errors: 2, packs: [], data_path: dp, progress: {} });
    }
    const keepRm = io.remove;
    io.remove = async () => { throw new Error("storage 503"); };
    await tick(db, slot + 5 * 60000);
    io.remove = keepRm;
    const r = db.T.backup_runs.find((x: any) => x.slot === new Date(slot).toISOString());
    eq([r.status, r.errors, r.error, r.email_status, r.lease_until], ["done", 0, null, "queued", null], "a failed clean-up after the run is done leaves the finished, emailed run exactly as it is");
    await tick(db, slot + 20 * 60000);
    eq(db.T.backup_runs.filter((x: any) => x.slot === new Date(slot).toISOString()).length, 1, "and no second backup (no attempt 2) starts for the same week");
  }
  {
    // the error path never changes a run that is already done
    const db = weeklyDb();
    db.T.backup_runs.push({ id: "r-done", kind: "weekly", slot: new Date(slot).toISOString(), attempt: 1, status: "running", started_at: new Date(slot).toISOString(), errors: 2, packs: [], progress: {} });
    const keepList = io.listTables;
    io.listTables = async () => { db.T.backup_runs[0].status = "done"; throw new Error("late failure"); };   // finished elsewhere meanwhile
    await tick(db, slot + 5 * 60000);
    io.listTables = keepList;
    eq([db.T.backup_runs[0].status, db.T.backup_runs[0].errors, db.T.backup_runs[0].error ?? null], ["done", 2, null], "an error after the run is done elsewhere: the done run is not turned into failed");
  }

  // ── DOWNLOAD STEP ──
  {
    const db = weeklyDb();
    db.T.step_up.push({ user_id: OWNER.id, session_id: SID, until: new Date(NOW + 60000).toISOString() });
    const r = await handle(db, { step: "download" }, OWNER, H({}), NOW);
    const text = await r.text();
    await settle();
    const o = JSON.parse(text);
    eq([r.status, o.kind, o.files.length, o.files.every((x: any) => /^https:\/\/signed\.example\/.+\?e=3600/.test(x.url)), o.counts.contacts, Object.keys(o.tables).length], [200, "download", 3, true, 2, REQUIRED_TABLES.length], "download: the plain JSON streams back, every file with a 1-hour link");
    const run = db.T.backup_runs[0];
    eq([run.kind, run.status, run.by_name, db.T.activity_log.map((a: any) => a.text), db.calls.includes("storage.upload"), run.email_status ?? null], ["download", "done", "Ofek Shamir", ["Data: full backup downloaded"], false, null], "a 'download' run ends done, one history line, no upload, no email");
    // a file that can't be signed (deleted meanwhile): listed as missing, never sent with an empty link
    db.failSign = (_b: string, p: string) => p === "e1/licence-2.png";
    const r3 = await handle(db, { step: "download" }, OWNER, H({}), NOW);
    const o3 = JSON.parse(await r3.text());
    await settle();
    db.failSign = null;
    eq([o3.files.length, o3.files.every((x: any) => !!x.url), o3.files_missing], [2, true, [{ bucket: "employee-documents", path: "e1/licence-2.png", size: 2, reason: "could not be signed" }]], "download: a file without a link is in files_missing, not in files with url ''");
    db.T.activity_log = db.T.activity_log.slice(0, 1);
    // an error mid-stream: the body is cut off and the run is failed
    const keep = io.rest;
    let n = 0;
    io.rest = async (t: string, q: string, p?: string) => { if (++n > 5) throw new Error("connection lost"); return keep(t, q, p); };
    const r2 = await handle(db, { step: "download" }, OWNER, H({}), NOW);
    const cut = await r2.text().then(() => "complete", () => "aborted");
    await settle();
    io.rest = keep;
    const lastRun = db.T.backup_runs[db.T.backup_runs.length - 1];
    eq([cut, lastRun.status, lastRun.error, db.T.activity_log.length], ["aborted", "failed", "connection lost", 1], "an error mid-stream aborts the body and fails the run");
  }

  // ── status when the SQL isn't run yet ──
  {
    const db = fakeDb({ __missing_backup_settings: [1] } as any);
    delete db.T.backup_settings;
    const st = await (await handle(db, { step: "status" }, OWNER, H({}), NOW)).json();
    eq(st, { ok: false, reason: "not_set_up" }, "status before the SQL: not set up");
  }
  eq(jwtPayload("x." + btoa(JSON.stringify({ sub: "u1", session_id: SID })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") + ".y").session_id, SID, "jwtPayload reads the session id");

  console.log(`backup: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit?.(1);
})().catch((e) => { console.log("backup tests crashed:", e); (globalThis as any).process?.exit?.(1); });
