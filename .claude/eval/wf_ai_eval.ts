// The Workflow AI eval (stage 7 D, spec §6), appended to the ai-gateway's index.ts by run_wf_ai_eval.sh (which also defines
// AUTO = the automations function's own code, EVAL_CASES, EVAL_WORKFLOWS and EVAL_PATHS). Production pieces only: the mode's
// prompt (with the generated catalog), the four tools, the request builder and the stream parser are the gateway's own. The
// automations function is called IN PROCESS (AUTO.apiStep, the real registry / validate / patch checks) on a fake database that
// holds one business catalog and, for an edit case, the stored workflow: no network, no real database, and a write step
// (save, publish, test) throws. Nothing is sent to a customer and nothing is saved: a proposal is only recorded.
// It never prints or stores the account id or the token.
// deno-lint-ignore-file no-explicit-any

const EV_PROC: any = (globalThis as any).process;
const EV_ARGS: string[] = EV_PROC.argv.slice(2);
const evFlag = (name: string) => { const i = EV_ARGS.indexOf("--" + name); return i < 0 ? null : (EV_ARGS[i + 1] ?? ""); };
const evHas = (name: string) => EV_ARGS.includes("--" + name);
const EV_NOW = Date.UTC(2026, 9, 14, 0, 0);          // Thursday 15 Oct 2026 11:00 in Sydney (the cases' "clock")
const EV_OUT_TOKENS = 600;                            // a proposal's JSON is longer than a chat answer: used for the estimate and the pre-call budget check
const EV_MAX_STEPS = 5;                               // the gateway's tool steps per turn
const EV_BAR = { passed: 24, of: 30 };                // spec §6 pass bar on the free model
const evSlug = (s: string) => s.replace(/^@cf\//, "").replace(/[^a-z0-9.]+/gi, "-").toLowerCase();
const evP50 = (xs: number[]) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const evAvg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const evPct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 100);
const evHeRatio = (t: string) => { const letters = (t.match(/\p{L}/gu) || []).length; return letters ? (t.match(/[֐-׿]/g) || []).length / letters : 0; };
const evLangOk = (lang: string, t: string) => (lang === "he" ? evHeRatio(t) > 0.3 : evHeRatio(t) < 0.1 && t.trim().length > 0);
const EV_READ_STEPS = ["registry", "validate", "patch"];   // the only automations steps the eval answers; anything else throws

// The business the cases run in: the lists the cases talk about (stages, tags, a template). One catalog for every case.
const EV_CATALOG: any = {
  stages: [["new", "New"], ["contacted", "Contacted"], ["quoted", "Quoted"], ["booked", "Booked"], ["paid", "Paid"], ["lost", "Lost"]].map(([key, label]) => ({ key, label })),
  services: [["split", "Split system"], ["ducted", "Ducted"], ["commercial", "Commercial"]].map(([key, label]) => ({ key, label })),
  sources: [["website", "Website"], ["phone", "Phone"], ["referral", "Referral"]].map(([key, label]) => ({ key, label })),
  tags: ["vip", "booked", "followed-up", "quote-sent", "lost"].map((tag) => ({ tag })),
  templates: { welcome: "Hi {first_name}, welcome." },
};
const EV_PEOPLE = [{ id: "u-eval", full_name: "Eval Owner", role: "owner" }, { id: "u-eval-office", full_name: "Maria Office", role: "va" }];
const EV_STORED_ID = "70000000-0000-4000-8000-0000000000e1";
const EV_PERSON = { id: "u-eval", full_name: "Eval Owner", role: "owner" };

