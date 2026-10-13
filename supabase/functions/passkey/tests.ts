// Tests for passkey/index.ts. Run: bash supabase/functions/passkey/run_tests.sh
// deno-lint-ignore-file no-explicit-any
let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }

// An in-memory stand-in for the service-role client: the tables the function uses, with the query shapes it uses.
const KEYS: Record<string, string[]> = { step_up: ["user_id", "session_id"], passkey_challenges: ["user_id", "session_id", "kind"], step_up_fails: ["user_id"], passkeys: ["id"], profiles: ["id"] };
function fakeSb(seed: Record<string, any[]> = {}, clock?: () => number) {
  const db: Record<string, any[]> = { passkeys: [], step_up: [], passkey_challenges: [], step_up_fails: [], profiles: [], ...seed };
  let next = 1;
  function from(table: string) {
    const rows = () => db[table] || (db[table] = []);
    let op = "select", payload: any = null, single = 0;
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select() { return q; },
      insert(p: any) { op = "insert"; payload = p; return q; },
      upsert(p: any) { op = "upsert"; payload = p; return q; },
      update(p: any) { op = "update"; payload = p; return q; },
      delete() { op = "delete"; return q; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return q; },
      lt(c: string, v: any) { filters.push((r) => String(r[c]) < String(v)); return q; },
      gt(c: string, v: any) { filters.push((r) => String(r[c]) > String(v)); return q; },
      order() { return q; },
      single() { single = 1; return q; },
      maybeSingle() { single = 2; return q; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const pick = (list: any[]) => single === 1 ? (list.length === 1 ? { data: list[0], error: null } : { data: null, error: { message: "not one row" } }) : single === 2 ? { data: list[0] || null, error: null } : { data: list, error: null };
    function run() {
      const match = (r: any) => filters.every((f) => f(r));
      if (op === "select") return pick(rows().filter(match).map((r) => ({ ...r })));
      if (op === "insert") {
        if (table === "passkeys" && rows().some((r) => r.credential_id === payload.credential_id)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        const row = { id: "pk" + next++, created_at: new Date(clock ? clock() : 0).toISOString(), last_used_at: null, ...payload };
        rows().push(row);
        return pick([{ ...row }]);
      }
      if (op === "upsert") {
        const k = KEYS[table];
        const i = rows().findIndex((r) => k.every((c) => r[c] === payload[c]));
        if (i >= 0) rows()[i] = { ...rows()[i], ...payload }; else rows().push({ ...payload });
        return { data: null, error: null };
      }
      if (op === "update") { rows().filter(match).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      db[table] = rows().filter((r) => !match(r));   // delete
      return { data: null, error: null };
    }
    return q;
  }
  // The two SQL functions of the try counter (section G-faceid), with the same rules: one step each, so tries sent at the
  // same time each get their own number (JavaScript runs each call to the end before the next).
  const WINDOW_MS = (m: number) => m * 60e3;
  function rpc(name: string, args: any) {
    const now = clock ? clock() : 0, rows = db.step_up_fails;
    let data: any = null;
    if (name === "step_up_fail_reserve") {
      const r = rows.find((x) => x.user_id === args.p_user);
      if (!r) { rows.push({ user_id: args.p_user, n: 1, first_at: new Date(now).toISOString() }); data = 1; }
      else if (Date.parse(r.first_at) < now - WINDOW_MS(args.p_window_minutes)) { r.n = 1; r.first_at = new Date(now).toISOString(); data = 1; }
      else { r.n += 1; data = r.n; }
    } else if (name === "step_up_fail_release") {
      const r = rows.find((x) => x.user_id === args.p_user);
      if (r && r.n <= 1) db.step_up_fails = rows.filter((x) => x !== r); else if (r) r.n -= 1;
    } else return Promise.resolve({ data: null, error: { message: "no function " + name } });
    rpcCalls.push(name);
    return Promise.resolve({ data, error: null });
  }
  const rpcCalls: string[] = [];
  return { db, from, rpc, rpcCalls };
}

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const SA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
function setup(opts: any = {}) {
  let now = T0;
  const sb = fakeSb(opts.seed || {}, () => now);
  const calls: any = { genReg: [], verReg: [], genAuth: [], verAuth: [], password: [] };
  let ch = 0;
  const wa = {
    genReg: async (o: any) => { calls.genReg.push(o); return { challenge: "reg-ch-" + (++ch), rp: { id: o.rpID }, excludeCredentials: o.excludeCredentials }; },
    verReg: async (o: any) => { calls.verReg.push(o); if (opts.verRegThrow) throw new Error("bad attestation"); if (opts.verRegNo) return { verified: false }; return { verified: true, registrationInfo: { credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3, 251, 255]), counter: 0, transports: ["internal"] }, credentialDeviceType: "multiDevice", credentialBackedUp: true } }; },
    genAuth: async (o: any) => { calls.genAuth.push(o); return { challenge: "auth-ch-" + (++ch), allowCredentials: o.allowCredentials }; },
    verAuth: async (o: any) => { calls.verAuth.push(o); if (opts.verAuthNo) return { verified: false }; if (o.expectedChallenge !== o.response.challenge) throw new Error("challenge mismatch"); return { verified: true, authenticationInfo: { newCounter: 7 } }; },
  };
  const password = async (email: string, pw: string, code?: string) => {
    calls.password.push([email, pw, code]);
    await new Promise((r) => setTimeout(r, 1));   // a real check takes a moment: tries sent together overlap here
    if (opts.authDown) throw new Error("sign-in check unavailable (500)");
    if (pw !== "right-pw") return { wrong: "password" };
    if (!opts.totp) return { ok: true, withCode: false };
    if (!code) return { needCode: true };
    return code === "123456" ? { ok: true, withCode: true } : { wrong: "code" };
  };
  const deps = { sb, wa, password, now: () => now };
  const who = (o: any = {}) => ({ userId: U1, email: "o@x.com", sessionId: SA, payload: {}, factors: [], providers: ["email"], name: "Ofek Shamir", ...o });
  const run = (body: any, w: any = who()) => handle(deps, body, w);
  return { sb, calls, run, who, tick: (ms: number) => { now += ms; }, now: () => now };
}

