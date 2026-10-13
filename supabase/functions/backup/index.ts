// backup: the weekly automatic, password-locked full backup, and the owner's "Download full backup" (settings round 2,
// phase 3: plan item 5, problem P5, mockup answers M6 1-2). The project is on Supabase FREE, which has no daily backups,
// so this is the business's copy of its data outside the app. There is NO restore, on purpose (P5).
//
// POST { step }:
//   tick      the timer (pg_cron 'backup-weekly-check', every 15 minutes, header x-backup-secret = BACKUP_CRON_SECRET).
//             Answers 202 at once (pg_net gives up after 10 s) and works in the background (EdgeRuntime.waitUntil):
//             when this week's Sydney day and time (Settings → Data) has come, it makes the weekly backup:
//               1. FILES: every uploaded file (receipts, insurance certificates, employee documents, logos) is copied into
//                  locked "packs" of at most 16 MB (small enough that a pack's few copies in memory stay far under the
//                  free plan's 256 MB). Files never change once uploaded, so each one is packed ONCE and later weeks
//                  only pack the new ones. Work stops starting new packs after 90 s and goes on at the next 15-minute
//                  tick (the first run may take a few ticks). A pack that was cut off (the worker stopped mid-pack) is
//                  noted before it starts, so the next tick packs its files one by one, and a single file that was
//                  cut off is left out (listed, with the reason) instead of being tried for ever.
//                  STORAGE: the packs are a second copy of the uploads in the same project (free plan: 1 GB of files
//                  in all), so packing stops before the project would pass STORAGE_SAFE (800 MB): the files left out
//                  are listed as "not enough storage on the free plan", the email and the Data page say so, and the
//                  data file is still made.
//               2. DATA: every table in public (except the few secrets in EXCLUDED_TABLES), read page by page past the
//                  1,000-row cap, written as one JSON (raw rows, gzip) and locked.
//               3. EMAIL: a 7-day download link per locked file, queued in backup_runs and sent by the info@ Apps Script
//                  through conversations?step=alerts (the same sender as the chat emails; no attachment: M6-2).
//               4. RETENTION: the data files of the last 4 weekly backups are kept; packs no kept backup needs are deleted.
//             Without the BACKUP_PASSWORD secret nothing is read or sent: the run is recorded as 'waiting_password'.
//             The locked files open WITHOUT signing in (so also when this Supabase project is gone): the app's sign-in
//             page has "Open a locked backup" (the same in-browser reader as Settings → Data); the email says so.
//   status    (owner) for the Data page: is the password set (yes/no only), the timer, the day/time/address, the last run.
//   config    (owner) { email?, day?, time? }. A new address needs the Security step-up (Face ID / password, 30 minutes),
//             checked here on the server; day and time do not.
//   download  (owner + step-up) "Download full backup": the same data JSON, NOT locked (the mockup says so), streamed
//             straight back, with a 1-hour link for every uploaded file (the app puts them into one .zip).
//
// LOCKED FILE FORMAT (the app's "Open a locked backup" reads the same; see index.html, backupParseHeader):
//   40-byte HEADER, then AES-256-GCM ciphertext with its 16-byte tag.
//   Header: bytes 0-5 ASCII 'TGBKUP'; byte 6 version = 1; byte 7 kind (1 = data: gzip of UTF-8 JSON; 2 = file pack);
//           bytes 8-11 PBKDF2 iterations (uint32 big-endian); bytes 12-27 salt (16 bytes); bytes 28-39 IV (12 random bytes,
//           new for EVERY object). Additional authenticated data = the 40 header bytes (changing any of them fails).
//   Key = PBKDF2-HMAC-SHA-256(BACKUP_PASSWORD as UTF-8, salt, iterations = 600000) → 256 bits → AES-GCM key.
//   PACK plaintext: uint32 big-endian length L of a UTF-8 JSON header {v:1, id, files:[{bucket, path, type, size, offset}]}
//           (offset counted from the first byte after that header), then the header, then the files' bytes. A pack
//           describes itself, so it opens without the data file.
//   The salt is made once (backup_state) and reused, the key is derived once per call; key_id = the verifier =
//   hex SHA-256('tgbk-verify:' || the 32 key bytes). A changed password gives another verifier, and then every file
//   is packed again under the new password at the next run.
//
// Limits (free plan: 2 s CPU, 256 MB memory, 150 s wall clock): rows are passed through as PostgREST's own text (no
// JSON.parse), gzip and AES-GCM are native, PBKDF2 runs once per call, packs are at most 16 MB and a file at most 20 MB
// (a bigger one is listed as missing, "too big"); a pack's downloads are dropped once copied, and the upload is a Blob of
// [header, ciphertext] (no third copy).
//
// Deploy with Verify JWT OFF (like push): the timer calls it without a login; the function checks every caller itself.
// Owner steps (once): run the F-backup section of .claude/sql/settings-round2-phase3.sql; make a random timer secret and
// store it BOTH in Vault (name 'backup_cron_secret') and as the function secret BACKUP_CRON_SECRET; add the function secret
// BACKUP_PASSWORD (a long passphrase, kept in a password manager: without it no backup can be opened); deploy this
// function; redeploy conversations. Secrets are only read with Deno.env.get and are never logged, returned or stored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : "") || "";

export const ITERATIONS = 600000;
export const PACK_MAX = 16 * 1024 * 1024;     // one pack (its copies in memory stay well under 256 MB)
export const OBJECT_MAX = 20 * 1024 * 1024;   // one uploaded file; a bigger one is listed as missing ("too big")
export const DATA_MAX = 48 * 1024 * 1024;     // the locked data file (the bucket's own cap is 50 MB)
export const STORAGE_SAFE = 800 * 1024 * 1024;   // all files of the project after packing (free plan: 1 GB)
export const APP_URL = "https://theguysgroup.github.io/the-guys-ops-app/";
export const LINK_DAYS = 7;
export const KEEP_RUNS = 4;
export const TICK_BUDGET_MS = 90000;      // no new pack is started after this; the next tick goes on
export const DATA_START_MS = 30000;       // the data phase starts only this early in a call (else at the next tick)
export const MAX_ERRORS = 3;
export const MAX_ATTEMPTS = 3;
export const CATCH_UP_MS = 24 * 3600 * 1000;
export const RUN_TOO_LONG_MS = 6 * 3600 * 1000;
export const LEASE_MS = 4 * 60 * 1000;
export const PAGE = 1000;
export const BUCKET = "backups";
export const MAILBOX = "info@theguyservicegroup.com";
export const HEADER_LEN = 40;
export const MAGIC = "TGBKUP";
// A missing one of these fails the run loudly instead of making a silent partial backup.
export const REQUIRED_TABLES = ["contacts", "jobs", "closings", "tasks", "manual_reminders", "employees", "suppliers", "contractor_private", "equipment_spend", "equipment_catalog", "payroll_weeks", "payroll_bonuses", "sales_daily_log", "owner_settings", "commission_rates", "cash_status", "settings", "activity_log", "tag_catalog", "dismissed_reminders", "reminder_reads", "ad_spend", "ad_calls", "lead_messages", "chat_sessions", "sms_opt_outs", "shift_events", "myday_days", "review_requests", "ads_stats", "organic_stats", "ghl_archive", "profiles"];
// Left out on purpose (every other table in public, including ones added later, is in the backup):
export const EXCLUDED_TABLES = [
  "app_keys",            // the push notifications' VAPID PRIVATE key
  "push_subscriptions",  // each device's push endpoint and its secret keys (devices sign up again after a restore)
  "backup_state",        // this function's own salt and password check
  "backup_files",        // which file is in which pack (internal)
  "backup_runs",         // the backups themselves, with their download links
  "step_up",             // Security unlocks (30 minutes)
  "passkey_challenges",  // one-time Face ID / fingerprint challenges
  "step_up_fails",       // wrong-password counter
  "passkeys",            // Face ID / fingerprint keys (each device is set up again after a restore)
];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
// deno-lint-ignore no-explicit-any
function must(r: any) { if (r && r.error) throw new Error(r.error.message || "database error"); return r; }