// ── the fake database the automations function's reads need (settings, profiles, automations, automation_runs) ──
function evFrom(tables: Record<string, any[]>, table: string) {
  const eq: Record<string, any> = {}, q: any = {};
  for (const m of ["select", "neq", "in", "is", "not", "order", "limit", "range", "gte", "lte", "like", "ilike"]) q[m] = () => q;
  q.eq = (k: string, v: any) => { eq[k] = v; return q; };
  q.maybeSingle = async () => ({ data: (tables[table] || []).find((r) => !("id" in eq) || r.id === eq.id) || null, error: null });
  q.single = q.maybeSingle;
  q.then = (res: any, rej: any) => Promise.resolve({ data: tables[table] || [], error: null, count: (table === "automation_runs" ? 0 : (tables[table] || []).length) }).then(res, rej);
  return q;
}
let EV_LAST_PATCH: any = null;   // the last patch that passed with no errors: the document an edit proposal would save
function evWorld(c: any) {
  const av: any = { phone: false, xero: false, gbp: false, reviews: false, ...(EVAL_CASES.defaults && EVAL_CASES.defaults.avail ? EVAL_CASES.defaults.avail : {}), ...(c.avail || {}) };
  const catalog = { ...EV_CATALOG, connectors: { xero: { connected: !!av.xero }, gbp: { connected: !!av.gbp } } };
  const tables: Record<string, any[]> = {
    settings: [{ catalog, phone_enabled: !!av.phone, review_requests_enabled: !!av.reviews }], profiles: EV_PEOPLE.slice(), automation_runs: [], automations: [],
  };
  let stored: any = null;
  if (c.mode === "workflow_edit") {
    const fx = EVAL_WORKFLOWS.cases.find((x: any) => x.name === c.workflow);
    if (!fx) throw new Error("the eval's fixture workflow is missing: " + c.workflow);
    stored = { id: EV_STORED_ID, business_id: AUTO.BUSINESS_ID, name: "Quote follow-up", enabled: false, revision: 3, builder: fx.builder || "standard", definition: JSON.parse(JSON.stringify(fx.doc)), settings: {}, deleted_at: null, updated_by_name: null, updated_at: null };
    tables.automations = [stored];
  }
  const sb = { from: (t: string) => evFrom(tables, t), rpc: async () => ({ data: null, error: null }) };
  return { sb, stored, catalog };
}
let EV_WORLD: any = null;
io.automations = async (_userSb: any, body: any) => {
  if (!body || !EV_READ_STEPS.includes(body.step)) throw new Error("the eval answers only registry, validate and patch (got " + (body && body.step) + ")");
  const r: any = await AUTO.apiStep(EV_WORLD.sb, body.step, body, EV_PERSON, EV_NOW);
  if (body.step === "patch" && r.status === 200 && r.body && r.body.ok === true && !(r.body.errors || []).length && r.body.definition) EV_LAST_PATCH = r.body.definition;
  return { status: r.status, body: r.body };
};
io.now = () => EV_NOW;