(async () => {
  // ── pure helpers ──
  const enc = (s: string) => new TextEncoder().encode(s);
  eq([b64urlEncode(enc("hello")), b64urlEncode(new Uint8Array([251, 255])), b64urlEncode(new Uint8Array([]))], ["aGVsbG8", "-_8", ""], "b64urlEncode: known vectors, no padding");
  const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
  eq(Array.from(b64urlDecode(b64urlEncode(all))), Array.from(all), "b64url: round trip of every byte value");
  eq([Array.from(b64urlDecode("-_8")), new TextDecoder().decode(b64urlDecode("aGVsbG8"))], [[251, 255], "hello"], "b64urlDecode: known vectors");
  const tok = "x." + b64urlEncode(enc(JSON.stringify({ sub: U1, session_id: SA, aal: "aal1" }))) + ".sig";
  eq([jwtPayload(tok), jwtPayload("junk"), jwtPayload("a.!!!.c"), jwtPayload(""), jwtPayload("a." + b64urlEncode(enc("[1]")) + ".c")], [{ sub: U1, session_id: SA, aal: "aal1" }, null, null, null, null], "jwtPayload: the claims, or null on anything else");
  eq([cleanDeviceName("  Ofek's\u0000 \n iPhone\u0007 "), cleanDeviceName("x".repeat(80)).length, cleanDeviceName(""), cleanDeviceName(null), cleanDeviceName("\u0001\u0002")], ["Ofek's iPhone", 60, "This device", "This device", "This device"], "cleanDeviceName: control characters out, spaces collapsed, 60 characters, empty → This device");
  eq(["Face ID", "Fingerprint", "Windows Hello", "Retina", undefined].map(cleanKind), ["Face ID", "Fingerprint", "Windows Hello", "Fingerprint", "Fingerprint"], "cleanKind: one of three, else Fingerprint");
  const nowS = 1_000_000;
  eq([freshOauth([{ method: "oauth", timestamp: nowS - 100 }], nowS, 300), freshOauth([{ method: "oauth", timestamp: nowS - 400 }], nowS, 300), freshOauth([{ method: "oauth", timestamp: nowS + 50 }], nowS, 300), freshOauth([{ method: "password", timestamp: nowS - 10 }], nowS, 300), freshOauth(null, nowS, 300), freshOauth([{ method: "totp", timestamp: nowS - 5 }, { method: "oauth", timestamp: nowS - 5 }], nowS, 300)],
    [true, false, false, false, false, true], "freshOauth: Google sign-in at most 5 minutes old, never in the future");
  eq([hasVerifiedTotp([{ factor_type: "totp", status: "verified" }]), hasVerifiedTotp([{ factor_type: "totp", status: "unverified" }]), hasVerifiedTotp([{ factor_type: "phone", status: "verified" }]), hasVerifiedTotp(undefined)], [true, false, false, false], "hasVerifiedTotp: a verified authenticator-app factor only");
  eq([googleOnly(["google"]), googleOnly(["email", "google"]), googleOnly(["google", "email"]), googleOnly(["email"]), googleOnly([]), googleOnly(undefined), googleOnly("google")], [true, false, false, false, false, false, false], "googleOnly: Google and no password only");
  eq([
    authErrorKind({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" }, "password"),
    authErrorKind({ status: 400, message: "Invalid login credentials" }, "password"),
    authErrorKind({ code: "email_not_confirmed", status: 400, message: "Email not confirmed" }, "password"),
    authErrorKind({ status: 401, message: "Invalid API key" }, "password"),
    authErrorKind({ code: "validation_failed", status: 422, message: "x" }, "password"),
    authErrorKind({ code: "over_request_rate_limit", status: 429, message: "x" }, "password"),
    authErrorKind({ status: 500, message: "x" }, "password"),
    authErrorKind(null, "password"),
    authErrorKind({ code: "mfa_verification_failed", status: 422, message: "Invalid TOTP code entered" }, "code"),
    authErrorKind({ status: 400, message: "Invalid TOTP code entered" }, "code"),
    authErrorKind({ code: "mfa_challenge_expired", status: 422, message: "x" }, "code"),
    authErrorKind({ status: 503, message: "x" }, "code"),
  ], ["wrong", "wrong", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "wrong", "wrong", "unavailable", "unavailable"], "authErrorKind: only a real wrong password / code counts; setup problems, rate limits and outages don't");
  eq([STEP_UP_MINUTES, CHALLENGE_MINUTES, RP_ID, ORIGIN, RP_NAME, MAX_FAILS, FAIL_WINDOW_MINUTES, FRESH_SIGNIN_SECONDS], [30, 5, "theguysgroup.github.io", "https://theguysgroup.github.io", "OPS Service", 5, 15, 300], "constants: 30-minute unlock, 5-minute challenges, the app's site");
  eq(ANON.startsWith("sb_publishable_"), true, "ANON: falls back to the app's public key (never the service key)");

  // ── who is calling ──
  {
    const t = setup();
    eq(await t.run({ action: "status" }, null), { status: 401, body: { ok: false, reason: "signed-out" } }, "no caller → 401 signed-out");
    eq((await t.run({ action: "status" }, t.who({ sessionId: "not-a-uuid" }))).status, 401, "a session id that isn't a uuid → 401");
    eq((await t.run({ action: "status" }, t.who({ sessionId: undefined }))).status, 401, "no session id → 401");
    eq(await t.run({ action: "status" }), { status: 200, body: { ok: true, until: null, method: null, left: 0 } }, "status with no unlock → until null");
    eq(await t.run({ action: "nope" }), { status: 400, body: { ok: false, reason: "unknown action" } }, "unknown action → 400");
    eq((await t.run({})).status, 400, "no action → 400");
  }

  // ── setting up a key ──
  {
    const t = setup({ seed: { passkeys: [{ id: "k-other", user_id: U2, credential_id: "cred-u2", public_key: "AQ", counter: 0, transports: ["internal"] }, { id: "k-mine", user_id: U1, credential_id: "cred-old", public_key: "AQ", counter: 0, transports: ["hybrid", "internal"] }] } });
    eq(await t.run({ action: "reg-options" }), { status: 403, body: { ok: false, reason: "locked" } }, "reg-options while locked → 403 locked");
    eq(await t.run({ action: "reg-verify", response: { id: "x" } }), { status: 403, body: { ok: false, reason: "locked" } }, "reg-verify while locked → 403 locked");
    t.sb.db.step_up.push({ user_id: U1, session_id: SA, until: iso(T0 + 10 * 60e3), method: "password" });
    const o = await t.run({ action: "reg-options" });
    eq([o.status, o.body.ok, o.body.options.challenge], [200, true, "reg-ch-1"], "reg-options when unlocked → the options");
    const g = t.calls.genReg[0];
    eq([g.rpID, g.rpName, g.userName, g.userDisplayName, new TextDecoder().decode(g.userID), g.attestationType, g.authenticatorSelection, g.timeout], [RP_ID, "OPS Service", "o@x.com", "Ofek Shamir", U1, "none", { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" }, 60000], "genReg: the app's site, this person, a platform key with Face ID / fingerprint required");
    eq(g.excludeCredentials, [{ id: "cred-old", transports: ["hybrid", "internal"] }], "genReg: excludes this person's own keys only (never another person's)");
    eq(t.sb.db.passkey_challenges, [{ user_id: U1, session_id: SA, kind: "reg", challenge: "reg-ch-1", expires_at: iso(T0 + 5 * 60e3) }], "reg-options: the challenge is kept for THIS session, 5 minutes");
    // a challenge too old
    t.tick(6 * 60e3);
    eq(await t.run({ action: "reg-verify", response: { id: "cred-new" } }), { status: 400, body: { ok: false, reason: "expired" } }, "reg-verify with a challenge older than 5 minutes → expired");
    eq(t.sb.db.passkey_challenges.length, 0, "the expired challenge is gone");
    eq(await t.run({ action: "reg-verify", response: { id: "cred-new" } }), { status: 400, body: { ok: false, reason: "expired" } }, "reg-verify with no challenge → expired");
    eq(t.calls.verReg.length, 0, "no challenge: the library is never asked");
  }
  {
    const unlocked = { step_up: [{ user_id: U1, session_id: SA, until: iso(T0 + 20 * 60e3), method: "passkey" }] };
    const bad = setup({ seed: unlocked, verRegNo: true });
    await bad.run({ action: "reg-options" });
    eq(await bad.run({ action: "reg-verify", response: { id: "cred-new" } }), { status: 400, body: { ok: false, reason: "not-verified" } }, "the library says not verified → not-verified");
    eq(bad.sb.db.passkeys.length, 0, "not verified: no key saved");
    const thr = setup({ seed: unlocked, verRegThrow: true });
    await thr.run({ action: "reg-options" });
    eq((await thr.run({ action: "reg-verify", response: { id: "cred-new" } })).body.reason, "not-verified", "the library throws → not-verified");
    const t = setup({ seed: unlocked });
    await t.run({ action: "reg-options" });
    const r = await t.run({ action: "reg-verify", response: { id: "cred-new" }, deviceName: " Ofek's\u0000 iPhone ", deviceKind: "Face ID" });
    eq([r.status, r.body.ok, r.body.passkey.credential_id, r.body.passkey.device_name, r.body.passkey.device_kind, typeof r.body.passkey.id, r.body.passkey.created_at], [200, true, "cred-new", "Ofek's iPhone", "Face ID", "string", iso(T0)], "reg-verify: the new key is saved and returned");
    const v = t.calls.verReg[0];
    eq([v.expectedChallenge, v.expectedOrigin, v.expectedRPID, v.requireUserVerification], ["reg-ch-1", "https://theguysgroup.github.io", "theguysgroup.github.io", true], "verReg: this session's challenge, the app's origin, Face ID / fingerprint required");
    const row = t.sb.db.passkeys[0];
    eq([row.user_id, row.public_key, row.counter, row.transports, row.device_type, row.backed_up], [U1, b64urlEncode(new Uint8Array([1, 2, 3, 251, 255])), 0, ["internal"], "multiDevice", true], "the saved row: this person, the public key as base64url");
    eq(await t.run({ action: "reg-verify", response: { id: "cred-new" } }), { status: 400, body: { ok: false, reason: "expired" } }, "a challenge works once: a second verify → expired");
    await t.run({ action: "reg-options" });
    eq(await t.run({ action: "reg-verify", response: { id: "cred-new" } }), { status: 409, body: { ok: false, reason: "already" } }, "the same key again → 409 already");
    eq(t.calls.genReg[1].excludeCredentials, [{ id: "cred-new", transports: ["internal"] }], "the next set-up excludes the key just saved");
  }

  // ── unlocking with a key ──
  {
    const t = setup({ seed: { passkeys: [{ id: "k-other", user_id: U2, credential_id: "cred-u2", public_key: "AQ", counter: 0, transports: [] }] } });
    eq(await t.run({ action: "auth-options" }), { status: 404, body: { ok: false, reason: "no-passkey" } }, "auth-options with no key of my own → 404 no-passkey");
    t.sb.db.passkeys.push({ id: "k1", user_id: U1, credential_id: "cred-1", public_key: b64urlEncode(new Uint8Array([9, 8, 7])), counter: 3, transports: ["internal"] });
    const o = await t.run({ action: "auth-options" });
    eq([o.status, o.body.options.challenge, t.calls.genAuth[0].rpID, t.calls.genAuth[0].userVerification, t.calls.genAuth[0].allowCredentials], [200, "auth-ch-1", RP_ID, "required", [{ id: "cred-1", transports: ["internal"] }]], "auth-options: my keys only, Face ID / fingerprint required");
    eq(await t.run({ action: "auth-verify", response: { id: "cred-u2", challenge: "auth-ch-1" } }), { status: 404, body: { ok: false, reason: "not-found" } }, "another person's key → 404 not-found");
    eq([t.sb.db.step_up.length, t.calls.verAuth.length], [0, 0], "another person's key: no unlock, the library is never asked");
    eq((await t.run({ action: "auth-verify", response: { challenge: "auth-ch-1" } })).body.reason, "not-found", "no key id → not-found");
    eq(await t.run({ action: "auth-verify", response: { id: "cred-1", challenge: "wrong-challenge" } }), { status: 400, body: { ok: false, reason: "not-verified" } }, "a signature over another challenge → not-verified");
    eq(t.sb.db.step_up.length, 0, "not verified: no unlock");
    eq((await t.run({ action: "auth-verify", response: { id: "cred-1", challenge: "auth-ch-1" } })).body.reason, "expired", "the challenge was used up by the failed try → expired");
    await t.run({ action: "auth-options" });
    t.tick(5 * 60e3 + 1000);
    eq((await t.run({ action: "auth-verify", response: { id: "cred-1", challenge: "auth-ch-2" } })).body.reason, "expired", "a challenge older than 5 minutes → expired");
    await t.run({ action: "auth-options" });
    const v = await t.run({ action: "auth-verify", response: { id: "cred-1", challenge: "auth-ch-3" } });
    eq(v, { status: 200, body: { ok: true, until: iso(t.now() + 30 * 60e3), method: "passkey", left: 1800 } }, "a good signature → unlocked for 30 minutes, method passkey");
    const a = t.calls.verAuth[t.calls.verAuth.length - 1];
    eq([a.expectedOrigin, a.expectedRPID, a.requireUserVerification, Array.from(a.credential.publicKey), a.credential.counter, a.credential.id], [ORIGIN, RP_ID, true, [9, 8, 7], 3, "cred-1"], "verAuth: the saved public key and counter, the app's origin");
    const k = t.sb.db.passkeys.find((x: any) => x.id === "k1");
    eq([k.counter, k.last_used_at], [7, iso(t.now())], "the key's counter and last use are saved");
    eq(t.sb.db.step_up, [{ user_id: U1, session_id: SA, until: iso(t.now() + 30 * 60e3), method: "passkey" }], "step_up row for (me, this session)");
    eq((await t.run({ action: "status" })).body, { ok: true, until: iso(t.now() + 30 * 60e3), method: "passkey", left: 1800 }, "status: unlocked, with the time left");
    const bad = setup({ seed: { passkeys: [{ id: "k1", user_id: U1, credential_id: "cred-1", public_key: "AQ", counter: 0, transports: [] }] }, verAuthNo: true });
    await bad.run({ action: "auth-options" });
    eq((await bad.run({ action: "auth-verify", response: { id: "cred-1", challenge: "auth-ch-1" } })).body.reason, "not-verified", "the library says not verified → not-verified");
  }

  // ── the unlock belongs to one sign-in session ──
  {
    const t = setup({ seed: { step_up: [{ user_id: U1, session_id: SA, until: iso(T0 + 10 * 60e3), method: "password" }, { user_id: U2, session_id: SB, until: iso(T0 + 10 * 60e3), method: "password" }, { user_id: U1, session_id: SB, until: iso(T0 - 1000), method: "google" }] } });
    const onB = t.who({ sessionId: SB });
    eq((await t.run({ action: "status" }, onB)).body.until, null, "session A unlocked does NOT unlock session B");
    eq((await t.run({ action: "reg-options" }, onB)).status, 403, "session B can't set up a key with session A's unlock");
    eq(t.sb.db.step_up.some((r: any) => r.user_id === U1 && r.session_id === SB), false, "my expired unlock is cleaned on the next call");
    eq((await t.run({ action: "status" })).body.method, "password", "session A is still unlocked");
    eq(await t.run({ action: "lock" }), { status: 200, body: { ok: true } }, "lock → ok");
    eq(t.sb.db.step_up.map((r: any) => r.user_id + "/" + r.session_id), [U2 + "/" + SB], "lock removes only my row for this session");
    eq((await t.run({ action: "status" })).body.until, null, "after lock: locked");
    const t2 = setup({ seed: { step_up: [{ user_id: U1, session_id: SA, until: iso(T0 + 60e3), method: "password" }] } });
    t2.tick(61e3);
    eq((await t2.run({ action: "status" })).body.until, null, "an unlock past its time is locked");
  }

  // ── password ──
  {
    const t = setup();
    const r1 = await t.run({ action: "password", password: "nope" });
    eq([r1, t.sb.db.step_up_fails[0].n], [{ status: 401, body: { ok: false, reason: "wrong-password" } }, 1], "a wrong password → 401 wrong-password, counted");
    eq(await t.run({ action: "password", password: "" }), { status: 400, body: { ok: false, reason: "wrong-password" } }, "no password → 400, nothing asked");
    for (let i = 0; i < 4; i++) await t.run({ action: "password", password: "nope" + i });
    eq(t.sb.db.step_up_fails[0].n, 5, "five wrong tries counted");
    const asked = t.calls.password.length;
    eq(await t.run({ action: "password", password: "right-pw" }), { status: 429, body: { ok: false, reason: "too-many" } }, "after 5 wrong tries even the right password → 429 too-many");
    eq(t.calls.password.length, asked, "too many tries: the password is not even checked");
    t.tick(16 * 60e3);
    const ok = await t.run({ action: "password", password: "right-pw" });
    eq([ok.status, ok.body.ok, ok.body.method, ok.body.until], [200, true, "password", iso(t.now() + 30 * 60e3)], "16 minutes later the right password unlocks (method password)");
    eq(t.sb.db.step_up_fails.length, 0, "the right password clears the wrong tries");
    eq(t.calls.password[t.calls.password.length - 1], ["o@x.com", "right-pw", undefined], "the password is checked for the signed-in person's own email");
    const t3 = setup();
    for (let i = 0; i < 3; i++) await t3.run({ action: "password", password: "no" });
    t3.tick(16 * 60e3);
    await t3.run({ action: "password", password: "no" });
    eq([t3.sb.db.step_up_fails[0].n, t3.sb.db.step_up_fails[0].first_at], [1, iso(t3.now())], "a wrong try after the 15 minutes starts counting again");
  }
  {
    // 50 wrong passwords sent at the same time: each try is counted before its check, so at most 5 are checked.
    const t = setup();
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => t.run({ action: "password", password: "guess-" + i })));
    eq([t.calls.password.length, rs.filter((r: any) => r.body.reason === "wrong-password").length, rs.filter((r: any) => r.status === 429).length], [5, 5, 45], "50 tries at the same time: only 5 passwords are checked, 45 refused as too many");
    eq(t.sb.rpcCalls.filter((n: string) => n === "step_up_fail_reserve").length, 50, "every try is counted in one database step (step_up_fail_reserve)");
    eq((await t.run({ action: "password", password: "right-pw" })).status, 429, "and the right password is refused too until the 15 minutes are over");
  }
  {
    // A check that can't run (an Auth outage, a setup problem) is not a wrong try: 500 server, nothing counted.
    const t = setup({ authDown: true });
    for (let i = 0; i < 7; i++) {
      let threw = false;
      try { await t.run({ action: "password", password: "right-pw" }); } catch (_) { threw = true; }
      if (!threw) { eq(threw, true, "an unavailable check throws (→ 500 server)"); break; }
    }
    eq([t.sb.db.step_up_fails.length, t.calls.password.length], [0, 7], "7 checks that couldn't run: nothing counted, never too-many");
  }
  {
    const t = setup({ totp: true });
    eq(await t.run({ action: "password", password: "right-pw" }), { status: 200, body: { ok: false, needCode: true } }, "two-step on, no code yet → needCode");
    eq([t.sb.db.step_up.length, t.sb.db.step_up_fails.length], [0, 0], "needCode: no unlock and no wrong try (the try is given back)");
    for (let i = 0; i < 6; i++) await t.run({ action: "password", password: "right-pw" });
    eq([t.sb.db.step_up_fails.length, (await t.run({ action: "password", password: "right-pw" })).body.needCode], [0, true], "the right password many times without the code never locks the person out");
    eq(await t.run({ action: "password", password: "right-pw", code: "654 321" }), { status: 401, body: { ok: false, reason: "wrong-code" } }, "a wrong code → 401 wrong-code");
    eq(t.sb.db.step_up_fails[0].n, 1, "a wrong code is counted too");
    const ok = await t.run({ action: "password", password: "right-pw", code: "123 456" });
    eq([ok.status, ok.body.method], [200, "password+code"], "the right password and code → method password+code (spaces in the code are fine)");
    eq([JSON.stringify(ok.body).includes("right-pw"), JSON.stringify(await t.run({ action: "password", password: "secret-x" })).includes("secret-x")], [false, false], "no answer ever contains the password");
  }

  // ── Continue with Google (M6-3: only for someone who signs in with Google alone) ──
  {
    const t = setup();
    const nowSec = Math.floor(T0 / 1000);
    const G = ["google"];
    const g = await t.run({ action: "google" }, t.who({ providers: G, payload: { amr: [{ method: "oauth", timestamp: nowSec - 100 }], aal: "aal1" } }));
    eq([g.status, g.body.method, g.body.until], [200, "google", iso(T0 + 30 * 60e3)], "Google-only account, Google sign-in 100 s ago → unlocked (method google)");
    const both = await t.run({ action: "google" }, t.who({ sessionId: SB, providers: ["email", "google"], payload: { amr: [{ method: "oauth", timestamp: nowSec - 10 }], aal: "aal1" } }));
    eq([both, t.sb.db.step_up.some((r: any) => r.session_id === SB)], [{ status: 401, body: { ok: false, reason: "use-password" } }, false], "an account WITH a password (and Google linked), a fresh Google sign-in → 401 use-password, no unlock");
    eq((await t.run({ action: "google" }, t.who({ sessionId: SB, providers: undefined, payload: { amr: [{ method: "oauth", timestamp: nowSec - 10 }] } }))).body.reason, "use-password", "sign-in methods unknown → use-password");
    eq((await t.run({ action: "google" }, t.who({ sessionId: SB, providers: G, payload: { amr: [{ method: "oauth", timestamp: nowSec - 400 }] } }))).body, { ok: false, reason: "not-fresh" }, "Google sign-in 400 s ago → not-fresh");
    eq((await t.run({ action: "google" }, t.who({ sessionId: SB, providers: G, payload: { amr: [{ method: "password", timestamp: nowSec - 10 }] } }))).status, 401, "a password sign-in can't claim the Google unlock");
    const totp = [{ factor_type: "totp", status: "verified" }];
    eq((await t.run({ action: "google" }, t.who({ sessionId: SB, providers: G, factors: totp, payload: { amr: [{ method: "oauth", timestamp: nowSec - 10 }], aal: "aal1" } }))).body.reason, "not-fresh", "two-step on but the code not given yet (aal1) → not-fresh");
    eq((await t.run({ action: "google" }, t.who({ sessionId: SB, providers: G, factors: totp, payload: { amr: [{ method: "totp", timestamp: nowSec - 5 }, { method: "oauth", timestamp: nowSec - 30 }], aal: "aal2" } }))).body.method, "google", "two-step on and the code given (aal2) → unlocked");
  }

  console.log(`passkey: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