// ── the outside world, swappable in tests ──
export const io = {
  // PostgREST, raw: the page text is passed through without parsing (cheap on CPU and memory).
  rest: async (table: string, query: string, prefer?: string) => {
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const headers: Record<string, string> = { apikey: key, Authorization: "Bearer " + key, Accept: "application/json" };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/${encodeURIComponent(table)}?${query}`, { headers });
    return { status: r.status, text: await r.text(), contentRange: r.headers.get("content-range") || "" };
  },
  // deno-lint-ignore no-explicit-any
  listTables: async (sb: any): Promise<{ table_name: string; order_cols: string[] }[]> => must(await sb.rpc("backup_tables")).data || [],
  // deno-lint-ignore no-explicit-any
  listObjects: async (sb: any, from: number, to: number) => must(await sb.rpc("backup_objects").range(from, to)).data || [],
  // deno-lint-ignore no-explicit-any
  download: async (sb: any, bucket: string, path: string): Promise<Uint8Array> => {
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error || !data) throw new Error("download failed");
    return new Uint8Array(await data.arrayBuffer());
  },
  // The parts are uploaded as one Blob, so the header and the ciphertext are never copied into a third buffer.
  // deno-lint-ignore no-explicit-any
  upload: async (sb: any, path: string, parts: Uint8Array[]) => { must(await sb.storage.from(BUCKET).upload(path, new Blob(parts, { type: "application/octet-stream" }), { contentType: "application/octet-stream", upsert: false })); },
  // deno-lint-ignore no-explicit-any
  remove: async (sb: any, paths: string[]) => { if (paths.length) must(await sb.storage.from(BUCKET).remove(paths)); },
  // deno-lint-ignore no-explicit-any
  list: async (sb: any, prefix: string): Promise<{ name: string; size: number }[]> => {
    const out: { name: string; size: number }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = must(await sb.storage.from(BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } }));
      // deno-lint-ignore no-explicit-any
      (data || []).forEach((o: any) => { if (o && o.name && o.id) out.push({ name: o.name, size: Number(o.metadata && o.metadata.size) || 0 }); });
      if (!data || data.length < 1000) break;
    }
    return out;
  },
  // deno-lint-ignore no-explicit-any
  signedUrl: async (sb: any, path: string, seconds: number, downloadName: string): Promise<string> => {
    const { data } = must(await sb.storage.from(BUCKET).createSignedUrl(path, seconds, { download: downloadName }));
    if (!data || !data.signedUrl) throw new Error("no download link");
    return data.signedUrl;
  },
  // Links for the uploaded files themselves (the on-demand download), many per call.
  // deno-lint-ignore no-explicit-any
  signedUrls: async (sb: any, bucket: string, paths: string[], seconds: number): Promise<string[]> => {
    const { data } = must(await sb.storage.from(bucket).createSignedUrls(paths, seconds));
    // deno-lint-ignore no-explicit-any
    const by: Record<string, string> = {}; (data || []).forEach((d: any) => { if (d && d.path && d.signedUrl) by[d.path] = d.signedUrl; });
    return paths.map((p) => by[p] || "");
  },
  waitUntil: (p: Promise<unknown>) => {
    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") er.waitUntil(p);
    else p.catch(() => {});
  },
  now: () => Date.now(),
  kdfIterations: () => ITERATIONS,   // tests use fewer, for speed (the format carries the number)
  randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
};

// ── bytes ──
const enc = new TextEncoder();
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function toHex(b: ArrayBuffer | Uint8Array): string { return Array.from(new Uint8Array(b as ArrayBuffer), (x) => x.toString(16).padStart(2, "0")).join(""); }
export function b64(bytes: Uint8Array): string { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
export function unb64(s: string): Uint8Array { const bin = atob(String(s || "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
// The timer's secret, compared without an early exit. Both must be set.
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// ── the lock (see LOCKED FILE FORMAT above) ──
export type Key = { key: CryptoKey; verifier: string; salt: Uint8Array; iterations: number };
export async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Key> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const verifier = toHex(await crypto.subtle.digest("SHA-256", concatBytes([enc.encode("tgbk-verify:"), bits])));
  bits.fill(0);
  return { key, verifier, salt, iterations };
}
export function makeHeader(kind: number, iterations: number, salt: Uint8Array, iv: Uint8Array): Uint8Array {
  if (salt.length !== 16 || iv.length !== 12) throw new Error("bad salt or iv");
  const h = new Uint8Array(HEADER_LEN);
  h.set(enc.encode(MAGIC), 0);
  h[6] = 1; h[7] = kind;
  new DataView(h.buffer).setUint32(8, iterations >>> 0, false);
  h.set(salt, 12); h.set(iv, 28);
  return h;
}
export function parseHeader(u8: Uint8Array) {
  if (!u8 || u8.length < HEADER_LEN + 16) return null;
  for (let i = 0; i < 6; i++) if (u8[i] !== MAGIC.charCodeAt(i)) return null;
  if (u8[6] !== 1 || (u8[7] !== 1 && u8[7] !== 2)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { version: 1, kind: u8[7], iterations: dv.getUint32(8, false), salt: u8.slice(12, 28), iv: u8.slice(28, 40), header: u8.slice(0, HEADER_LEN) };
}
// The locked object as its two parts (header, ciphertext + tag): stored one after the other, never joined in memory.
export async function sealParts(k: Key, kind: number, plain: Uint8Array): Promise<{ header: Uint8Array; ct: Uint8Array; length: number }> {
  const iv = io.randomBytes(12);
  const header = makeHeader(kind, k.iterations, k.salt, iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header, tagLength: 128 }, k.key, plain));
  return { header, ct, length: HEADER_LEN + ct.length };
}
export async function sealObject(k: Key, kind: number, plain: Uint8Array): Promise<Uint8Array> {
  const p = await sealParts(k, kind, plain);
  return concatBytes([p.header, p.ct]);
}
// Used by the tests (the app has its own reader). Throws on a wrong password or any changed byte.
export async function openObject(password: string, u8: Uint8Array): Promise<{ kind: number; plain: Uint8Array }> {
  const h = parseHeader(u8);
  if (!h) throw new Error("not a locked backup");
  const k = await deriveKey(password, h.salt, h.iterations);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: h.iv, additionalData: h.header, tagLength: 128 }, k.key, u8.subarray(HEADER_LEN)));
  return { kind: h.kind, plain };
}

// ── packs ──
export type Obj = { bucket: string; path: string; size: number; type: string };
// Groups files (name order) greedily into packs of at most PACK_MAX; one bigger than that (up to OBJECT_MAX) gets a pack of
// its own; a bigger one is listed as missing. solo = "bucket/path" keys that get a pack of their own (the files of a pack
// that was cut off, packed one by one).
export function planPacks(todo: Obj[], solo?: Set<string>) {
  const sorted = todo.slice().sort((a, z) => (a.bucket + "/" + a.path < z.bucket + "/" + z.path ? -1 : a.bucket + "/" + a.path > z.bucket + "/" + z.path ? 1 : 0));
  const packs: Obj[][] = [], missing: (Obj & { reason: string })[] = [];
  let cur: Obj[] = [], curSize = 0;
  for (const f of sorted) {
    const n = Number(f.size) || 0;
    if (n > OBJECT_MAX) { missing.push({ ...f, reason: "too big" }); continue; }
    if (n > PACK_MAX || (solo && solo.has(f.bucket + "/" + f.path))) { packs.push([f]); continue; }
    if (cur.length && curSize + n > PACK_MAX) { packs.push(cur); cur = []; curSize = 0; }
    cur.push(f); curSize += n;
  }
  if (cur.length) packs.push(cur);
  packs.sort((a, z) => (a[0].bucket + "/" + a[0].path < z[0].bucket + "/" + z[0].path ? -1 : 1));
  return { packs, missing };
}
export function buildPack(id: string, files: (Obj & { bytes: Uint8Array })[]): { bytes: Uint8Array; index: (Obj & { offset: number })[] } {
  let offset = 0;
  const index = files.map((f) => { const e = { bucket: f.bucket, path: f.path, type: f.type || "", size: f.bytes.length, offset }; offset += f.bytes.length; return e; });
  const head = enc.encode(JSON.stringify({ v: 1, id, files: index }));
  const out = new Uint8Array(4 + head.length + offset);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  let o = 4 + head.length;
  for (const f of files) { out.set(f.bytes, o); o += f.bytes.length; }
  return { bytes: out, index };
}
// deno-lint-ignore no-explicit-any
export function readPack(u8: Uint8Array): { id: string; files: any[]; start: number } | null {
  if (!u8 || u8.length < 4) return null;
  const L = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, false);
  if (4 + L > u8.length) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + L)));
    if (!h || h.v !== 1 || !Array.isArray(h.files)) return null;
    const start = 4 + L;
    // deno-lint-ignore no-explicit-any
    if (h.files.some((f: any) => !(Number(f.offset) >= 0) || !(Number(f.size) >= 0) || start + Number(f.offset) + Number(f.size) > u8.length)) return null;
    return { id: String(h.id || ""), files: h.files, start };
  } catch (_) { return null; }
}
export function packPath(id: string) { return `packs/${id}.locked`; }
export function newPackId(nowMs: number): string { return ymd(nowMs).replace(/-/g, "") + "-" + toHex(io.randomBytes(4)); }

// ── Sydney time (daylight saving: the sydToUtc method of review-requests) ──
const SYD = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export function sydParts(ms: number) {
  const p = Object.fromEntries(SYD.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function sydToUtc(day: string, hour: number, minute: number): number {
  const [y, m, d] = day.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = sydParts(t);
    const [py, pm, pd] = p.day.split("-").map(Number);
    t -= Date.UTC(py, pm - 1, pd, p.hour, p.minute) - Date.UTC(y, m - 1, d, hour, minute);
  }
  return t;
}
const dowOf = (day: string) => new Date(day + "T12:00:00Z").getUTCDay();
const ymd = (ms: number) => sydParts(ms).day;
// deno-lint-ignore no-explicit-any
function cfgSlot(cfg: any) {
  const day = Number(cfg && cfg.send_day), time = String((cfg && cfg.send_time) || "");
  if (!Number.isInteger(day) || day < 0 || day > 6 || !TIME_RE.test(time)) return null;
  return { day, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) };
}
// The latest Sydney day+time at or before now (null when the settings are unreadable).
// deno-lint-ignore no-explicit-any
export function lastSlot(cfg: any, nowMs: number): number | null {
  const s = cfgSlot(cfg); if (!s) return null;
  const today = sydParts(nowMs).day;
  for (let k = 0; k <= 8; k++) {
    const day = shiftDay(today, -k);
    if (dowOf(day) !== s.day) continue;
    const t = sydToUtc(day, s.hour, s.minute);
    if (t <= nowMs) return t;
  }
  return null;
}
// deno-lint-ignore no-explicit-any
export function nextSlot(cfg: any, nowMs: number): number | null {
  const s = cfgSlot(cfg); if (!s) return null;
  const today = sydParts(nowMs).day;
  for (let k = 0; k <= 8; k++) {
    const day = shiftDay(today, k);
    if (dowOf(day) !== s.day) continue;
    const t = sydToUtc(day, s.hour, s.minute);
    if (t > nowMs) return t;
  }
  return null;
}
function clock(hour: number, minute: number) { return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`; }
export function timeText(hhmm: string) { return TIME_RE.test(hhmm) ? clock(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))) : hhmm; }
// "Sunday 19 Oct 2026, 3:07 am"
export function sydWhen(ms: number): string { const p = sydParts(ms), [y, m, d] = p.day.split("-").map(Number); return `${DAYS[dowOf(p.day)]} ${d} ${MONTHS[m - 1]} ${y}, ${clock(p.hour, p.minute)}`; }
// "Sun 19 Oct 2026"
export function sydDateShort(ms: number): string { const p = sydParts(ms), [y, m, d] = p.day.split("-").map(Number); return `${DAYS[dowOf(p.day)].slice(0, 3)} ${d} ${MONTHS[m - 1]} ${y}`; }
// "Sunday 26 Oct"
export function sydDateLong(ms: number): string { const p = sydParts(ms), [, m, d] = p.day.split("-").map(Number); return `${DAYS[dowOf(p.day)]} ${d} ${MONTHS[m - 1]}`; }
export function sizeText(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── table streaming ──
// The rows of one PostgREST page, without the outer brackets (the text is never parsed).
export function pageInner(text: string): string {
  const t = String(text ?? "").trim();
  if (!t.startsWith("[") || !t.endsWith("]")) throw new Error("not a list of rows");
  return t.slice(1, -1).trim();
}
export function orderParam(cols: string[]): string {
  return (cols || []).map((c) => `"${String(c).replace(/["\\]/g, "\\$&")}".asc`).join(",");
}
// How many rows a page holds, from Content-Range ("0-999/2350", "*/0"); parsed only when the header is missing.
export function rowsInPage(contentRange: string, inner: string): number {
  const m = /^(\d+)-(\d+)\//.exec(String(contentRange || ""));
  if (m) return Number(m[2]) - Number(m[1]) + 1;
  if (/^\*\//.test(String(contentRange || ""))) return 0;
  return inner ? JSON.parse("[" + inner + "]").length : 0;
}
export function totalOf(contentRange: string): number | null { const m = /\/(\d+)$/.exec(String(contentRange || "")); return m ? Number(m[1]) : null; }

type Warn = Record<string, unknown>;
async function readTable(t: { table_name: string; order_cols: string[] }, warnings: Warn[]): Promise<{ parts: string[]; count: number }> {
  const order = t.order_cols && t.order_cols.length ? "&order=" + encodeURIComponent(orderParam(t.order_cols)) : "";
  let last = { parts: [] as string[], count: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts: string[] = [];
    let got = 0, expected: number | null = null;
    for (let offset = 0; ; ) {
      const r = await io.rest(t.table_name, `select=*${order}&offset=${offset}&limit=${PAGE}`, offset === 0 ? "count=exact" : "");
      if (r.status < 200 || r.status >= 300) throw new Error(`could not read ${t.table_name} (${r.status})`);
      if (offset === 0) expected = totalOf(r.contentRange);
      const inner = pageInner(r.text), n = rowsInPage(r.contentRange, inner);
      if (inner) parts.push(inner);
      got += n; offset += n;
      if (n < PAGE) break;
    }
    last = { parts, count: got };
    if (expected === null || got === expected) return last;
    if (attempt === 1) warnings.push({ table: t.table_name, expected, got });
  }
  return last;
}
// The tables to back up: every table in public minus EXCLUDED_TABLES, by name; a missing REQUIRED one fails the run.
// deno-lint-ignore no-explicit-any
export async function backupTables(sb: any) {
  const all = await io.listTables(sb);
  const names = new Set(all.map((t) => t.table_name));
  const missing = REQUIRED_TABLES.find((n) => !names.has(n));
  if (missing) throw new Error("missing table " + missing);
  return all.filter((t) => !EXCLUDED_TABLES.includes(t.table_name)).sort((a, z) => (a.table_name < z.table_name ? -1 : 1));
}

// A writer that turns text into bytes for a sink (the gzip stream, or the HTTP response), counting what it wrote.
export function makeJsonWriter(sink: (b: Uint8Array) => Promise<void> | void) {
  let n = 0;
  return {
    async write(s: string) { if (!s) return; const b = enc.encode(s); n += b.length; await sink(b); },
    bytes: () => n,
  };
}
// The data JSON, keys in this order: format, version, kind, created_at, created_sydney, files, files_missing, tables, counts, warnings.
// deno-lint-ignore no-explicit-any
export async function writeData(w: ReturnType<typeof makeJsonWriter>, head: { kind: string; nowMs: number; files: any[]; files_missing: any[] }, tables: { table_name: string; order_cols: string[] }[], warnings: Warn[]) {
  const J = JSON.stringify, counts: Record<string, number> = {};
  await w.write(`{"format":"the-guys-backup","version":1,"kind":${J(head.kind)},"created_at":${J(new Date(head.nowMs).toISOString())},"created_sydney":${J(sydWhen(head.nowMs))},"files":${J(head.files)},"files_missing":${J(head.files_missing)},"tables":{`);
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i], r = await readTable(t, warnings);
    await w.write((i ? "," : "") + J(t.table_name) + ":[");
    for (let j = 0; j < r.parts.length; j++) await w.write((j ? "," : "") + r.parts[j]);
    await w.write("]");
    counts[t.table_name] = r.count;
  }
  await w.write(`},"counts":${J(counts)},"warnings":${J(warnings)}}`);
  return counts;
}
// Runs produce(sink) into gzip and returns the compressed bytes.
async function gzipOf(produce: (sink: (b: Uint8Array) => Promise<void>) => Promise<void>): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const reading = (async () => { const r = cs.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); } })();
  try {
    await produce(async (b) => { await writer.write(b); });
    await writer.close();
  } catch (e) {
    try { await writer.abort(e); } catch (_) { /* already failed */ }
    await reading.catch(() => {});
    throw e;
  }
  await reading;
  return concatBytes(chunks);
}