// ── the pieces of one turn, as the gateway builds them ──
const evMe = appProfile({ id: "u-eval", full_name: "Eval Owner", role: "owner", technician_name: "", permissions: {} });
const evBiz = { companyName: "Eval Cleaning Co", catalog: EV_CATALOG, tz: "Australia/Sydney", gstRate: 10 };
const evCtxIn = (c: any) => (c.mode === "workflow_edit" ? { page: "settings", workflowId: EV_STORED_ID } : { page: "settings" });
const evTools = (modeId: string) => toolsFor(modeId, evMe);
function evRequest(c: any, model: string, messages: any[], stream: boolean, thinking: boolean) {
  const mode = MODES[c.mode], tools = apiTools(evTools(c.mode));
  const { params } = buildRequest({ model, maxTokens: AI_DEFAULTS.max_tokens, effort: mode.effort, system: mode.systemPrompt, tools, messages });
  return toOpenAiRequest(params, { flavor: "cloudflare", stream, extras: compatExtras(model, thinking) });
}
const evUserMsgs = (c: any) => [
  { role: "user", content: [{ type: "text", text: c.text }] },
  { role: "system", content: MODES[c.mode].context({ nowMs: EV_NOW, biz: evBiz, assistantName: "Assistant", me: evMe, lang: c.lang, context: evCtxIn(c) }) },
];
// One turn's tool context. propose = the gateway's own proposeChange on a fake ai_changes table: it records, never saves.
function evTurn(c: any) {
  const recs: any[] = [], cards: any[] = [];
  const sb = { from: (t: string) => { if (t !== "ai_changes") throw new Error("the eval's database has no table " + t); return { insert: (row: any) => ({ select: () => ({ single: async () => { const data = { id: "eval-change-" + (recs.length + 1), created_at: new Date(EV_NOW).toISOString(), ...row }; recs.push({ row, doc: row.kind === "wf_edit" ? EV_LAST_PATCH : (row.after && row.after.definition) || null }); return { data, error: null }; } }) }) }; } };
  const turn: any = { proposals: 0, context: evCtxIn(c) };
  const ctx: any = {
    me: evMe, biz: evBiz, settings: {}, userSb: { __eval: true }, sb, conversationId: "eval", mode: MODES[c.mode], step: 1, nowMs: EV_NOW,
    emit: () => {}, card: (kind: string, data: any) => { cards.push({ kind, data }); }, stepMeta: { proposals: [], cards: [], tools: [] }, turn, resultChars: FREE_TOOL_RESULT_CHARS,
  };
  ctx.propose = (p: any) => proposeChange(ctx, p);
  return { ctx, recs, cards };
}
// One tool call, as runTools runs it (parse, validate the input, role, run, the result-size cap).
async function evRunTool(T: any, tools: any[], use: { id: string; name: string; input: any }, raw: string | undefined) {
  const tool = matchTool(use.name, tools);
  if (!tool) return { content: `Unknown tool ${use.name}. Available: ${tools.map((x: any) => x.name).join(", ") || "none"}`, isError: true, known: false };
  const parsed = parseToolInput(raw, use.input);
  if (!parsed.ok) return { content: JSON.stringify({ INVALID_JSON: parsed.raw }), isError: true, known: true };
  const problems = validateInput(parsed.value, tool.input_schema);
  if (problems.length) return { content: "Invalid input: " + problems.join("; "), isError: true, known: true };
  if (!allowedFor(tool, evMe)) return { content: "Not allowed for your role", isError: true, known: true };
  try {
    const out = JSON.stringify((await tool.run(parsed.value, T.ctx)) ?? null);
    return out.length > FREE_TOOL_RESULT_CHARS ? { content: "Result too large", isError: true, known: true } : { content: out, isError: false, known: true };
  } catch (e: any) {
    return { content: "The tool failed: " + (e instanceof ChangeRefused ? e.message : "something went wrong on the server."), isError: true, known: true };
  }
}

// ── scoring helpers (pure) ──
function evTypesOf(doc: any): Set<string> {
  const out = new Set<string>(), d = doc && typeof doc === "object" ? doc : {};
  for (const t of Array.isArray(d.triggers) ? d.triggers : []) if (t && t.type) { out.add("trigger:" + t.type); out.add(String(t.type)); }
  for (const n of Object.values(d.nodes && typeof d.nodes === "object" ? d.nodes : {}) as any[]) if (n && n.type) out.add(String(n.type));
  return out;
}
function evScore(c: any, run: { called: string[]; props: any[]; text: string; propose: { ok: boolean }[]; unknownTools: string[]; unavailable: number }) {
  const ex = c.expect, props = run.props, checks: Record<string, boolean> = {};
  const outcomes: string[] = Array.isArray(ex.outcome) ? ex.outcome : [ex.outcome];
  checks.outcome = outcomes.some((o) => (o === "proposal" ? props.length > 0 : props.length === 0 && run.text.trim().length > 0 && (o === "answer" || o === "refusal")));
  if ("tool" in ex) checks.tool = ex.tool === null ? run.called.length === 0 : run.called.includes(ex.tool);
  if (ex.forbid_tools) checks.forbid_tools = !run.called.some((n) => ex.forbid_tools.includes(n)) && run.unknownTools.length === 0;
  const docs = props.map((p) => p.doc).filter(Boolean), last = docs[docs.length - 1];
  if (ex.types_all) { const t = evTypesOf(last); checks.types_all = !!last && ex.types_all.every((x: string) => t.has(x)); }
  if (ex.forbid_types) { const seen = new Set<string>(); for (const d of docs) for (const t of evTypesOf(d)) seen.add(t); checks.forbid_types = !ex.forbid_types.some((x: string) => seen.has(x)); }
  if (ex.ops_any) { const names = props.flatMap((p) => (Array.isArray(p.row.after && p.row.after.ops) ? p.row.after.ops : []).map((o: any) => o && o.op)); checks.ops_any = ex.ops_any.some((o: string) => names.includes(o)); }
  if (ex.keep_ids) {
    const gone = new Set<string>(props.flatMap((p) => (Array.isArray(p.row.after && p.row.after.ops) ? p.row.after.ops : []).filter((o: any) => o && o.op === "removeNode").map((o: any) => String(o.id))));
    const kept = new Set(Object.keys((last && last.nodes) || {}));
    checks.keep_ids = !!last && Object.keys(c._storedNodes || {}).every((id) => gone.has(id) || kept.has(id));
  }
  if (ex.valid) checks.valid = props.length > 0;
  if (ex.hebrew_fields) {
    checks.hebrew_fields = !!last && ex.hebrew_fields.every((f: string) => {
      const [type, key] = f.split(".");
      return (Object.values(last.nodes || {}) as any[]).some((n) => n && n.type === type && typeof (n.config || {})[key] === "string" && evHeRatio(n.config[key]) > 0.3);
    });
  }
  if (ex.mentions_any) { const t = run.text.toLowerCase(); checks.mentions_any = ex.mentions_any.some((m: string) => t.includes(m.toLowerCase())); }
  if (ex.lang) checks.lang = !!run.text.trim() && evLangOk(ex.lang, run.text);
  const forbiddenTypes = (ex.forbid_types ? [...new Set<string>(docs.flatMap((d) => [...evTypesOf(d)]))].filter((t) => ex.forbid_types.includes(t)).length : 0) + run.unavailable;
  const forbiddenTools = run.called.filter((n) => (ex.forbid_tools || []).includes(n)).length + run.unknownTools.length;
  const firstTry = run.propose.length ? run.propose[0].ok : null;
  return { checks, pass: Object.values(checks).every(Boolean), forbiddenTypes, forbiddenTools, firstTry, repaired: firstTry === false && props.length > 0 };
}

