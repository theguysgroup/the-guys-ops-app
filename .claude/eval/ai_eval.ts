// The free-model eval (stage 6 v2 G7), appended to the ai-gateway's index.ts by run_ai_eval.sh (which also defines
// EVAL_CASES and EVAL_PATHS). Production code paths only: it builds exactly the request the gateway sends and parses
// the answer with the gateway's own stream parser. It never prints or stores the account id or the token.
// deno-lint-ignore-file no-explicit-any

const EV_PROC: any = (globalThis as any).process;
const EV_ARGS: string[] = EV_PROC.argv.slice(2);
const evFlag = (name: string) => { const i = EV_ARGS.indexOf("--" + name); return i < 0 ? null : (EV_ARGS[i + 1] ?? ""); };
const evHas = (name: string) => EV_ARGS.includes("--" + name);
const EV_CANDIDATES = ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3.8-27b"];
const EV_NOW = Date.UTC(2026, 9, 14, 0, 0);          // Thursday 15 Oct 2026 11:00 in Sydney
const EV_OUT_TOKENS = 300;                            // what a typical answer costs: used for the estimate and the pre-call budget check
const EV_MAX_STEPS = 3;
const evSlug = (s: string) => s.replace(/^@cf\//, "").replace(/[^a-z0-9.]+/gi, "-").toLowerCase();
const evP50 = (xs: number[]) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const evAvg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const evPct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 100);
const evHeRatio = (t: string) => { const letters = (t.match(/\p{L}/gu) || []).length; return letters ? (t.match(/[֐-׿]/g) || []).length / letters : 0; };
const evLangOk = (lang: string, t: string) => (lang === "he" ? evHeRatio(t) > 0.3 : evHeRatio(t) < 0.1 && t.trim().length > 0);