// ── every uploaded file ──
// deno-lint-ignore no-explicit-any
async function allObjects(sb: any): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await io.listObjects(sb, from, from + 999);
    // deno-lint-ignore no-explicit-any
    page.forEach((o: any) => { if (o && o.bucket_id && o.name && o.bucket_id !== BUCKET) out.push({ bucket: String(o.bucket_id), path: String(o.name), size: Number(o.size) || 0, type: String(o.mimetype || "") }); });
    if (page.length < 1000) break;
  }
  return out;
}
// deno-lint-ignore no-explicit-any
async function allPackedRows(sb: any): Promise<Map<string, any>> {
  // deno-lint-ignore no-explicit-any
  const by = new Map<string, any>();
  for (let from = 0; ; from += 1000) {
    const { data } = must(await sb.from("backup_files").select("bucket, path, size, type, pack, pack_offset, key_id").order("bucket").order("path").range(from, from + 999));
    // deno-lint-ignore no-explicit-any
    (data || []).forEach((r: any) => by.set(r.bucket + "/" + r.path, r));
    if (!data || data.length < 1000) break;
  }
  return by;
}
// A file needs packing when it has no row, a different size, or was packed under another password.
// deno-lint-ignore no-explicit-any
export function needsPack(o: Obj, row: any, keyId: string): boolean { return !row || Number(row.size) !== Number(o.size) || row.key_id !== keyId; }
// Which packs fit under STORAGE_SAFE: used = the project's files now (the uploads plus what the backups bucket holds).
// Returns the packs to make now and the files left out for lack of room (in order: the first packs fit first).
export function fitStorage(packs: Obj[][], used: number, limit = STORAGE_SAFE): { fit: Obj[][]; noRoom: Obj[] } {
  const fit: Obj[][] = [], noRoom: Obj[] = [];
  let total = Number(used) || 0;
  for (const g of packs) {
    const n = g.reduce((s, f) => s + (Number(f.size) || 0), 0);
    if (!noRoom.length && total + n <= limit) { fit.push(g); total += n; } else noRoom.push(...g);
  }
  return { fit, noRoom };
}