// ── a scripted turn standing in for the model (dry runs): the tools the case needs, run on the real checks ──
async function evScripted(c: any, model: string, stream: boolean, thinking: boolean) {
  const T = evTurn(c), tools = evTools(c.mode), mode = c.mode, ex = c.expect;
  const wantsProposal = (Array.isArray(ex.outcome) ? ex.outcome : [ex.outcome]).includes("proposal") && ex.tool;
  const plan: { name: string; input: any }[] = [];
  if (ex.outcome !== "refusal") {
    plan.push({ name: "workflow_options", input: {} });
    if (mode === "workflow_edit") plan.push({ name: "read_workflow", input: {} });
  }
  const messages: any[] = evUserMsgs(c);
  const sizes: number[] = [], rounds: { name: string; input: any }[][] = [];
  if (plan.length) rounds.push(plan);
  if (wantsProposal) rounds.push([{ name: mode === "workflow_edit" ? "propose_workflow_edit" : "propose_workflow", input: mode === "workflow_edit" ? WF_MOCK_EDIT : WF_MOCK_BUILD }]);
  let proposed = 0, bad = 0, n = 0;
  for (const round of rounds) {
    sizes.push(utf8Len(JSON.stringify(evRequest(c, model, messages, stream, thinking))));
    const uses = round.map((r) => ({ type: "tool_use", id: "call_" + (++n), name: r.name, input: r.input }));
    messages.push({ role: "assistant", content: uses });
    const results: any[] = [];
    for (const u of uses) {
      const r = await evRunTool(T, tools, u, JSON.stringify(u.input));
      if (u.name.startsWith("propose_")) { try { if (JSON.parse(r.content).proposed === true) proposed++; else bad++; } catch { bad++; } } else if (r.isError) bad++;
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.content });
    }
    messages.push({ role: "user", content: results });
  }
  sizes.push(utf8Len(JSON.stringify(evRequest(c, model, messages, stream, thinking))));   // the last call: the answer
  return { sizes, proposed, bad, wantsProposal: !!wantsProposal };
}

