// Tests for own keys (stage 6 v2 G5): the key format and provider, key_save / key_test / key_delete (checked with a fake
// GET /v1/models), who may touch which key, the per-person try limit, status, chats on a person's own OpenAI or
// Anthropic key and on the business's key, a key pasted into the chat, and that no key ever shows up in an answer, a
// log line or a table (only in the fake Vault, db.vault). Appended to tests.ts by run_tests.sh; it only pushes a suite,
// so it shares tests.ts's helpers (world, chat, manage, eq, ok, …). Every key here is a fake.
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const ENV = (globalThis as any).__AI_ENV__;
  const saved = { fetch: io.fetch, client: io.anthropicClient, sleep: io.sleep, env: { ...ENV } };
  delete ENV.ANTHROPIC_API_KEY; delete ENV.CLOUDFLARE_ACCOUNT_ID; delete ENV.CLOUDFLARE_AI_TOKEN;
  io.sleep = async () => {};
  const KEY_OA = "sk-test-FAKE-openai-000000000000000WXYZ", KEY_OA2 = "sk-test-FAKE-openai-111111111111111LMNO";
  const KEY_AN = "sk-ant-test-FAKE-0000000000000000ABCD", KEY_AN2 = "sk-ant-test-FAKE-1111111111111111EFGH";
  const KEYS = [KEY_OA, KEY_OA2, KEY_AN, KEY_AN2];
  const enc = new TextEncoder();
  const sseRes = (frames: any[]) => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode("data: " + JSON.stringify(f) + "\n\n")); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream" } });
  const oaText = (text: string) => () => sseRes([
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10 } },
  ]);
  const status = (n: number) => () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: n, headers: { "content-type": "application/json" } });
  // The fake fetch: the models check and the chat calls, in order (the last reply repeats); every request is kept.
  let fetches: any[] = [];
  const serve = (replies: (() => Response)[]) => {
    fetches = [];
    io.fetch = async (url: string, init: RequestInit) => {
      fetches.push({ url, method: init.method, headers: { ...(init.headers as any) }, body: init.body ? JSON.parse(String(init.body)) : null });
      return replies[Math.min(fetches.length - 1, replies.length - 1)]();
    };
  };
  const throwing = () => { fetches = []; io.fetch = async (url: string) => { fetches.push({ url }); throw new Error("network down"); }; };
  // Each block starts 11 minutes later, so the per-person try limit (5 in 10 minutes) never carries over.
  let tick = 0;
  const fresh = (over: Record<string, any> = {}, seed: Record<string, any[]> = {}) => { const db = world({ provider: "auto", ...over }, seed); NOW = T0 + ++tick * 11 * 60e3; return db; };
  const seen: string[] = [];   // every answer, SSE text and table of the runs below
  const keep = (db: any, ...rs: any[]) => { for (const r of rs) seen.push(r.text); seen.push(JSON.stringify(db.T)); };
  const save = (db: any, key: string, jwt = "jwt-owner", scope = "me", provider?: string) => manage(db, { step: "key_save", scope, key, ...(provider ? { provider } : {}) }, jwt);

  // ── K1. the format and the provider ──
  {
    eq([KEY_OA, KEY_AN, "sk-short", "pk-test-FAKE-000000000000000000", "sk-test FAKE 0000000000000000000", "sk-" + "x".repeat(298)].map(keyProviderOf), ["openai", "anthropic", null, null, null, null], "keyProviderOf: sk-ant- → anthropic, other sk- → openai, else null (length, spaces)");
    eq([KEY_RE.test("a".repeat(20)), KEY_RE.test("a".repeat(19)), KEY_RE.test("a".repeat(300)), KEY_RE.test("a".repeat(301)), KEY_RE.test("é".repeat(20))], [true, false, true, false, false], "KEY_RE: 20–300 printable ASCII");
    eq(last4Of(KEY_OA), "WXYZ", "last4Of");
    eq([callCost(mergePrices({}), "gpt-4.1-mini", { input_tokens: 200000, cache_read_input_tokens: 800000, output_tokens: 0 }), callCost(mergePrices({}), "gpt-4o-mini", { input_tokens: 0, cache_read_input_tokens: 1e6, output_tokens: 0 })], [0.16, 0.075], "OpenAI cached input at OpenAI's rate (gpt-4.1-mini 0.10, gpt-4o-mini 0.075 per M), not 0.1×");
  }

  // ── K2. key_save: format, provider, the models check, what is saved and answered ──
  {
    let db = fresh();
    serve([status(200)]);
    let r = await save(db, "not-a-key");
    eq([r.status, r.body.code, fetches.length], [400, "key_format", 0], "key_save: a malformed key → 400 key_format, nothing sent");
    r = await save(db, KEY_AN, "jwt-owner", "me", "openai");
    eq([r.status, r.body.code, fetches.length], [400, "key_provider_mismatch", 0], "key_save: an sk-ant- key as openai → key_provider_mismatch");
    keep(db, r);
    r = await save(db, KEY_OA, "jwt-owner", "me", "openai");
    eq([r.status, r.body], [200, { ok: true, key: { scope: "me", provider: "openai", last4: "WXYZ", status: "ok" } }], "key_save: the provider says 200 → saved; the answer holds only the last 4");
    eq([db.vault.size, [...db.vault.values()][0] === KEY_OA, db.T.ai_keys.length, db.T.ai_keys[0].scope, db.T.ai_keys[0].user_id, db.T.ai_keys[0].last4], [1, true, 1, "user", "u-owner", "WXYZ"], "… the key is in the vault only; the row holds its state");
    eq([fetches[0].url, fetches[0].method, fetches[0].headers.Authorization === "Bearer " + KEY_OA], ["https://api.openai.com/v1/models", "GET", true], "… OpenAI: GET /v1/models with a Bearer header");
    keep(db, r);
    db = fresh();
    serve([status(200)]);
    r = await save(db, KEY_AN);
    eq([r.status, r.body.key.provider, fetches[0].url, fetches[0].headers["x-api-key"] === KEY_AN, fetches[0].headers["anthropic-version"], fetches[0].headers.Authorization], [200, "anthropic", "https://api.anthropic.com/v1/models?limit=1", true, "2023-06-01", undefined], "… Anthropic: x-api-key + anthropic-version, ?limit=1");
    keep(db, r);
    db = fresh();
    serve([status(401)]);
    r = await save(db, KEY_OA);
    eq([r.status, r.body.code, db.vault.size, (db.T.ai_keys || []).length], [400, "key_invalid", 0, 0], "key_save: 401 → key_invalid, nothing saved");
    keep(db, r);
    throwing();
    r = await save(db, KEY_OA);
    eq([r.status, r.body.code, db.vault.size, (db.T.ai_keys || []).length], [502, "key_unchecked", 0, 0], "key_save: the check throws → key_unchecked, nothing saved");
    serve([status(500)]);
    r = await save(db, KEY_OA);
    eq([r.body.code, db.vault.size], ["key_unchecked", 0], "key_save: another status (500) → key_unchecked");
    keep(db, r);
  }

  // ── K3. who may save which key ──
  {
    let db = fresh();
    serve([status(200)]);
    let r = await save(db, KEY_OA, "jwt-manager", "business");
    eq([r.status, r.body.code, db.vault.size], [403, "not_allowed", 0], "key_save: a manager on business → not_allowed");
    r = await save(db, KEY_OA, "jwt-owner", "business");
    eq([r.status, r.body.key.scope, db.T.ai_keys[0].scope, db.T.ai_keys[0].user_id], [200, "business", "business", null], "key_save: an owner on business → saved as the business's key");
    keep(db, r);
    db = fresh({ allow_own_keys: false });
    r = await save(db, KEY_OA, "jwt-tech");
    eq([r.status, r.body.code], [403, "keys_off"], "key_save: own keys switched off → keys_off");
    db = fresh({ roles_enabled: { owner: true, manager: true, va: true, technician: false, marketing: true } });
    r = await save(db, KEY_OA, "jwt-tech");
    eq([r.status, r.body.code], [403, "role_off"], "key_save: the person's role switched off → role_off");
    r = await save(db, KEY_OA, "jwt-tech", "everyone");
    eq([r.status, r.body.code], [400, "bad_request"], "key_save: an unknown scope → bad_request");
    keep(db, r);
  }

  // ── K4. the try limit: 5 saves / tests per person in 10 minutes ──
  {
    const db = fresh();
    serve([status(401)]);
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push((await save(db, KEY_OA, "jwt-manager")).body.code);
    eq(codes, ["key_invalid", "key_invalid", "key_invalid", "key_invalid", "key_invalid", "too_many_tries"], "the 6th try in 10 minutes → too_many_tries");
    const r = await save(db, KEY_OA, "jwt-manager");
    eq([r.status, fetches.length], [429, 5], "… 429, and the provider isn't asked");
    eq((await save(db, KEY_OA, "jwt-tech")).body.code, "key_invalid", "… another person still can");
    NOW += 10 * 60e3 + 1;
    eq((await save(db, KEY_OA, "jwt-manager")).body.code, "key_invalid", "… and after 10 minutes the person can again");
  }

  // ── K5. key_test ──
  {
    const db = fresh();
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-tech");
    serve([status(200)]);
    let r = await manage(db, { step: "key_test", scope: "me" }, "jwt-tech");
    eq([r.status, r.body.key.status, r.body.key.last4, fetches[0].headers.Authorization === "Bearer " + KEY_OA], [200, "ok", "WXYZ", true], "key_test: 200 → ok (the saved key is sent to its provider)");
    serve([status(401)]);
    r = await manage(db, { step: "key_test", scope: "me" }, "jwt-tech");
    eq([r.status, r.body.key.status, db.T.ai_keys[0].status, db.T.ai_keys[0].last_error], [200, "invalid", "invalid", "key_invalid"], "key_test: 401 → status 'invalid' (ai_key_mark)");
    r = await manage(db, { step: "key_test", scope: "me" }, "jwt-manager");
    eq([r.status, r.body.code], [404, "no_key"], "key_test: no saved key → no_key");
    keep(db, r);
  }

  // ── K6. key_delete ──
  {
    const db = fresh();
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-tech");
    await save(db, KEY_OA2, "jwt-manager");
    await save(db, KEY_AN, "jwt-owner");
    eq(db.vault.size, 3, "three keys saved");
    let r = await manage(db, { step: "key_delete", scope: "me" }, "jwt-owner");
    eq([r.status, r.body, db.vault.size, [...db.vault.values()].includes(KEY_AN), db.T.ai_keys.length], [200, { ok: true, deleted: true }, 2, false, 2], "key_delete: own → the row and the vault entry are gone");
    r = await manage(db, { step: "key_delete", scope: "me", user_id: "u-tech" }, "jwt-manager");
    eq([r.status, r.body.code, db.vault.size], [403, "not_allowed", 2], "key_delete: a manager can't remove another person's key");
    r = await manage(db, { step: "key_delete", scope: "me", user_id: "u-tech" }, "jwt-owner");
    eq([r.status, r.body.deleted, [...db.vault.values()].includes(KEY_OA), db.T.ai_keys.map((k: any) => k.user_id)], [200, true, false, ["u-manager"]], "key_delete: an owner removes a technician's key by user_id");
    r = await manage(db, { step: "key_delete", scope: "business" }, "jwt-manager");
    eq([r.status, r.body.code], [403, "not_allowed"], "key_delete: a manager can't remove the business's key");
    r = await manage(db, { step: "key_delete", scope: "me" }, "jwt-owner");
    eq([r.status, r.body.deleted], [200, false], "key_delete: nothing there → deleted false");
    keep(db, r);
  }

  // ── K7. status ──
  {
    const db = fresh({ provider: "anthropic", monthly_cap_usd: 5 });
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-tech");
    await save(db, KEY_AN, "jwt-owner", "business");
    let r = await manage(db, { step: "status" }, "jwt-tech");
    eq([r.body.keys, r.body.source.key_source, r.body.source.provider], [{ allow_own: true, me: { provider: "openai", last4: "WXYZ", status: "ok", has_key: true } }, "own_user", "openai"], "status: the person's own key (last 4) and that it answers");
    keep(db, r);
    r = await manage(db, { step: "status" }, "jwt-owner");
    eq([r.body.keys.me, r.body.keys.business && r.body.keys.business.last4, r.body.source.key_source], [null, "ABCD", "own_business"], "status (owner): the business's key and that it answers");
    eq(r.body.keys.people.map((p: any) => Object.keys(p).sort().join(",")), ["created_at,provider,status,user_id"], "… people: user, provider, status, date — no last4");
    keep(db, r);
    r = await manage(db, { step: "status" }, "jwt-manager");
    eq(["business" in r.body.keys, "people" in r.body.keys, r.body.keys.me], [false, false, null], "status (manager): no business key, no people");
    eq([r.body.source.key_source, r.body.source.provider, r.body.blocked, JSON.stringify(r.body).includes("ABCD")], ["own_business", "anthropic", null, false], "… yet who answers counts the business's key (never shown)");
    keep(db, r);
  }

  // ── K8. a chat on a person's own OpenAI key: outside the cap and the daily limit ──
  {
    const db = fresh({ daily_user_limit: 1, monthly_cap_usd: 5, provider: "anthropic" });
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-manager");
    serve([oaText("Hello from your key")]);
    const r1 = await chat(db, { text: "Hi there" }, "jwt-manager");
    const start = evs(r1, "start")[0];
    eq([start.provider, start.key_source, start.model, evs(r1, "text").map((t: any) => t.delta).join("")], ["openai", "own_user", "gpt-4.1-mini", "Hello from your key"], "own OpenAI key: it answers, on gpt-4.1-mini");
    const f = fetches[0];
    eq([f.url, f.headers.Authorization === "Bearer " + KEY_OA, f.body.model, f.body.stream, f.body.stream_options], ["https://api.openai.com/v1/chat/completions", true, "gpt-4.1-mini", true, { include_usage: true }], "… Chat Completions with the person's key, streamed with the usage chunk");
    const u = db.T.ai_usage[0];
    eq([u.key_source, u.provider, u.status, u.input_tokens, u.cost_usd > 0], ["own_user", "openai", "ok", 1000, true], "… the usage row: own_user, openai (priced for information)");
    ok(!!db.T.ai_keys[0].last_used_at, "… the key's last use is recorded");
    const r2 = await chat(db, { text: "And again" }, "jwt-manager");
    eq([r2.status, evs(r2, "start")[0]?.key_source, db.T.ai_usage.length], [200, "own_user", 2], "… a daily limit of 1 still allows a 2nd own-key turn (not counted)");
    const sm = await manage(db, { step: "status" }, "jwt-manager");
    eq([evs(r2, "done")[0].limits.today_used, sm.body.today.used], [0, 0], "… done and status count today's questions as the limit does (own-key turns left out)");
    const st = await manage(db, { step: "status" }, "jwt-owner");
    eq(st.body.month.spend_usd, 0, "… the paid spend (the cap) is unchanged");
    keep(db, r1, r2, st);
  }

  // ── K9. a chat on a person's own Anthropic key: their own client, never the platform's ──
  {
    const db = fresh({ provider: "anthropic", monthly_cap_usd: 5 });
    ENV.ANTHROPIC_API_KEY = "test-key-platform";
    serve([status(200)]);
    await save(db, KEY_AN, "jwt-owner");
    await save(db, KEY_AN2, "jwt-manager");
    const made: string[] = [];
    io.anthropicClient = (k: string) => { made.push(k); return fakeClient([textScript("Own Claude")]); };
    const r1 = await chat(db, { text: "Hello" }, "jwt-owner");
    const r2 = await chat(db, { text: "Hello" }, "jwt-manager");
    eq([evs(r1, "start")[0].key_source, evs(r2, "start")[0].key_source], ["own_user", "own_user"], "own Anthropic key: own_user");
    eq([made.length, made[0] === KEY_AN, made[1] === KEY_AN2, made.includes("test-key-platform")], [2, true, true, false], "… io.anthropicClient gets each person's own key, never ANTHROPIC_API_KEY, no memo shared between people");
    delete ENV.ANTHROPIC_API_KEY;
    keep(db, r1, r2);
  }

  // ── K10. an own key refused mid-chat ──
  {
    const db = fresh();
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-tech");
    serve([status(401)]);
    const r1 = await chat(db, { text: "Hello" }, "jwt-tech");
    const err = evs(r1, "error")[0];
    eq([err.code, err.retryable, evs(r1, "done").length], ["own_key_refused", true, 0], "own key 401 mid-chat → error own_key_refused (retryable)");
    eq([db.T.ai_keys[0].status, db.T.ai_keys[0].last_error, db.T.ai_usage[0].error_code], ["invalid", "refused", "own_key_refused"], "… the key is marked invalid");
    const r2 = await chat(db, { text: "Hello again" }, "jwt-tech");
    eq([evs(r2, "start")[0].key_source, evs(r2, "done").length], ["mock", 1], "… the next turn skips the key (nothing else set up here: the test provider)");
    const st = await manage(db, { step: "status" }, "jwt-tech");
    eq([st.body.keys.me.status, st.body.source.key_source], ["invalid", "mock"], "… status: the key's status 'invalid' (the app's banner)");
    keep(db, r1, r2, st);
  }

  // ── K10b. the business's own key refused mid-chat ──
  {
    const db = fresh({ provider: "anthropic", monthly_cap_usd: 5 });
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-owner", "business");
    serve([status(401)]);
    const r1 = await chat(db, { text: "Hello" }, "jwt-tech");
    const err = evs(r1, "error")[0];
    eq([err.code, err.retryable, /business's AI key/.test(err.text)], ["business_key_refused", true, true], "business key 401 mid-chat → business_key_refused (not the server's key, not 'your key')");
    eq([db.T.ai_keys[0].status, db.T.ai_keys[0].last_error], ["invalid", "refused"], "… the key is marked invalid");
    const r2 = await chat(db, { text: "Hello again" }, "jwt-tech");
    eq([evs(r2, "start")[0].key_source, evs(r2, "done").length], ["mock", 1], "… the next turn skips it (nothing else set up here: the test provider)");
    serve([status(503)]);
    db.T.ai_keys[0].status = "ok";
    const r3 = await chat(db, { text: "Busy?" }, "jwt-tech");
    eq(evs(r3, "error")[0].text.startsWith("Your key"), false, "… a busy business key never says 'Your key' to staff");
    keep(db, r1, r2, r3);
  }

  // ── K11. the business's own key: the paid switch and a cap above 0, counted against the cap ──
  {
    const db = fresh({ provider: "anthropic", monthly_cap_usd: 5 });
    serve([status(200)]);
    await save(db, KEY_OA, "jwt-owner", "business");
    serve([oaText("Business answer")]);
    const r1 = await chat(db, { text: "Hello" }, "jwt-manager");
    eq([evs(r1, "start")[0].key_source, evs(r1, "start")[0].provider, fetches[0].headers.Authorization === "Bearer " + KEY_OA], ["own_business", "openai", true], "business key + paid switch + cap 5 → own_business");
    const st = await manage(db, { step: "status" }, "jwt-owner");
    ok(st.body.month.spend_usd > 0 && st.body.month.spend_usd === db.T.ai_usage[0].cost_usd, "… counted by the cap (capSpend)");
    db.T.ai_settings[0].monthly_cap_usd = 0;
    ENV.CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef"; ENV.CLOUDFLARE_AI_TOKEN = "cf-test-token";
    serve([oaText("Free answer")]);
    const r2 = await chat(db, { text: "Hello" }, "jwt-manager");
    eq([evs(r2, "start")[0].key_source, fetches[0].url.includes("api.cloudflare.com"), fetches.some((x) => x.url.includes("openai.com"))], ["free", true, false], "… the same key with cap 0 → skipped (the free AI answers)");
    delete ENV.CLOUDFLARE_ACCOUNT_ID; delete ENV.CLOUDFLARE_AI_TOKEN;
    keep(db, r1, r2, st);
  }

  // ── K12. a key pasted into the chat ──
  {
    const db = fresh();
    serve([status(200)]);
    const r = await chat(db, { text: "here is my key " + KEY_OA2 + " please use it" }, "jwt-tech");
    eq([r.status, r.body.code, db.T.ai_messages.length, db.T.ai_conversations.length, db.T.ai_usage.length, fetches.length], [400, "key_in_chat", 0, 0, 0, 0], "key_in_chat → 400, nothing stored or sent");
    eq((await chat(db, { text: "what does sk-learn do?" }, "jwt-tech")).status, 200, "… a short 'sk-' word is fine");
    keep(db, r);
  }

  // ── K13. no key anywhere: answers, SSE, logs, tables (the vault aside) ──
  {
    const all = seen.join("\n") + "\n" + logged.join("\n");
    eq(KEYS.filter((k) => all.includes(k) || all.includes(k.slice(0, 24))), [], "no key text in any answer, SSE stream, table or log line");
  }

  io.fetch = saved.fetch; io.anthropicClient = saved.client; io.sleep = saved.sleep;
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, saved.env);
});