// ── the weekly email (pure) ──
// deno-lint-ignore no-explicit-any
export function emailFor(o: { run: any; cfg: any; dataLink: { url: string; bytes: number }; packs: { url: string; bytes: number; isNew: boolean }[]; expiresAt: number; noRoom?: number }) {
  const when = Date.parse(o.run.slot || o.run.started_at) || o.expiresAt - LINK_DAYS * 864e5;
  const fresh = o.packs.filter((p) => p.isNew), old = o.packs.filter((p) => !p.isNew);
  const parts = (list: { bytes: number }[]) => `${list.length} part${list.length === 1 ? "" : "s"}, ${sizeText(list.reduce((s, p) => s + (Number(p.bytes) || 0), 0))}`;
  const lines = [
    "The weekly backup is ready: every area of the app, and the uploaded files.",
    "It is locked with your backup password (the BACKUP_PASSWORD secret in Supabase).",
    "",
    `Download within ${LINK_DAYS} days (the links stop working on ${sydDateLong(o.expiresAt)}):`,
    "",
    `Data, all areas (${sizeText(o.dataLink.bytes)}):`,
    o.dataLink.url,
  ];
  if (fresh.length) lines.push("", `Uploaded files, new this week (${parts(fresh)}):`, ...fresh.map((p) => p.url));
  if (old.length) lines.push("", "Uploaded files sent in earlier weeks (only if you don't have them yet):", ...old.map((p) => p.url));
  if (o.noRoom) lines.push("", `${o.noRoom} uploaded file${o.noRoom === 1 ? " is" : "s are"} NOT in this backup: the project's storage on the free Supabase plan (1 GB) is nearly full. The data file has everything else. Download them with "Download full backup" in Settings → Data, or ask Claude to free some storage.`);
  lines.push("", `To open them: go to ${APP_URL}?open=backup ("Open a locked backup" opens at once; it is also on the sign-in page and in Settings → Data). No sign-in needed, so it works even if the app's database is gone. Choose the downloaded files and type the password. They open in your browser; nothing is uploaded.`,
    "", "Keep the files somewhere safe, outside the app. There is no restore button, on purpose: if a restore is ever needed, it is done together, carefully.");
  return { to: String(o.cfg.email || ""), subject: `Weekly backup of the OPS app, ${sydDateShort(when)} (locked)`, text: lines.join("\n") };
}

