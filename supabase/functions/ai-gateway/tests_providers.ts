// Tests for the provider layer (stage 6 v2 G4): who answers a turn (resolveSource), the free AI's quota in neurons (UTC
// days, a per-business share), the OpenAI-format translator and stream parser (CF_FIXTURES from fixtures/, embedded by
// run_tests.sh) and the Cloudflare adapter end to end through handleHttp with a fake fetch. Appended to tests.ts by
// run_tests.sh; it only pushes a suite, so it shares tests.ts's helpers (world, paidWorld, chat, manage, eq, ok, …).
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const ENV = (globalThis as any).__AI_ENV__;
  const CF_ACC = "0123456789abcdef0123456789abcdef", CF_TOKEN = "cf-test-token", GLM = "@cf/zai-org/glm-4.7-flash";
  const cfOn = () => { ENV.CLOUDFLARE_ACCOUNT_ID = CF_ACC; ENV.CLOUDFLARE_AI_TOKEN = CF_TOKEN; };
  const cfOff = () => { delete ENV.CLOUDFLARE_ACCOUNT_ID; delete ENV.CLOUDFLARE_AI_TOKEN; };
  const fx = (name: string) => { const f = CF_FIXTURES.find((x) => x.name === name); if (!f) throw new Error("missing fixture " + name); return f.body; };
  const enc = new TextEncoder();
  // A streamed body in pieces of `size` bytes (lines and \r\n split across reads).
  const streamRes = (body: string, size = 7) => {
    const bytes = enc.encode(body);
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const jsonRes = (status: number, j: any) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const sse = (name: string, size = 7) => () => streamRes(fx(name), size);
  const nonstream = () => jsonRes(200, JSON.parse(fx("cf-nonstream")));
  // The fake fetch: plays the replies in order (the last one repeats) and records every request.
  let fetches: any[] = [];
  const serve = (replies: (() => Response)[]) => {
    fetches = [];
    io.fetch = async (url: string, init: RequestInit) => {
      fetches.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return replies[Math.min(fetches.length - 1, replies.length - 1)]();
    };
  };
  const sleep0 = io.sleep;
  io.sleep = async () => {};
  const seen: string[] = [];   // every SSE text, JSON answer and stored row of the end-to-end runs (no secrets in them)
  const keep = (db: any, ...rs: any[]) => { for (const r of rs) seen.push(r.text); seen.push(JSON.stringify([db.T.ai_usage, db.T.ai_messages, db.T.ai_conversations])); };
  const freeRow = (business_id: string, neurons: number, over: any = {}) => ({ id: "f-" + business_id + "-" + neurons, business_id, user_id: "u-x", key_source: "free", provider: "cloudflare", neurons, cost_usd: 0, at: new Date(T0 - 3600e3).toISOString(), status: "ok", error_code: null, ...over });

  // ── P1. normSettings: the 3-state provider, the free quota, own keys ──
  {
    eq(["anthropic", "mock", "auto", "openai", undefined].map((p) => normSettings({ provider: p }).provider), ["anthropic", "mock", "auto", "auto", "auto"], "normSettings: provider anthropic | mock | auto (anything else)");
    const f = normSettings({ free_quota: { daily_neurons: 5, share_pct: 500, reserve_neurons: -1, max_prompt_tokens: 1e9, thinking: true, stream: false, neurons: { [GLM]: { in: 1, out: -2 }, "@cf/new/model": { in: 3, out: 4 }, "@cf/half": { in: 1 }, "bad name!": { in: 1, out: 1 } } } }).free;
    eq([f.daily_neurons, f.share_pct, f.reserve_neurons, f.max_prompt_tokens, f.thinking, f.stream], [100, 100, 0, 90000, true, false], "freeQuotaOf clamps every number");
    eq([f.neurons[GLM], f.neurons["@cf/new/model"], !!f.neurons["@cf/half"], !!f.neurons["bad name!"]], [{ in: 1, out: 36400 }, { in: 3, out: 4 }, false, false], "… neuron overrides: valid ones on top of NEURON_PRICES");
    eq(normSettings({}).free, { ...FREE_DEFAULTS, neurons: NEURON_PRICES }, "… FREE_DEFAULTS when nothing is set");
    eq([normSettings({}).allow_own_keys, normSettings({ allow_own_keys: false }).allow_own_keys], [true, false], "allow_own_keys: on unless switched off");
  }

  // ── P2. modelFor ──
  {
    const s = normSettings({ model_per_task: { assistant: "claude-haiku-5-5", "cloudflare:heavy": "@cf/qwen/qwen3.8-27b" } });
    eq([modelFor(s, "assistant"), modelFor(s, "heavy"), modelFor(s, "assistant", "mock")], ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "modelFor: Anthropic and the test provider read the plain task keys");
    eq([modelFor(s, "heavy", "cloudflare"), modelFor(s, "assistant", "cloudflare"), modelFor(s, "stage7_report", "cloudflare"), modelFor(s, "assistant", "openai")], ["@cf/qwen/qwen3.8-27b", GLM, GLM, "gpt-4.1-mini"], "… others: <p>:<task> → <p>:assistant → PROVIDER_MODEL_DEFAULTS (a stage 7 taskKey → the assistant model)");
  }

  // ── P3. resolveSource ──
  {
    const R = (row: any, o: any = {}) => resolveSource({ s: normSettings(row), env: { anthropic: false, cloudflare: true, ...(o.env || {}) }, userKey: null, bizKey: null, capSpend: o.capSpend ?? 0,
      free: o.free === undefined ? { platform_neurons: 0, business_neurons: 0, exhausted: false } : o.free, taskKey: "assistant", convProvider: o.convProvider, convModel: o.convModel, tz: TZ, nowMs: T0 });
    const who = (x: any) => ("source" in x ? [x.source.provider, x.source.keySource, x.source.model, x.notice || null] : [x.blocked]);
    eq(who(R({ provider: "mock" })), ["mock", "mock", "claude-haiku-5-5", null], "forced test mode");
    eq(who(R({}, { env: { cloudflare: false } })), ["mock", "mock", "claude-haiku-5-5", null], "nothing set up → the test provider");
    eq(who(R({})), ["cloudflare", "free", GLM, null], "the free AI set up with quota left → free glm");
    eq(who(R({}, { free: { platform_neurons: 0, business_neurons: 0, exhausted: true } })), ["free_quota"], "the free AI used up → free_quota, not the test provider");
    eq(who(R({ free_quota: { share_pct: 50 } }, { free: { platform_neurons: 5000, business_neurons: 5000, exhausted: false } })), ["free_share"], "this business's share used → free_share");
    const paid = { provider: "anthropic", monthly_cap_usd: 20 };
    eq(who(R(paid, { env: { anthropic: true } })), ["anthropic", "platform_paid", "claude-haiku-5-5", null], "paid switch + key + cap 20 → platform_paid, before the free AI");
    eq(who(R({ provider: "anthropic", monthly_cap_usd: 0 }, { env: { anthropic: true } })), ["cloudflare", "free", GLM, null], "paid switch + cap 0 → free");
    eq(who(R(paid)), ["cloudflare", "free", GLM, null], "paid switch without a key → free");
    eq(who(R(paid, { env: { anthropic: true }, capSpend: 20 })), ["cloudflare", "free", GLM, "cap_fallback"], "cap reached + free left → free with cap_fallback");
    const gone = R(paid, { env: { anthropic: true }, capSpend: 20, free: { platform_neurons: 10000, business_neurons: 0, exhausted: false } }) as any;
    eq([gone.blocked, gone.resets_at, /paid AI budget is used up, and so is today's free AI/.test(gone.reason)], ["cap_reached", "2026-10-16T00:00:00.000Z", true], "cap reached + free gone → cap_reached (both named)");
    eq(who(R(paid, { env: { anthropic: true, cloudflare: false }, capSpend: 25 })), ["cap_reached"], "the free AI not set up + cap reached → cap_reached");
    eq(who(R({}, { convProvider: "cloudflare", convModel: "@cf/google/gemma-4-26b-a4b-it" })), ["cloudflare", "free", "@cf/google/gemma-4-26b-a4b-it", null], "the chat's model stays while the same provider answers");
    eq(who(R({}, { convProvider: "anthropic", convModel: "claude-sonnet-5-5" })), ["cloudflare", "free", GLM, null], "… another provider answers with its own model");
    eq(who(R(paid, { env: { anthropic: true }, convProvider: null, convModel: "claude-sonnet-5-5" })), ["anthropic", "platform_paid", "claude-sonnet-5-5", null], "… a v1 chat (no provider) is an Anthropic chat");
  }

  // ── P4. the UTC day and the quota sentence ──
  {
    eq(utcDayBounds(Date.parse("2026-10-15T23:59:00Z")), { dayStart: "2026-10-15T00:00:00.000Z", resetsAt: "2026-10-16T00:00:00.000Z" }, "utcDayBounds at 23:59 UTC");
    eq(utcDayBounds(Date.parse("2026-10-16T00:01:00Z")), { dayStart: "2026-10-16T00:00:00.000Z", resetsAt: "2026-10-17T00:00:00.000Z" }, "… at 00:01 UTC: a new day");
    const ny = Date.parse("2026-10-16T01:00:00Z"), syd = Date.parse("2026-10-15T22:00:00Z");   // 21:00 in New York; 09:00 in Sydney
    eq(freeQuotaText("free_quota", utcDayBounds(ny).resetsAt, "America/New_York", ny), "Today's free AI quota is used up. It's back tomorrow, or an owner can switch on a paid AI in Settings → AI.", "freeQuotaText: Ofek's sentence (New York: tomorrow)");
    ok(freeQuotaText("free_share", utcDayBounds(syd).resetsAt, "Australia/Sydney", syd).includes("It's back at 11:00,"), "… Sydney in the morning: at 11:00");
  }

  // ── P5. neurons ──
  {
    const P = NEURON_PRICES;
    eq([neuronsOf(P, GLM, { input_tokens: 1e6 }), neuronsOf(P, GLM, { cache_read_input_tokens: 1e6 }), neuronsOf(P, GLM, { output_tokens: 1e6 })], [5500, 5500, 36400], "neuronsOf: 1M glm input = 5,500 (cached tokens at the input rate), output 36,400");
    eq(neuronsOf(P, "@cf/unknown/model", { output_tokens: 1e6 }), 290909, "… a model with no price: the dearest rate");
    eq(estimateNeurons(P, GLM, 3e6, 1000), 5500 + 36.4, "estimateNeurons: bytes / 3 as input tokens + the output allowance");
  }

  // ── P6. toOpenAiMessages ──
  {
    const m = toOpenAiMessages("SYS", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "tool_use", id: "toolu_1", name: "whoami", input: { b: 1, a: [2] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }, { type: "text", text: "<app_context>x</app_context>" }] },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ]);
    eq(m.map((x: any) => x.role), ["system", "user", "assistant", "tool", "user", "assistant"], "toOpenAiMessages: system first, the tool message before the user's <app_context>");
    eq(m[2], { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "whoami", arguments: '{"b":1,"a":[2]}' } }] }, "… tool_use → tool_calls with the exact argument JSON; empty text → content null; thinking dropped");
    eq([m[3].tool_call_id, m[3].content, m[4].content], ["toolu_1", "Error: boom", "<app_context>x</app_context>"], "… an is_error result → 'Error: …'");
  }

  // ── P7. toOpenAiTools / toOpenAiRequest ──
  {
    const params = { model: GLM, max_tokens: 500, betas: ["x"], output_config: { effort: "low" }, thinking: { type: "adaptive" }, system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "whoami", description: "Who", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] };
    const req: any = toOpenAiRequest(params, { flavor: "cloudflare", stream: true, extras: compatExtras(GLM, false) });
    eq([req.max_completion_tokens, req.stream, req.stream_options, req.tool_choice, req.chat_template_kwargs], [500, true, { include_usage: true }, "auto", { enable_thinking: false }], "toOpenAiRequest: max_completion_tokens, include_usage, tool_choice auto, glm thinking off");
    ok(!/cache_control|betas|output_config|"thinking"|max_tokens"/.test(JSON.stringify(req)), "… no cache_control / betas / output_config / thinking / max_tokens");
    eq(req.tools, [{ type: "function", function: { name: "whoami", description: "Who", parameters: { type: "object", properties: {} }, strict: false } }], "toOpenAiTools: functions, strict false");
    const bare: any = toOpenAiRequest({ ...params, tools: [] }, { flavor: "cloudflare", stream: false, extras: compatExtras("@cf/openai/gpt-oss-120b", false) });
    eq(["tools" in bare, "tool_choice" in bare, "stream_options" in bare, bare.reasoning_effort], [false, false, false, "low"], "… tool_choice only with tools; gpt-oss reasoning_effort low");
    eq(compatExtras(GLM, true).chat_template_kwargs.enable_thinking, true, "compatExtras: free_quota.thinking turns thinking on");
  }

  // ── P8. the stream parser, fixture by fixture ──
  {
    const run = async (name: string, size = 7, after: (() => Response)[] = []) => {
      serve([sse(name, size), ...after]);
      const evts: any[] = [];
      let out: any = null, err: any = null;
      try {
        out = await openAiCompatTurn({ url: "https://cf.test/v1", headers: {}, flavor: "cloudflare", model: GLM, prices: NEURON_PRICES, onEvent: (e) => evts.push(e),
          req: { model: GLM, messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } } });
      } catch (e) { err = e; }
      return { out, err, evts, raw: out ? Object.fromEntries(out.rawInputs) : null };
    };
    const u = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    let x = await run("cf-text");
    eq([x.out.content, x.out.stop_reason, x.out.usage, x.out.neurons, x.evts.filter((e) => e.type === "text").map((e) => e.text).join("")], [[{ type: "text", text: "Hello there" }], "end_turn", u(120, 4), round6((120 * 5500 + 4 * 36400) / 1e6), "Hello there"], "cf-text: text, end_turn, usage, neurons");
    x = await run("cf-tool-fragments");
    eq([x.out.content, x.out.stop_reason, x.raw], [[{ type: "tool_use", id: "call_abc", name: "whoami", input: { detail: "full" } }], "tool_use", { call_abc: '{"detail":"full"}' }], "cf-tool-fragments: the arguments joined, rawInputs kept");
    x = await run("cf-tool-one-chunk");
    eq([x.out.content, x.out.stop_reason, x.out.usage], [[{ type: "tool_use", id: "call_one", name: "whoami", input: {} }], "tool_use", u(300, 8)], "cf-tool-one-chunk: a whole call in one chunk");
    x = await run("cf-two-tools-interleaved");
    eq(x.out.content, [{ type: "tool_use", id: "call_a", name: "whoami", input: {} }, { type: "tool_use", id: "call_b", name: "lookup", input: { q: "pipes" } }], "cf-two-tools-interleaved: two calls by index");
    x = await run("cf-finish-on-usage");
    eq([x.out.content.map((b: any) => b.type), x.out.stop_reason, x.out.usage], [["text", "tool_use"], "tool_use", u(250, 9)], "cf-finish-on-usage: finish_reason on the usage chunk");
    x = await run("cf-wrapped-result");
    eq([x.out.content, x.out.stop_reason, x.out.usage], [[{ type: "text", text: "Wrapped answer" }], "end_turn", u(90, 3)], "cf-wrapped-result: frames inside { result }");
    x = await run("cf-legacy-response");
    eq([x.out.content, x.out.stop_reason, x.out.usage], [[{ type: "text", text: "Let me check" }, { type: "tool_use", id: "call_0_0", name: "whoami", input: {} }], "tool_use", u(80, 6)], "cf-legacy-response: { response, tool_calls }, a made-up id");
    x = await run("cf-reasoning");
    eq([x.out.content, x.evts.filter((e) => e.type === "thinking").length, JSON.stringify(x.evts).includes("greeting")], [[{ type: "text", text: "Hi!" }], 1, false], "cf-reasoning: reasoning is never text");
    x = await run("cf-crlf-split", 1);
    eq([x.out.content, x.out.usage], [[{ type: "text", text: "Line one, line two" }], u(60, 5)], "cf-crlf-split: \\r\\n endings, one byte per read");
    x = await run("cf-error-3036-midstream");
    eq([x.err && x.err.code, fetches.length, x.err && x.err.partialUsage.output_tokens > 0], ["free_quota", 1, true], "cf-error-3036-midstream: free_quota with what was streamed");
    x = await run("cf-garbage", 7, [nonstream]);
    eq([x.evts.filter((e) => e.type === "reset").length, x.out.content, x.out.usage, fetches.length, fetches[1].body.stream, "stream_options" in fetches[1].body], [1, [{ type: "text", text: "Hallo again" }], u(110, 4), 2, false, false], "cf-garbage: reset, then the same call not streamed");
    ok(x.out.neurons > neuronsOf(NEURON_PRICES, GLM, x.out.usage), "… what the broken stream read is counted too");
    x = await run("cf-no-usage");
    eq([x.out.usage_estimated, x.out.usage.output_tokens, x.out.usage.input_tokens > 0], [true, Math.ceil("No usage here".length / 3), true], "cf-no-usage: estimated and flagged");
    x = await run("cf-bad-args");
    eq([x.out.content, x.raw], [[{ type: "tool_use", id: "call_bad", name: "whoami", input: {} }], { call_bad: '{"detail": ' }], "cf-bad-args: input {} with the raw text kept");
    for (const f of CF_FIXTURES.filter((f) => f.name.startsWith("cf-rec-"))) {
      x = await run(f.name);
      ok(!x.err && ["end_turn", "tool_use", "max_tokens"].includes(x.out.stop_reason), `${f.name}: a recorded stream parses`);
    }
  }

  // ── P9. HTTP errors ──
  {
    const fail = async (replies: (() => Response)[]) => {
      serve(replies);
      try { await openAiCompatTurn({ url: "https://cf.test/v1", headers: {}, flavor: "cloudflare", model: GLM, onEvent: () => {}, req: { model: GLM, messages: [], stream: true } }); return ["no error", fetches.length]; } catch (e: any) { return [e.code, fetches.length]; }
    };
    const cf = (status: number, code: number) => () => jsonRes(status, { success: false, errors: [{ code, message: "Cloudflare words" }] });
    eq(await fail([cf(429, 3036)]), ["free_quota", 1], "429 + 3036 → free_quota, no retry");
    eq(await fail([cf(429, 3040)]), ["provider_busy", 3], "3040 → retried twice, then provider_busy");
    eq(await fail([cf(400, 5035)]), ["model_needs_paid", 1], "5035 → model_needs_paid");
    eq(await fail([() => jsonRes(401, { errors: [] })]), ["provider_auth", 1], "401 → provider_auth");
    eq(await fail([cf(400, 5007)]), ["model_not_found", 1], "400 + 5007 → model_not_found");
    eq(await fail([() => jsonRes(413, {})]), ["provider_bad_request", 1], "413 → provider_bad_request");
    eq(await fail([() => { throw new TypeError("fetch failed"); }]), ["provider_unreachable", 3], "fetch throws → provider_unreachable after the retries");
    eq(await fail([cf(503, 3040), sse("cf-text")]), ["no error", 2], "a busy answer then a good one: the retry answers");
  }

  // ── P10. a free turn end to end ──
  cfOn();
  {
    const db = world({ provider: "auto" });
    serve([sse("cf-text")]);
    const r = await chat(db, { text: "hi" });
    const u = db.T.ai_usage[0], st = evs(r, "start")[0];
    eq([u.key_source, u.provider, u.cost_usd, u.neurons > 0, u.status, u.model], ["free", "cloudflare", 0, true, "ok", GLM], "a free turn: the usage row (free, cloudflare, cost 0, neurons)");
    eq([st.provider, st.key_source, st.model], ["cloudflare", "free", GLM], "… the start event");
    eq([fetches[0].url, fetches[0].headers.Authorization], [CF_BASE + CF_ACC + "/ai/v1/chat/completions", "Bearer " + CF_TOKEN], "… the request: /ai/v1/chat/completions with the Bearer token");
    eq([done(r).stop, done(r).limits.key_source, typeof done(r).limits.free.left_pct, done(r).limits.free.resets_at], ["ok", "free", "number", "2026-10-16T00:00:00.000Z"], "… done.limits.free");
    eq([db.T.ai_conversations[0].provider, db.T.ai_conversations[0].model], ["cloudflare", GLM], "… the conversation is a free one");
    const s = await manage(db, { step: "status" });
    eq([s.body.source.key_source, s.body.free.configured, s.body.free.daily_neurons, s.body.test_mode, s.body.paid.switched_on], ["free", true, 10000, null, false], "status: who answers, the free quota (owners see the numbers)");
    const sm = await manage(db, { step: "status" }, "jwt-manager");
    eq(["daily_neurons" in sm.body.free, "paid" in sm.body], [false, false], "… a manager sees no quota numbers or paid details");
    // a tool step: the bad arguments come back as an is_error tool message in the next request
    serve([sse("cf-bad-args"), sse("cf-text")]);
    const r2 = await chat(db, { text: "who am i" });
    const toolMsg = fetches[1].body.messages.find((m: any) => m.role === "tool");
    eq([done(r2).stop, toolMsg.tool_call_id, toolMsg.content.startsWith("Error: ")], ["ok", "call_bad", true], "bad arguments → an is_error result in the next request");
    keep(db, r, r2, s, sm);
  }

  // ── P11. the free quota refused before the stream ──
  {
    let db = world({ provider: "auto" }, { ai_usage: [freeRow("other-biz", 9900)] });
    serve([sse("cf-text")]);
    let r = await chat(db, { text: "hi" });
    eq([r.status, r.body.code, r.body.resets_at, fetches.length, db.T.ai_usage.length], [429, "free_quota", "2026-10-16T00:00:00.000Z", 0, 1], "another business used the account's quota → 429 free_quota, no call");
    eq(r.body.reason, "Today's free AI quota is used up. It's back at 20:00, or an owner can switch on a paid AI in Settings → AI.", "… the D7 sentence (New York, noon: the reset is at 20:00 today)");
    db = world({ provider: "auto", free_quota: { share_pct: 50 } }, { ai_usage: [freeRow("default", 5000)] });
    r = await chat(db, { text: "hi" });
    eq([r.status, r.body.code, fetches.length], [429, "free_share", 0], "this business used its 50% share → 429 free_share");
    db = world({ provider: "auto", free_quota: { share_pct: 50 } }, { ai_usage: [freeRow("other-biz", 5000)] });
    r = await chat(db, { text: "hi" });
    eq([r.status, done(r).stop], [200, "ok"], "… another business's use doesn't count toward this share");
    keep(db, r);
  }

  // ── P12. Cloudflare says the quota is used up (3036) at step 1 ──
  {
    const db = world({ provider: "auto" });
    serve([sse("cf-error-3036-midstream")]);
    const r = await chat(db, { text: "hi" });
    const u = db.T.ai_usage[0];
    eq([evs(r, "notice").map((n: any) => n.code), evs(r, "error").length, done(r).stop, u.status, u.error_code], [["free_quota"], 0, "free_quota", "free_quota", "free_quota"], "3036: a notice, not an error; usage status free_quota");
    const r2 = await chat(db, { text: "again" });
    eq([r2.status, r2.body.code, fetches.length], [429, "free_quota", 1], "… the next turn is refused before any call");
    NOW = T0 + 9 * 3600e3;   // 01:00 UTC on 16 Oct, 21:00 on 15 Oct in New York
    serve([sse("cf-text")]);
    const r3 = await chat(db, { text: "after midnight UTC" });
    eq([r3.status, done(r3).stop, done(r3).limits.today_used], [200, "ok", 2], "… after 00:00 UTC it answers again (the business day's count goes on)");
    ok(!logged.join("\n").includes("Capacity temporarily exceeded"), "… Cloudflare's words are never logged");
    keep(db, r, r2, r3);
  }

  // ── P13. the free AI's smaller conversation limit ──
  {
    const db = world({ provider: "auto" });
    serve([sse("cf-text")]);
    const r = await chat(db, { text: "hi" });
    db.T.ai_conversations[0].last_prompt_tokens = 16001;
    const r2 = await chat(db, { text: "more", conversation_id: convOf(r) });
    eq([r2.status, r2.body.code, fetches.length], [400, "conversation_full", 1], "a free chat over 16,000 prompt tokens → conversation_full");
  }

  // ── P14. the cap counts paid spend only ──
  {
    let db: any = world({ provider: "auto", monthly_cap_usd: 0 });
    serve([sse("cf-text")]);
    eq(done(await chat(db, { text: "hi" })).stop, "ok", "cap 0: the free AI answers");
    const at = new Date(T0 - 3600e3).toISOString();
    const seed = ["own_user", "free", "mock"].map((k) => ({ id: "s-" + k, business_id: "default", user_id: "u-manager", key_source: k, cost_usd: 5, neurons: 0, at, status: "ok" }));
    db = paidWorld({ monthly_cap_usd: 1 }, { ai_usage: seed });
    const r = await chat(db, { text: "hi" });
    eq([r.status, evs(r, "start")[0].key_source, db.fc.calls.length], [200, "platform_paid", 1], "own-key, free and test costs don't count toward the cap");
    const s = await manage(db, { step: "status" });
    ok(s.body.month.spend_usd > 0 && s.body.month.spend_usd < 0.01 && s.body.paid.available, "… status: the paid spend is this turn's only");
    unpaid();
    db = world({ provider: "anthropic", monthly_cap_usd: 0 });
    eq(await maybeAlert80(db, normSettings(db.T.ai_settings[0]), { companyName: "", catalog: CATALOG, tz: TZ }, "2026-10", 100), false, "no 80% alert with cap 0");
    eq(db.ctl.rpcs.includes("ai_claim_alert_80"), false, "… and no claim");
  }

  // ── P15. a chat that moves from the paid AI to the free AI ──
  {
    const thinking = { events: [{ type: "message_start" }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Paid" } }],
      final: { content: [{ type: "thinking", thinking: "PAID-THOUGHT", signature: "sig-1" }, { type: "text", text: "Paid" }], stop_reason: "end_turn", stop_details: null, model: "claude-haiku-5-5", usage: { input_tokens: 100, output_tokens: 5 } } };
    const db = paidWorld({}, {}, [thinking]);
    const r = await chat(db, { text: "hi" });
    eq([evs(r, "start")[0].key_source, JSON.stringify(db.T.ai_messages).includes("PAID-THOUGHT")], ["platform_paid", true], "turn 1: the paid AI (its thinking stored)");
    db.T.ai_settings[0].provider = "auto";   // the owner switches the paid AI off
    serve([sse("cf-text")]);
    const r2 = await chat(db, { text: "and now?", conversation_id: convOf(r) });
    const c = db.T.ai_conversations[0];
    eq([evs(r2, "start")[0].key_source, evs(r2, "start")[0].model, JSON.stringify(fetches[0].body.messages).includes("PAID-THOUGHT")], ["free", GLM, false], "turn 2: the free AI, without the other model's thinking");
    eq([c.provider, c.model, c.prefix_hash], ["cloudflare", GLM, PREFIX_MIXED], "… the conversation moves to the free model (prefix mixed)");
    unpaid();
    keep(db, r, r2);
  }
  cfOff();

  // ── P16. no secrets anywhere ──
  {
    const all = seen.join("\n") + "\n" + logged.join("\n");
    ok(!all.includes(CF_TOKEN) && !all.includes(CF_ACC), "the Cloudflare token and account id never reach SSE, JSON answers, stored rows or logs");
  }

  // ── P17. a proposal can be confirmed for 7 days ──
  {
    eq(PROPOSAL_TTL_MS, 7 * 24 * 3600e3, "PROPOSAL_TTL_MS is 7 days");
    const row = { id: "c-ttl", user_id: "u-owner", kind: "lead_note", status: "proposed", created_at: new Date(T0).toISOString(), summary: "x", before: null, after: null, target: {} };
    const me = appProfile(OWNER);
    eq(changeOut(row, me).expires_at, new Date(T0 + 7 * 24 * 3600e3).toISOString(), "changeOut: expires_at 7 days on");
    NOW = T0 + 6 * 24 * 3600e3;
    eq(changeOut(row, me).can_confirm, true, "… day 6: can be confirmed");
    eq(changesContextLines([row], NOW)[1].includes("waiting for the person to press Confirm"), true, "… and the context says it is waiting");
    NOW = T0 + 8 * 24 * 3600e3;
    eq(changeOut(row, me).can_confirm, false, "… day 8: expired");
    eq(changesContextLines([row], NOW)[1].includes("expired, never confirmed"), true, "… and the context says so");
    NOW = T0;
  }
  io.sleep = sleep0;
});