async function evMain() {
  const dry = evHas("dry");
  const models = (evFlag("models") || "").split(",").filter(Boolean);
  const useModels = models.length ? models : EV_CANDIDATES;
  const only = (evFlag("cases") || "").split(",").filter(Boolean);
  const cases = EVAL_CASES.cases.filter((c: any) => !only.length || only.includes(c.id));
  const streamArg = evFlag("stream") || "both", thinkArg = evFlag("thinking") || "off";
  if (!["on", "off", "both"].includes(streamArg) || !["on", "off", "both"].includes(thinkArg)) throw new Error("--stream and --thinking take on, off or both");
  const streams = streamArg === "both" ? [true, false] : [streamArg === "on"];
  const thinks = thinkArg === "both" ? [false, true] : [thinkArg === "on"];
  const maxNeurons = Number(evFlag("max-neurons") ?? 2500);
  if (!(maxNeurons > 0)) throw new Error("--max-neurons must be a positive number");
  const record = evHas("record");
  const fs: any = await import("node:fs"), os: any = await import("node:os"), path: any = await import("node:path");
  const outFile = path.resolve(evFlag("out") || path.join(EV_PROC.env.TMPDIR || os.tmpdir(), `ai-eval-${new Date().toISOString().slice(0, 10)}.json`));
  const rel = path.relative(EVAL_PATHS.root, outFile);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("--out must be outside the repo (results are not committed)");

  // the same pieces the gateway uses: a fake owner, the assistant mode's tools, the lean prompt, the turn's context
  const me = appProfile({ id: "u-eval", full_name: "Eval Owner", role: "owner", technician_name: "", permissions: {} });
  const tools = apiTools(toolsFor("assistant", me));
  const mode = MODES["assistant"];
  const biz = { companyName: "Eval Cleaning Co", catalog: {}, tz: "Australia/Sydney" };
  const ctxFor = (lang: string) => mode.context({ nowMs: EV_NOW, biz, assistantName: "Assistant", me, lang });
  const toolDefs: Record<string, any> = Object.fromEntries(tools.map((t: any) => [t.name, t]));
  const prices = NEURON_PRICES;
  const resultFor = (c: any, name: string) => {
    const r = c.tool_result;
    if (typeof r === "string") return r;
    if (r && typeof r[name] === "string") return r[name];
    return TOOLS[name]?.kind === "change" ? "The change was proposed. The person sees a card with a Confirm button; nothing has changed yet." : "No data.";
  };
  const requestFor = (model: string, messages: any[], stream: boolean, thinking: boolean) => {
    const { params } = buildRequest({ model, maxTokens: AI_DEFAULTS.max_tokens, effort: mode.effort, system: mode.systemPrompt, tools, messages });
    return toOpenAiRequest(params, { flavor: "cloudflare", stream, extras: compatExtras(model, thinking) });
  };
  const userMsgs = (c: any) => [{ role: "user", content: [{ type: "text", text: c.text }] }, { role: "system", content: ctxFor(c.lang) }];
  const estimate = (model: string, req: any) => estimateNeurons(prices, model, utf8Len(JSON.stringify(req)), EV_OUT_TOKENS);

  console.log(`ai eval: ${useModels.length} model(s) x ${cases.length} case(s) x stream ${streams.map((s) => (s ? "on" : "off")).join("+")} x thinking ${thinks.map((s) => (s ? "on" : "off")).join("+")}; budget ${maxNeurons} neurons${dry ? " (dry run: no network)" : ""}`);
  console.log(`tools sent: ${tools.map((t: any) => t.name).join(", ")}`);

  if (dry) {
    let total = 0;
    for (const model of useModels) for (const stream of streams) for (const thinking of thinks) {
      let n = 0, bytes = 0;
      for (const c of cases) {
        const req = requestFor(model, userMsgs(c), stream, thinking);
        n += estimate(model, req); bytes += utf8Len(JSON.stringify(req));
        if (c.tool_result) {   // the second call carries the result
          const req2 = requestFor(model, [...userMsgs(c), { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: c.expect.tool || (c.expect.tools || [])[0] || "whoami", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: resultFor(c, c.expect.tool || "") }] }], stream, thinking);
          n += estimate(model, req2);
        }
      }
      total += n;
      console.log(`  ${evSlug(model)} stream=${stream ? "on" : "off"} thinking=${thinking ? "on" : "off"}: ${cases.length} cases, request ~${Math.round(bytes / cases.length)} bytes, about ${Math.round(n)} neurons`);
    }
    console.log(`estimate for the whole plan: about ${Math.round(total)} neurons (the free quota is 10,000 a day for the account; --max-neurons ${maxNeurons} stops a real run before it passes that)`);
    console.log("dry run done: nothing was sent.");
    return;
  }

  // recording the bodies: wrap the gateway's fetch so the SAME response the parser reads is also read here (a clone)
  let lastShape = "none", lastBody: Promise<string> | null = null;
  const realFetch = io.fetch;
  io.fetch = async (url: string, init: RequestInit) => {
    const res = await realFetch(url, init);
    const isJson = /json/i.test(res.headers.get("content-type") || "");
    const copy = res.clone();
    lastBody = copy.text().then((t) => {
      if (isJson) lastShape = "none";
      else { const n = (t.match(/^data:\s*\{/gm) || []).length; lastShape = (t.match(/"(content|tool_calls|reasoning_content)":/g) || []).length > 3 ? "fragmented" : n > 0 ? "one-chunk" : "none"; }
      return t;
    }).catch(() => "");
    return res;
  };

  const url = CF_BASE + cfAccount() + "/ai/v1/chat/completions", headers = { Authorization: "Bearer " + cfToken() };
  let spent = 0, stopped = false;
  const results: any[] = [];
  for (const model of useModels) for (const stream of streams) for (const thinking of thinks) {
    const v: any = { model, stream, thinking, cases: [], calls: 0, latencies: [] as number[], inTok: [] as number[], outTok: [] as number[], neurons: 0, shapes: {} as Record<string, number>, fallbacks: 0, errors: 0 };
    for (const c of cases) {
      const messages: any[] = userMsgs(c);
      const called: string[] = [], inputs: any[] = [];
      let finalText = "", firstText = "", firstCalls: string[] = [], err: string | null = null;
      for (let step = 1; step <= EV_MAX_STEPS; step++) {
        const req = requestFor(model, messages, stream, thinking);
        if (spent + estimate(model, req) > maxNeurons) { stopped = true; err = "budget"; break; }
        let resets = 0, text = "";
        const t0 = Date.now();
        lastShape = "none"; lastBody = null;
        try {
          const out: any = await openAiCompatTurn({ url, headers, req, flavor: "cloudflare", model, prices, signal: null, onEvent: (ev: any) => { if (ev.type === "reset") resets++; } });
          const dt = Date.now() - t0;
          spent += out.neurons || 0; v.neurons += out.neurons || 0; v.calls++; v.latencies.push(dt);
          v.inTok.push(out.usage.input_tokens + out.usage.cache_read_input_tokens); v.outTok.push(out.usage.output_tokens);
          const body = lastBody ? await lastBody : "";
          const shape = stream ? lastShape : "none"; v.shapes[shape] = (v.shapes[shape] || 0) + 1;
          v.fallbacks += resets;
          if (record && body) {
            const f = path.join(EVAL_PATHS.fixtures, `cf-rec-${evSlug(model)}-${c.id}-${stream ? "stream" : "plain"}${step > 1 ? "-" + step : ""}.${stream ? "txt" : "json"}`);
            fs.writeFileSync(f, body);   // the body only: no headers, URL or account
          }
          text = out.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          const uses = out.content.filter((b: any) => b.type === "tool_use");
          if (step === 1) { firstText = text; firstCalls = uses.map((u: any) => u.name); }
          for (const u of uses) { called.push(u.name); inputs.push({ name: u.name, input: u.input, raw: out.rawInputs.get(u.id) }); }
          if (!uses.length) { finalText = text; break; }
          messages.push({ role: "assistant", content: out.content });
          messages.push({ role: "user", content: uses.map((u: any) => ({ type: "tool_result", tool_use_id: u.id, content: resultFor(c, u.name) })) });
          finalText = text;
        } catch (e: any) { err = e instanceof ProviderFailure ? e.code : "error"; v.errors++; break; }
      }
      // scoring
      const ex = c.expect;
      const need: string[] = ex.tools || (ex.tool ? [ex.tool] : []);
      const rightTool = ex.tool === null && !ex.tools ? firstCalls.length === 0 : ex.tools ? ex.tools.every((n: string) => called.includes(n)) : firstCalls.includes(ex.tool);
      const mine = inputs.filter((i) => need.includes(i.name));
      const argsValid = !need.length || (mine.length > 0 && mine.every((i) => toolDefs[i.name] && validateInput(i.input, toolDefs[i.name].input_schema).length === 0 && i.raw !== undefined && (() => { try { JSON.parse(i.raw || "{}"); return true; } catch { return false; } })()));
      const argsMatch = !ex.args || mine.some((i) => Object.entries(ex.args).every(([k, val]) => i.input[k] === val));
      const heArgs = !ex.hebrew_args || mine.some((i) => ex.hebrew_args.every((k: string) => evHeRatio(String(i.input[k] || "")) > 0.3));
      const text = finalText || firstText;
      const langOk = !!text && evLangOk(ex.lang, text) && heArgs;
      const forbidden = inputs.filter((i) => (ex.forbid_tools || []).includes(i.name)).length;
      v.cases.push({ id: c.id, lang: c.lang, rightTool: rightTool && !err, argsValid: argsValid && !err, argsMatch, langOk, forbidden, err, called });
    }
    results.push(v);
    if (stopped) break;
  }

  // report
  const rows = results.map((v) => {
    const n = v.cases.length;
    const he = v.cases.filter((x: any) => x.lang === "he");
    const needArgs = v.cases.filter((x: any) => cases.find((c: any) => c.id === x.id).expect.args || cases.find((c: any) => c.id === x.id).expect.tool);
    const r = {
      model: v.model, stream: v.stream, thinking: v.thinking, cases: n, errors: v.errors,
      right_tool_pct: evPct(v.cases.filter((x: any) => x.rightTool).length, n),
      args_valid_pct: evPct(needArgs.filter((x: any) => x.argsValid).length, needArgs.length),
      args_match_pct: evPct(v.cases.filter((x: any) => x.argsMatch).length, n),
      lang_pct: evPct(v.cases.filter((x: any) => x.langOk).length, n),
      lang_he_pct: evPct(he.filter((x: any) => x.langOk).length, he.length),
      forbidden: v.cases.reduce((a: number, x: any) => a + x.forbidden, 0),
      p50_ms: evP50(v.latencies), avg_prompt_tokens: Math.round(evAvg(v.inTok)), avg_completion_tokens: Math.round(evAvg(v.outTok)),
      neurons_per_case: n ? Math.round((10 * v.neurons) / n) / 10 : 0, shapes: v.shapes, fallbacks: v.fallbacks,
    };
    return { ...r, score: Math.round((r.right_tool_pct + r.args_valid_pct + r.lang_pct) / 3 * 10) / 10, failed_cases: v.cases.filter((x: any) => !x.rightTool || !x.langOk || x.forbidden).map((x: any) => x.id + (x.err ? "(" + x.err + ")" : "")) };
  });
  console.log("");
  for (const r of rows) console.log(`${evSlug(r.model)} stream=${r.stream ? "on" : "off"} thinking=${r.thinking ? "on" : "off"}: tool ${r.right_tool_pct}% args ${r.args_valid_pct}% (match ${r.args_match_pct}%) lang ${r.lang_pct}% (he ${r.lang_he_pct}%) forbidden ${r.forbidden} errors ${r.errors} | p50 ${r.p50_ms} ms, prompt ${r.avg_prompt_tokens} / completion ${r.avg_completion_tokens} tokens, ${r.neurons_per_case} neurons/case | stream shape ${JSON.stringify(r.shapes)}, fallbacks ${r.fallbacks}${r.failed_cases.length ? " | failed: " + r.failed_cases.join(", ") : ""}`);
  console.log(`\nspent about ${Math.round(spent)} of ${maxNeurons} neurons${stopped ? " (stopped at the budget: run the rest in another sitting)" : ""}`);

  // the pick rule
  const full = rows.filter((r) => r.cases === cases.length && r.forbidden === 0);
  const okA = full.filter((r) => r.right_tool_pct >= 90 && r.args_valid_pct >= 95 && r.lang_he_pct >= 100 && r.errors === 0);
  const asst = okA.slice().sort((a, b) => a.neurons_per_case - b.neurons_per_case)[0];
  const sql = (task: string, r: any) => `update public.ai_settings set model_per_task = model_per_task || '${JSON.stringify({ ["cloudflare:" + task]: r.model })}'::jsonb;   -- stream ${r.stream ? "on" : "off"}, thinking ${r.thinking ? "on" : "off"}`;
  console.log("\npick rule: assistant = the cheapest variant with >= 90% right tool, >= 95% valid args, 100% Hebrew language match, no forbidden calls, and no failed call (a stream fallback is fine when its retry worked); heavy = the best total score within 3x the assistant's neurons per case.");
  let heavy: any = null;
  if (!asst) console.log("no variant passes for the assistant: keep the default model, or run more variants (--models, --thinking both).");
  else {
    heavy = full.filter((r) => r.neurons_per_case <= 3 * asst.neurons_per_case).sort((a, b) => b.score - a.score || a.neurons_per_case - b.neurons_per_case)[0];
    console.log("\nrun on STAGING:");
    console.log(sql("assistant", asst));
    console.log(sql("heavy", heavy));
    console.log("(free_quota.thinking / free_quota.stream follow the picked variant; they are settings too)");
  }
  fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), max_neurons: maxNeurons, spent: Math.round(spent), stopped, rows, cases: results.map((v) => ({ model: v.model, stream: v.stream, thinking: v.thinking, cases: v.cases })), pick: { assistant: asst?.model || null, heavy: heavy?.model || null } }, null, 2));
  console.log(`results: ${outFile}`);
}
evMain().catch((e: any) => { console.error("ai eval failed:", e instanceof ProviderFailure ? e.code : String(e && e.message || e).replace(/[0-9a-f]{32}/gi, "<id>")); EV_PROC.exit(1); });