// ── the timer ──
// Is this week's slot due? Pure: the caller reads the rows. runs = the weekly runs of THIS slot.
// deno-lint-ignore no-explicit-any
export function slotDue(o: { cfg: any; state: any; runs: any[]; nowMs: number; passwordSet: boolean }): { due: boolean; slot: number | null; attempt: number } {
  const slot = lastSlot(o.cfg, o.nowMs), no = { due: false, slot, attempt: 0 };
  if (slot === null) return no;
  if (o.nowMs - slot > CATCH_UP_MS) return no;
  const upd = Date.parse(o.cfg && o.cfg.updated_at);
  if (upd && slot < upd) return no;
  const seen = Date.parse(o.state && o.state.password_seen_at);
  if (o.passwordSet && seen && slot < seen) return no;
  const runs = o.runs || [];
  if (runs.some((r) => r.status !== "failed")) return no;
  const top = runs.reduce((m, r) => Math.max(m, Number(r.attempt) || 1), 0);
  if (top >= MAX_ATTEMPTS) return no;
  return { due: true, slot, attempt: top + 1 };
}
export function emailOk(v: unknown): boolean { const s = String(v ?? ""); return s.length <= 254 && EMAIL_RE.test(s); }

// deno-lint-ignore no-explicit-any
export async function runTick(sb: any) {
  const nowMs = io.now(), nowIso = new Date(nowMs).toISOString(), passwordSet = !!env("BACKUP_PASSWORD");
  const { data: st } = must(await sb.from("backup_state").select("*").eq("id", 1).maybeSingle());
  const state = st || { id: 1 };
  const patch: Record<string, unknown> = { last_tick_at: nowIso };
  if (passwordSet && !state.password_seen_at) { patch.password_seen_at = nowIso; state.password_seen_at = nowIso; }
  if (st) must(await sb.from("backup_state").update(patch).eq("id", 1));
  else must(await sb.from("backup_state").upsert({ id: 1, ...patch }, { onConflict: "id" }));
  const { data: cfg } = must(await sb.from("backup_settings").select("*").eq("id", 1).maybeSingle());
  if (!cfg) return { ok: true, did: "no settings" };
  const { data: running } = must(await sb.from("backup_runs").select("*").eq("kind", "weekly").eq("status", "running").order("started_at", { ascending: false }).limit(1));
  if (running && running[0]) {
    const r = running[0];
    if (nowMs - Date.parse(r.started_at) > RUN_TOO_LONG_MS) {
      must(await sb.from("backup_runs").update({ status: "failed", error: "took too long", finished_at: nowIso, lease_until: null }).eq("id", r.id));
      return { ok: true, did: "failed (took too long)" };
    }
    if (!passwordSet) return { ok: true, did: "waiting for the password" };
    return { ok: true, did: await continueRun(sb, r) };
  }
  const slot = lastSlot(cfg, nowMs);
  const { data: slotRuns } = slot === null ? { data: [] } : must(await sb.from("backup_runs").select("id, status, attempt").eq("kind", "weekly").eq("slot", new Date(slot).toISOString()));
  const d = slotDue({ cfg, state, runs: slotRuns || [], nowMs, passwordSet });
  if (!d.due || d.slot === null) return { ok: true, did: "not due" };
  const slotIso = new Date(d.slot).toISOString();
  if (!passwordSet) {
    must(await sb.from("backup_runs").insert({ kind: "weekly", slot: slotIso, attempt: d.attempt, status: "waiting_password", started_at: nowIso, finished_at: nowIso }));
    return { ok: true, did: "waiting for the password" };
  }
  if (!emailOk(cfg.email)) {
    must(await sb.from("backup_runs").insert({ kind: "weekly", slot: slotIso, attempt: d.attempt, status: "no_email", started_at: nowIso, finished_at: nowIso }));
    return { ok: true, did: "no email address" };
  }
  const ins = await sb.from("backup_runs").insert({ kind: "weekly", slot: slotIso, attempt: d.attempt, status: "running", started_at: nowIso, email_to: cfg.email }).select("*").single();
  if (ins.error) { if (String(ins.error.code) === "23505") return { ok: true, did: "taken by another tick" }; throw new Error(ins.error.message); }
  return { ok: true, did: await continueRun(sb, ins.data) };
}

// The salt is made once; the key is derived once per call. A changed password stores its new verifier.
// deno-lint-ignore no-explicit-any
async function keyForRun(sb: any): Promise<Key> {
  const { data: st } = must(await sb.from("backup_state").select("*").eq("id", 1).maybeSingle());
  const iterations = io.kdfIterations();
  let salt = st && st.salt ? unb64(st.salt) : null;
  const patch: Record<string, unknown> = {};
  if (!salt || salt.length !== 16) { salt = io.randomBytes(16); patch.salt = b64(salt); }
  const k = await deriveKey(env("BACKUP_PASSWORD"), salt, iterations);
  if (!st || st.iterations !== iterations) patch.iterations = iterations;
  if (!st || st.verifier !== k.verifier) patch.verifier = k.verifier;
  if (Object.keys(patch).length) {
    if (st) must(await sb.from("backup_state").update(patch).eq("id", 1));
    else must(await sb.from("backup_state").upsert({ id: 1, ...patch }, { onConflict: "id" }));
  }
  return k;
}