async function evMain() {
  const dry = evHas("dry");
  const def = PROVIDER_MODEL_DEFAULTS["cloudflare:heavy"];
  const models = (evFlag("models") || "").split(",").filter(Boolean), useModels = models.length ? models : [def];
  const only = (evFlag("cases") || "").split(",").filter(Boolean);
  const cases = EVAL_CASES.cases.filter((c: any) => !only.length || only.includes(c.id));
  const streamArg = evFlag("stream") || "on", thinkArg = evFlag("thinking") || "off";
  if (!["on", "off"].includes(streamArg) || !["on", "off"].includes(thinkArg)) throw new Error("--stream and --thinking take on or off");
  const stream = streamArg === "on", thinking = thinkArg === "on";
  const maxNeurons = Number(evFlag("max-neurons") ?? NaN);
  if (!dry && !(maxNeurons > 0)) throw new Error("a real run needs --max-neurons N (the budget: it stops before a call that would pass it)");
  const fs: any = await import("node:fs"), os: any = await import("node:os"), path: any = await import("node:path");
  const outFile = path.resolve(evFlag("out") || (dry ? path.join(EVAL_PATHS.root, ".claude", "eval", "wf_ai_eval_dry.json") : path.join(EV_PROC.env.TMPDIR || os.tmpdir(), `wf-ai-eval-${new Date().toISOString().slice(0, 10)}.json`)));
  const rel = path.relative(EVAL_PATHS.root, outFile);
  if (!dry && !rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("--out must be outside the repo for a real run (the numbers go into the PR by hand)");
  for (const c of cases) if (c.mode === "workflow_edit") c._storedNodes = (EVAL_WORKFLOWS.cases.find((x: any) => x.name === c.workflow) || { doc: {} }).doc.nodes;
  const prices = NEURON_PRICES;
  const estimate = (model: string, bytes: number) => estimateNeurons(prices, model, bytes, EV_OUT_TOKENS);
  const sys = (id: string) => MODES[id].systemPrompt.length, toolChars = (id: string) => JSON.stringify(apiTools(evTools(id))).length;

  console.log(`wf ai eval: ${useModels.length} model(s) x ${cases.length} case(s), stream ${streamArg}, thinking ${thinkArg}${dry ? " (dry run: no network)" : "; budget " + maxNeurons + " neurons"}`);
  for (const id of ["workflow_build", "workflow_edit"]) console.log(`${id}: tools ${evTools(id).map((t: any) => t.name).join(", ")}; system prompt ${sys(id)} chars (limit ${WF_AI.promptMax}), tool schemas ${toolChars(id)} chars (limit ${WF_AI.toolSchemasMax})`);

  if (dry) {
    const rows: any[] = [], wiring = { proposals_accepted: 0, proposals_expected: 0, tool_errors: 0 };
    let maxTokens = 0;
    for (const model of useModels) {
      let n = 0, calls = 0, bytes = 0;
      for (const c of cases) {
        EV_WORLD = evWorld(c); EV_LAST_PATCH = null;
        const s = await evScripted(c, model, stream, thinking);
        const neurons = s.sizes.reduce((a, b) => a + estimate(model, b), 0);
        n += neurons; calls += s.sizes.length; bytes += s.sizes.reduce((a, b) => a + b, 0);
        maxTokens = Math.max(maxTokens, Math.ceil(Math.max(...s.sizes) / 3));
        if (s.wantsProposal) { wiring.proposals_expected++; wiring.proposals_accepted += s.proposed; }
        wiring.tool_errors += s.bad;
        rows.push({ model, id: c.id, mode: c.mode, lang: c.lang, calls: s.sizes.length, request_bytes: s.sizes, est_neurons: Math.round(neurons) });
      }
      console.log(`  ${evSlug(model)}: ${calls} calls for ${cases.length} cases, average request ${Math.round(bytes / calls)} bytes, about ${Math.round(n)} neurons (the free quota is 10,000 a day for the account)`);
    }
    console.log(`largest request: about ${maxTokens} prompt tokens (the free chat limit is ${FREE_DEFAULTS.max_prompt_tokens})`);
    console.log(`scripted turns on the real checks: ${wiring.proposals_accepted} of ${wiring.proposals_expected} canned proposals accepted, ${wiring.tool_errors} tool errors`);
    const ok = maxTokens <= FREE_DEFAULTS.max_prompt_tokens && wiring.tool_errors === 0 && sys("workflow_build") <= WF_AI.promptMax && sys("workflow_edit") <= WF_AI.promptMax && toolChars("workflow_build") <= WF_AI.toolSchemasMax && toolChars("workflow_edit") <= WF_AI.toolSchemasMax;
    fs.writeFileSync(outFile, JSON.stringify({ about: "wf_ai_eval.ts --dry: every request built with no network; scripted turns (the tools the case needs plus one canned proposal) run on the real checks. Estimates only: the model's own answers are not run.", dry: true, models: useModels, stream: streamArg, thinking: thinkArg, cases: cases.length, system_prompt_chars: { workflow_build: sys("workflow_build"), workflow_edit: sys("workflow_edit") }, tool_schema_chars: { workflow_build: toolChars("workflow_build"), workflow_edit: toolChars("workflow_edit") }, largest_request_prompt_tokens: maxTokens, wiring, ok, rows }, null, 2) + "\n");
    console.log(ok ? "dry run done: nothing was sent." : "dry run FAILED a size or wiring check.");
    console.log(`results: ${path.relative(EVAL_PATHS.root, outFile).replace(/\\/g, "/")}`);
    if (!ok) EV_PROC.exit(1);
    return;
  }

  // recording the stream shape is not needed here; the harness measures answers, not the wire
  const url = CF_BASE + cfAccount() + "/ai/v1/chat/completions", headers = { Authorization: "Bearer " + cfToken() };
  let spent = 0, stopped = false;
  const all: any[] = [];
  for (const model of useModels) {
    const v: any = { model, cases: [], calls: 0, latencies: [] as number[], inTok: [] as number[], outTok: [] as number[], neurons: 0, errors: 0 };
    for (const c of cases) {
      EV_WORLD = evWorld(c); EV_LAST_PATCH = null;
      const T = evTurn(c), tools = evTools(c.mode), messages: any[] = evUserMsgs(c);
      const called: string[] = [], propose: { ok: boolean }[] = [], unknown: string[] = [];
      let text = "", err: string | null = null, unavailable = 0;
      for (let step = 1; step <= EV_MAX_STEPS; step++) {
        T.ctx.step = step;
        const req = evRequest(c, model, messages, stream, thinking);
        if (spent + estimate(model, utf8Len(JSON.stringify(req))) > maxNeurons) { stopped = true; err = "budget"; break; }
        const t0 = Date.now();
        try {
          const out: any = await openAiCompatTurn({ url, headers, req, flavor: "cloudflare", model, prices, signal: null, onEvent: () => {} });
          spent += out.neurons || 0; v.neurons += out.neurons || 0; v.calls++; v.latencies.push(Date.now() - t0);
          v.inTok.push(out.usage.input_tokens + out.usage.cache_read_input_tokens); v.outTok.push(out.usage.output_tokens);
          text = out.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          const uses = out.content.filter((b: any) => b.type === "tool_use");
          if (!uses.length) break;
          messages.push({ role: "assistant", content: out.content });
          const results: any[] = [];
          for (const u of uses) {
            const r = await evRunTool(T, tools, u, out.rawInputs.get(u.id));
            if (!r.known) unknown.push(u.name); else called.push(u.name);
            if (u.name.startsWith("propose_")) { let ok = false; try { ok = JSON.parse(r.content).proposed === true; } catch { /* not JSON: a failure */ } propose.push({ ok }); }
            results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
          }
          messages.push({ role: "user", content: results });
        } catch (e: any) { err = e instanceof ProviderFailure ? e.code : "error"; v.errors++; break; }
      }
      // the last proposal's document, checked once more against the business's own registry (the gateway already refused these)
      const reg: any = await (async () => { const r = await AUTO.apiStep(EV_WORLD.sb, "registry", {}, EV_PERSON, EV_NOW); return r.body; })();
      for (const r of T.recs) if (r.doc) unavailable += forbidUnavailable(r.doc, reg).length;
      const s = evScore(c, { called, props: T.recs, text, propose, unknownTools: unknown, unavailable });
      v.cases.push({ id: c.id, lang: c.lang, mode: c.mode, ...s, err, called, text: text.slice(0, 300) });
      if (stopped) break;
    }
    all.push(v);
    if (stopped) break;
  }

  // report: honest numbers, per case failures listed
  const rows = all.map((v) => {
    const n = v.cases.length, by = (f: (x: any) => boolean) => v.cases.filter(f);
    const refusals = by((x: any) => cases.find((c: any) => c.id === x.id).expect.outcome === "refusal");
    const props = by((x: any) => x.firstTry !== null);
    return {
      model: v.model, cases: n, passed: by((x: any) => x.pass).length, errors: v.errors,
      passed_he: by((x: any) => x.lang === "he" && x.pass).length + "/" + by((x: any) => x.lang === "he").length,
      passed_en: by((x: any) => x.lang === "en" && x.pass).length + "/" + by((x: any) => x.lang === "en").length,
      passed_build: by((x: any) => x.mode === "workflow_build" && x.pass).length + "/" + by((x: any) => x.mode === "workflow_build").length,
      passed_edit: by((x: any) => x.mode === "workflow_edit" && x.pass).length + "/" + by((x: any) => x.mode === "workflow_edit").length,
      forbidden_types: v.cases.reduce((a: number, x: any) => a + x.forbiddenTypes, 0), forbidden_tools: v.cases.reduce((a: number, x: any) => a + x.forbiddenTools, 0),
      refusals_ok: refusals.filter((x: any) => x.pass).length + "/" + refusals.length,
      proposal_turns: props.length, valid_first_try_pct: evPct(props.filter((x: any) => x.firstTry === true).length, props.length), repaired_pct: evPct(props.filter((x: any) => x.repaired).length, props.length),
      p50_ms: evP50(v.latencies), avg_prompt_tokens: Math.round(evAvg(v.inTok)), avg_completion_tokens: Math.round(evAvg(v.outTok)), neurons_per_case: n ? Math.round((10 * v.neurons) / n) / 10 : 0,
      failed_cases: v.cases.filter((x: any) => !x.pass).map((x: any) => x.id + "[" + Object.entries(x.checks).filter(([, ok]) => !ok).map(([k]) => k).join(",") + "]" + (x.err ? "(" + x.err + ")" : "")),
    };
  });
  console.log("");
  for (const r of rows) {
    console.log(`${evSlug(r.model)}: passed ${r.passed}/${r.cases} (he ${r.passed_he}, en ${r.passed_en}; build ${r.passed_build}, edit ${r.passed_edit}) | forbidden types ${r.forbidden_types}, forbidden tools ${r.forbidden_tools}, refusals ${r.refusals_ok} | proposals: valid first try ${r.valid_first_try_pct}%, repaired ${r.repaired_pct}% of ${r.proposal_turns} | errors ${r.errors}, p50 ${r.p50_ms} ms, prompt ${r.avg_prompt_tokens} / completion ${r.avg_completion_tokens} tokens, ${r.neurons_per_case} neurons/case`);
    if (r.failed_cases.length) console.log("  failed: " + r.failed_cases.join(", "));
    const full = r.cases === EV_BAR.of, refusalsAll = r.refusals_ok.split("/")[0] === r.refusals_ok.split("/")[1];
    console.log(`  pass bar (>= ${EV_BAR.passed}/${EV_BAR.of}, 0 forbidden types, 0 forbidden tools, every refusal refused): ${!full ? "not judged (not the full set)" : r.passed >= EV_BAR.passed && r.forbidden_types === 0 && r.forbidden_tools === 0 && refusalsAll ? "PASSED" : "NOT MET"}`);
  }
  console.log(`\nspent about ${Math.round(spent)} of ${maxNeurons} neurons${stopped ? " (stopped at the budget: run the rest in another sitting)" : ""}`);
  console.log("note: a refusal is scored as 'text only, no proposal, no forbidden tool, right language'; read the reply texts in the results file for the wording.");
  fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), stream: streamArg, thinking: thinkArg, max_neurons: maxNeurons, spent: Math.round(spent), stopped, rows, cases: all.map((v) => ({ model: v.model, cases: v.cases })) }, null, 2) + "\n");
  console.log(`results: ${outFile}`);
}
evMain().catch((e: any) => { console.error("wf ai eval failed:", e instanceof ProviderFailure ? e.code : String(e && e.message || e).replace(/[0-9a-f]{32}/gi, "<id>")); EV_PROC.exit(1); });