// One call's share of a weekly run: files (packs) first, then the data, the links, the email and the clean-up.
// deno-lint-ignore no-explicit-any
export async function continueRun(sb: any, run: any): Promise<string> {
  const started = io.now(), startIso = new Date(started).toISOString();
  const { data: claimed } = must(await sb.from("backup_runs").update({ lease_until: new Date(started + LEASE_MS).toISOString() }).eq("id", run.id).eq("status", "running").or(`lease_until.is.null,lease_until.lt.${startIso}`).select("*"));
  if (!claimed || !claimed.length) return "busy";
  run = claimed[0];
  // deno-lint-ignore no-explicit-any
  const progress: any = { new_packs: [], skipped: [], solo: [], no_room: [], notes: [], ...(run.progress && typeof run.progress === "object" ? run.progress : {}) };
  ["new_packs", "skipped", "solo", "no_room", "notes"].forEach((k) => { if (!Array.isArray(progress[k])) progress[k] = []; });
  // save(): the progress so far, keeping (and extending) the lease. release(): the progress, and the lease let go. Neither
  // ever touches a run that is no longer running (a finished, emailed run stays exactly as it is).
  const save = async () => { must(await sb.from("backup_runs").update({ progress, lease_until: new Date(io.now() + LEASE_MS).toISOString() }).eq("id", run.id).eq("status", "running")); };
  const release = async (extra: Record<string, unknown> = {}) => { must(await sb.from("backup_runs").update({ lease_until: null, progress, ...extra }).eq("id", run.id).eq("status", "running")); };
  let cutNote = "";
  // A pack noted as started and never finished: the worker was stopped in the middle of it (memory or the time limit).
  // Its files are packed one by one now; a single file that was cut off is left out, with the reason.
  if (progress.inflight && Array.isArray(progress.inflight.files) && progress.inflight.files.length) {
    const cut: Obj[] = progress.inflight.files;
    if (cut.length === 1) progress.skipped.push({ bucket: cut[0].bucket, path: cut[0].path, size: cut[0].size, reason: "could not be packed (the backup stopped while packing it)" });
    else cut.forEach((f) => progress.solo.push(f.bucket + "/" + f.path));
    cutNote = cut.length === 1 ? "a file stopped the backup while it was packed; it is left out" : "a part stopped before it finished (memory or time limit); its files are packed one by one";
    progress.notes.push({ note: cutNote, files: cut.length });
    progress.inflight = null;
  }
  try {
    const k = await keyForRun(sb);
    const objects = await allObjects(sb);
    const rows = await allPackedRows(sb);
    const keyOf = (o: { bucket: string; path: string }) => o.bucket + "/" + o.path;
    const skipped = new Set<string>(progress.skipped.map(keyOf));
    const noRoomBefore = new Set<string>(progress.no_room.map(keyOf));
    const todo = objects.filter((o) => !skipped.has(keyOf(o)) && !noRoomBefore.has(keyOf(o)) && needsPack(o, rows.get(keyOf(o)), k.verifier));
    const plan = planPacks(todo, new Set<string>(progress.solo));
    // STORAGE: the uploads plus the backups bucket now, then only the packs that keep the project under STORAGE_SAFE.
    const listedBefore = plan.packs.length ? await io.list(sb, "packs") : [];
    let room = { fit: plan.packs, noRoom: [] as Obj[] };
    if (plan.packs.length) {
      const { data: dataFiles } = must(await sb.from("backup_runs").select("data_path, data_bytes").eq("kind", "weekly"));
      // deno-lint-ignore no-explicit-any
      const used = objects.reduce((s, o) => s + (Number(o.size) || 0), 0) + listedBefore.reduce((s, x) => s + (Number(x.size) || 0), 0) + (dataFiles || []).reduce((s: number, r: any) => s + (r.data_path ? Number(r.data_bytes) || 0 : 0), 0);
      room = fitStorage(plan.packs, used);
      if (room.noRoom.length) room.noRoom.forEach((f) => progress.no_room.push({ bucket: f.bucket, path: f.path, size: f.size }));
    }
    // FILES
    for (const group of room.fit) {
      if (io.now() - started >= TICK_BUDGET_MS) { await release(cutNote ? { error: cutNote } : {}); return "paused (files)"; }
      // Noted BEFORE the downloads: if the worker is stopped in the middle, the next tick knows which pack it was.
      progress.inflight = { files: group.map((f) => ({ bucket: f.bucket, path: f.path, size: f.size })), at: new Date(io.now()).toISOString() };
      await save();
      let got: (Obj & { bytes: Uint8Array })[] = [];
      for (const f of group) {
        try {
          const bytes = await io.download(sb, f.bucket, f.path);
          if (bytes.length > OBJECT_MAX) throw new Error("too big");
          got.push({ ...f, bytes });
        } catch (_) {
          progress.skipped.push({ bucket: f.bucket, path: f.path, size: f.size, reason: "could not be read" });
        }
      }
      if (!got.length) { progress.inflight = null; await save(); continue; }
      const id = newPackId(io.now());
      let built: { bytes: Uint8Array; index: (Obj & { offset: number })[] } | null = buildPack(id, got);
      got = [];   // the downloaded copies can go now
      const index = built.index;
      const sealed = await sealParts(k, 2, built.bytes);
      built = null;   // the plain pack too
      const packedAt = new Date(io.now()).toISOString();
      await io.upload(sb, packPath(id), [sealed.header, sealed.ct]);
      const packed = index.map((e) => ({ bucket: e.bucket, path: e.path, size: e.size, type: e.type || null, pack: id, pack_offset: e.offset, key_id: k.verifier, packed_at: packedAt }));
      for (let i = 0; i < packed.length; i += 500) must(await sb.from("backup_files").upsert(packed.slice(i, i + 500), { onConflict: "bucket,path" }));
      packed.forEach((r) => rows.set(r.bucket + "/" + r.path, r));
      progress.new_packs.push({ id, bytes: sealed.length });
      progress.inflight = null;
      await save();
    }
    if (io.now() - started >= DATA_START_MS && room.fit.length) { await release(cutNote ? { error: cutNote } : {}); return "paused (data next)"; }
    // DATA
    const nowMs = io.now();
    const warnings: Warn[] = [...progress.skipped.map((s: Record<string, unknown>) => ({ ...s })), ...progress.notes.map((s: Record<string, unknown>) => ({ ...s }))];
    const noRoom = new Set<string>(progress.no_room.map(keyOf));
    const files: Record<string, unknown>[] = [], missing: Record<string, unknown>[] = [];
    const packsUsed = new Set<string>();
    let filesBytes = 0, noRoomCount = 0;
    const tooBig = new Set(plan.missing.map((m) => m.bucket + "/" + m.path));
    // deno-lint-ignore no-explicit-any
    const skippedWhy = new Map<string, string>(progress.skipped.map((x: any) => [keyOf(x), String(x.reason || "could not be read")]));
    for (const o of objects) {
      const key = keyOf(o), r = rows.get(key);
      if (r && !needsPack(o, r, k.verifier)) {
        files.push({ bucket: o.bucket, path: o.path, size: Number(r.size), type: r.type || o.type || "", pack: r.pack, offset: Number(r.pack_offset) });
        packsUsed.add(r.pack); filesBytes += Number(r.size) || 0;
      } else {
        const reason = tooBig.has(key) ? "too big" : noRoom.has(key) ? "not enough storage on the free plan" : skippedWhy.get(key) || "could not be read";
        if (reason === "not enough storage on the free plan") noRoomCount++;
        missing.push({ bucket: o.bucket, path: o.path, size: o.size, reason });
      }
    }
    if (noRoomCount) warnings.push({ storage_full: true, files: noRoomCount, limit_mb: Math.round(STORAGE_SAFE / 1024 / 1024) });
    const tables = await backupTables(sb);
    let counts: Record<string, number> = {};
    const gz = await gzipOf(async (sink) => { counts = await writeData(makeJsonWriter(sink), { kind: "weekly", nowMs, files, files_missing: missing }, tables, warnings); });
    const sealed = await sealParts(k, 1, gz);
    if (sealed.length > DATA_MAX) throw new Error("the data file is too big to store (" + sizeText(sealed.length) + ")");
    // A new name on each try (an upload never overwrites); the copy of an earlier, unfinished try of this run goes.
    const day = ymd(nowMs), dataPath = `runs/${day}-${String(run.id).replace(/-/g, "").slice(0, 8)}/data-${toHex(io.randomBytes(3))}.locked`;
    await io.upload(sb, dataPath, [sealed.header, sealed.ct]);
    if (run.data_path && run.data_path !== dataPath) await io.remove(sb, [run.data_path]).catch(() => {});
    const packs = [...packsUsed].sort();
    must(await sb.from("backup_runs").update({ data_path: dataPath, data_bytes: sealed.length, counts, warnings, files_total: files.length, files_bytes: filesBytes, packs, progress }).eq("id", run.id));
    // LINKS + EMAIL
    const listed = await io.list(sb, "packs");
    const packBytes = new Map(listed.map((x) => [x.name.replace(/\.locked$/, ""), x.size]));
    // deno-lint-ignore no-explicit-any
    progress.new_packs.forEach((p: any) => { if (!packBytes.get(p.id)) packBytes.set(p.id, p.bytes); });
    const secs = LINK_DAYS * 86400, expiresAt = nowMs + secs * 1000;
    const dataUrl = await io.signedUrl(sb, dataPath, secs, `the-guys-backup-${day}-data.locked`);
    // deno-lint-ignore no-explicit-any
    const fresh = new Set(progress.new_packs.map((p: any) => p.id));
    const order = [...packs.filter((p) => fresh.has(p)), ...packs.filter((p) => !fresh.has(p))];
    const linkList: { url: string; bytes: number; isNew: boolean }[] = [];
    for (const p of order) linkList.push({ url: await io.signedUrl(sb, packPath(p), secs, `the-guys-backup-files-${p}.locked`), bytes: Number(packBytes.get(p)) || 0, isNew: fresh.has(p) });
    const { data: cfg } = must(await sb.from("backup_settings").select("*").eq("id", 1).maybeSingle());
    const to = cfg && emailOk(cfg.email) ? cfg.email : run.email_to;
    const mail = emailFor({ run, cfg: { ...(cfg || {}), email: to }, dataLink: { url: dataUrl, bytes: sealed.length }, packs: linkList, expiresAt, noRoom: noRoomCount });
    const doneIso = new Date(io.now()).toISOString();
    must(await sb.from("backup_runs").update({ status: "done", finished_at: doneIso, lease_until: null, error: null, email_to: mail.to, email_status: "queued", email_subject: mail.subject, email_body: mail.text, email_queued_at: doneIso, links_expire_at: new Date(expiresAt).toISOString() }).eq("id", run.id).eq("status", "running"));
    // RETENTION (only after this run is done). Its own try: a failed clean-up never changes the finished run (it is
    // tried again after the next weekly backup).
    try { await retention(sb, run.id, packs, listed.map((x) => x.name.replace(/\.locked$/, ""))); }
    catch (e) { console.error("backup retention failed:", String((e as Error).message || e).slice(0, 300)); }
    return "done";
  } catch (e) {
    // This catch ran, so the worker was not stopped: a pack in progress is tried again normally (not split or left out).
    progress.inflight = null;
    const errors = (Number(run.errors) || 0) + 1, msg = String((e as Error).message || e).slice(0, 300);
    const extra: Record<string, unknown> = { errors, error: msg };
    if (errors >= MAX_ERRORS) { extra.status = "failed"; extra.finished_at = new Date(io.now()).toISOString(); }
    await release(extra).catch(() => {});
    return "error";
  }
}

// Keeps the data files of the newest KEEP_RUNS done weekly backups, and the packs any of them (or this one) needs. The data
// file of any other weekly run (older ones, and a failed one that got as far as storing it) is removed.
// deno-lint-ignore no-explicit-any
async function retention(sb: any, runId: string, currentPacks: string[], storedPacks: string[]) {
  const { data: all } = must(await sb.from("backup_runs").select("id, status, data_path, packs, finished_at").eq("kind", "weekly").order("finished_at", { ascending: false }));
  // deno-lint-ignore no-explicit-any
  const done = (all || []).filter((r: any) => r.status === "done" && r.finished_at);
  const kept = done.slice(0, KEEP_RUNS), keptIds = new Set(kept.map((r: { id: string }) => r.id));
  if (!keptIds.has(runId)) return;   // never clean up from a run that isn't among the newest
  // deno-lint-ignore no-explicit-any
  const oldData = (all || []).filter((r: any) => r.data_path && r.status !== "running" && !keptIds.has(r.id));
  if (oldData.length) {
    // deno-lint-ignore no-explicit-any
    await io.remove(sb, oldData.map((r: any) => r.data_path));
    // deno-lint-ignore no-explicit-any
    for (const r of oldData) must(await sb.from("backup_runs").update({ data_path: null }).eq("id", (r as any).id));
  }
  const keep = new Set<string>(currentPacks);
  // deno-lint-ignore no-explicit-any
  kept.forEach((r: any) => (r.packs || []).forEach((p: string) => keep.add(p)));
  const drop = storedPacks.filter((p) => !keep.has(p));
  if (!drop.length) return;
  await io.remove(sb, drop.map(packPath));
  for (let i = 0; i < drop.length; i += 100) must(await sb.from("backup_files").delete().in("pack", drop.slice(i, i + 100)));
}

// ── the owner's steps ──
// deno-lint-ignore no-explicit-any
export async function hasStepUp(sb: any, me: any, nowMs: number): Promise<boolean> {
  if (!me || !me.id || !UUID_RE.test(String(me.sessionId || ""))) return false;
  const { data, error } = await sb.from("step_up").select("until").eq("user_id", me.id).eq("session_id", me.sessionId).maybeSingle();
  return !error && !!data && Date.parse(data.until) > nowMs;
}
// deno-lint-ignore no-explicit-any
function cfgOut(cfg: any) { return { email: cfg.email || "", day: Number(cfg.send_day), time: cfg.send_time || "", updated_at: cfg.updated_at || null }; }

// How many uploaded files a run left out for lack of storage (0 = none), from its warnings.
// deno-lint-ignore no-explicit-any
export function storageFullOf(warnings: any): number {
  // deno-lint-ignore no-explicit-any
  const w = Array.isArray(warnings) ? warnings.find((x: any) => x && x.storage_full) : null;
  return w ? Math.max(1, Number(w.files) || 0) : 0;
}
// deno-lint-ignore no-explicit-any
export async function status(sb: any, nowMs: number) {
  const s = await sb.from("backup_settings").select("*").eq("id", 1).maybeSingle();
  if (s.error || !s.data) return { ok: false, reason: "not_set_up" };
  const { data: st } = await sb.from("backup_state").select("last_tick_at").eq("id", 1).maybeSingle();
  const { data: last } = must(await sb.from("backup_runs").select("status, slot, started_at, finished_at, email_to, email_status, email_queued_at, email_sent_at, links_expire_at, data_bytes, files_total, files_bytes, error, warnings").eq("kind", "weekly").order("started_at", { ascending: false }).limit(1));
  const r = last && last[0];
  const tick = Date.parse(st && st.last_tick_at);
  const next = nextSlot(s.data, nowMs);
  return {
    ok: true, passwordSet: !!env("BACKUP_PASSWORD"), timerOk: !!tick && nowMs - tick < 3600 * 1000,
    config: cfgOut(s.data), nextAt: next === null ? null : new Date(next).toISOString(),
    last: r ? { status: r.status, slot: r.slot, started_at: r.started_at, finished_at: r.finished_at, email_to: r.email_to, email_status: r.email_status, email_queued_at: r.email_queued_at, email_sent_at: r.email_sent_at, links_expire_at: r.links_expire_at, data_bytes: r.data_bytes, files_total: r.files_total, files_bytes: r.files_bytes, error: r.error, warnings_count: Array.isArray(r.warnings) ? r.warnings.length : 0, storage_full: storageFullOf(r.warnings) } : null,
  };
}

// deno-lint-ignore no-explicit-any
export async function config(sb: any, body: any, me: any, nowMs: number) {
  const { data: cur } = must(await sb.from("backup_settings").select("*").eq("id", 1).maybeSingle());
  if (!cur) return { status: 400, body: { ok: false, reason: "not_set_up" } };
  const next = { email: cur.email, send_day: Number(cur.send_day), send_time: cur.send_time };
  if (body.email !== undefined) {
    const e = String(body.email ?? "").trim().toLowerCase();
    if (!emailOk(e)) return { status: 400, body: { ok: false, reason: "email" } };
    next.email = e;
  }
  if (body.day !== undefined) {
    const d = Number(body.day);
    if (!Number.isInteger(d) || d < 0 || d > 6 || body.day === null || body.day === "") return { status: 400, body: { ok: false, reason: "day" } };
    next.send_day = d;
  }
  if (body.time !== undefined) {
    const t = String(body.time ?? "");
    if (!TIME_RE.test(t)) return { status: 400, body: { ok: false, reason: "time" } };
    next.send_time = t;
  }
  const emailChanged = next.email !== cur.email, whenChanged = next.send_day !== Number(cur.send_day) || next.send_time !== cur.send_time;
  // The address decides where all the data goes each week: a new one needs the Security step-up.
  if (emailChanged && !(await hasStepUp(sb, me, nowMs))) return { status: 403, body: { ok: false, reason: "step_up" } };
  if (!emailChanged && !whenChanged) { const n = nextSlot(cur, nowMs); return { status: 200, body: { ok: true, config: cfgOut(cur), nextAt: n === null ? null : new Date(n).toISOString(), text: "" } }; }
  const row = { id: 1, ...next, updated_at: new Date(nowMs).toISOString(), updated_by: me.full_name || "Owner" };
  must(await sb.from("backup_settings").upsert(row, { onConflict: "id" }));
  const lines: string[] = [];
  if (emailChanged) lines.push(`Data: the weekly backup goes to ${next.email} (was ${cur.email})`);
  if (whenChanged) lines.push(`Data: the weekly backup is sent on ${DAYS[next.send_day]} at ${timeText(next.send_time)}`);
  const text = lines.join(" · ");
  must(await sb.from("activity_log").insert({ record_kind: "settings", record_id: "global", actor: me.full_name || "Owner", text, manual: true }));
  const n = nextSlot(row, nowMs);
  return { status: 200, body: { ok: true, config: cfgOut(row), nextAt: n === null ? null : new Date(n).toISOString(), text } };
}

// "Download full backup": the plain data JSON, streamed back, each uploaded file with a 1-hour link.
// deno-lint-ignore no-explicit-any
export async function download(sb: any, me: any): Promise<Response> {
  const nowMs = io.now();
  const { data: run } = must(await sb.from("backup_runs").insert({ kind: "download", status: "running", by_name: me.full_name || "Owner", started_at: new Date(nowMs).toISOString() }).select("id").single());
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const work = (async () => {
    try {
      const objects = await allObjects(sb);
      const files: Record<string, unknown>[] = [], missing: Record<string, unknown>[] = [];
      const byBucket = new Map<string, Obj[]>();
      objects.forEach((o) => { if (!byBucket.has(o.bucket)) byBucket.set(o.bucket, []); byBucket.get(o.bucket)!.push(o); });
      for (const [bucket, list] of byBucket) {
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100), urls = await io.signedUrls(sb, bucket, chunk.map((o) => o.path), 3600);
          // A file without a link (deleted meanwhile, or it couldn't be signed) is listed as missing, never sent with ''.
          chunk.forEach((o, j) => { if (urls[j]) files.push({ bucket: o.bucket, path: o.path, size: o.size, type: o.type, url: urls[j] }); else missing.push({ bucket: o.bucket, path: o.path, size: o.size, reason: "could not be signed" }); });
        }
      }
      const tables = await backupTables(sb);
      const warnings: Warn[] = [];
      const w = makeJsonWriter(async (b) => { await writer.write(b); });
      const counts = await writeData(w, { kind: "download", nowMs, files, files_missing: missing }, tables, warnings);
      await writer.close();
      must(await sb.from("backup_runs").update({ status: "done", finished_at: new Date(io.now()).toISOString(), counts, warnings, files_total: files.length, data_bytes: w.bytes() }).eq("id", run.id));
      must(await sb.from("activity_log").insert({ record_kind: "settings", record_id: "global", actor: me.full_name || "Owner", text: "Data: full backup downloaded", manual: true }));
    } catch (e) {
      try { await writer.abort(e); } catch (_) { /* the reader went away */ }
      await sb.from("backup_runs").update({ status: "failed", finished_at: new Date(io.now()).toISOString(), error: String((e as Error).message || e).slice(0, 300) }).eq("id", run.id);
    }
  })();
  io.waitUntil(work);
  return new Response(readable, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// me = { id, full_name, role, sessionId } of the signed-in caller (checked by Supabase Auth) or null.
// headers = the request's headers (only x-backup-secret is read).
// deno-lint-ignore no-explicit-any
export async function handle(sb: any, body: any, me: any, headers: { get(k: string): string | null }, nowMs: number): Promise<Response> {
  const step = String((body && body.step) || "");
  if (step === "tick") {
    if (!sameSecret(String(headers.get("x-backup-secret") || ""), env("BACKUP_CRON_SECRET"))) return json({ ok: false, error: "unauthorized" }, 401);
    io.waitUntil(runTick(sb).catch((e) => { console.error("backup tick failed:", String((e as Error).message || e).slice(0, 300)); }));
    return json({ ok: true }, 202);
  }
  if (!["status", "config", "download"].includes(step)) return json({ ok: false, reason: "unknown step" }, 400);
  if (!me || me.role !== "owner") return json({ ok: false, reason: "owners only" }, 403);
  if (step === "status") return json(await status(sb, nowMs));
  if (step === "config") { const r = await config(sb, body, me, nowMs); return json(r.body, r.status); }
  if (!(await hasStepUp(sb, me, nowMs))) return json({ ok: false, reason: "step_up" }, 403);
  return await download(sb, me);
}

// The token's claims (only read AFTER auth.getUser has checked the token): the session id for the step-up.
// deno-lint-ignore no-explicit-any
export function jwtPayload(jwt: string): any {
  try {
    const part = String(jwt || "").split(".")[1];
    if (!part) return null;
    const t = part.replace(/-/g, "+").replace(/_/g, "/");
    const v = JSON.parse(new TextDecoder().decode(unb64(t + "===".slice((t.length + 3) % 4))));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}
// deno-lint-ignore no-explicit-any
async function caller(sb: any, req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_") || jwt.split(".").length !== 3) return null;
  const { data: u, error } = await sb.auth.getUser(jwt);
  if (error || !u || !u.user) return null;
  const payload = jwtPayload(jwt);
  if (!payload || payload.sub !== u.user.id) return null;
  const { data: p } = await sb.from("profiles").select("id, full_name, role").eq("id", u.user.id).maybeSingle();
  if (!p) return null;
  return { id: p.id, full_name: p.full_name || "", role: p.role, sessionId: String(payload.session_id || "") };
}

// deno-lint-ignore no-explicit-any
if (typeof Deno !== "undefined" && typeof (Deno as any).serve === "function" && !(globalThis as any).__BACKUP_TEST__) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json({ ok: false, reason: "Could not parse request body" }, 400); }
    try {
      const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
      const me = body && body.step === "tick" ? null : await caller(sb, req);
      return await handle(sb, body, me, req.headers, Date.now());
    } catch (e) {
      // Only the message: never secrets, links or the body.
      console.error("backup failed:", String((e as Error).message || e).slice(0, 300));
      return json({ ok: false, reason: "server" }, 500);
    }
  });
}
