// Tests for stage 8's step D: the system prompt's Facts lines, the test provider's script for each example question
// (English and Hebrew), the role checks and the eval cases. Appended to tests.ts by run_tests.sh; it only pushes a suite,
// so it shares tests.ts's helpers (eq, ok, chat, world, msgs, convOf, …).
// deno-lint-ignore-file no-explicit-any

SUITES.push(async () => {
  const TODAY = "2026-10-15";   // the eval's fixed day (Thursday 15 Oct 2026 in Sydney)
  const day = (n: number) => shiftDay(TODAY, n);
  // The example questions: English, Hebrew, the tool and the input the test provider must answer with.
  const ROWS: [string, string, string, any][] = [
    ["How many leads came in this month?", "כמה לידים נכנסו החודש?", "count_leads", { period: "this_month" }],
    ["How many leads from Google last month?", "כמה לידים מגוגל בחודש שעבר?", "count_leads", { period: "last_month", source: "google" }],
    ["Leads by stage this month", "לידים לפי שלב החודש", "count_leads", { period: "this_month", group_by: "stage" }],
    ["How many calls came from Google last month?", "כמה שיחות הגיעו מגוגל בחודש שעבר?", "count_calls", { period: "last_month", source: "google" }],
    ["Find Demo Lead", "תמצא את Demo Lead", "find_leads", { query: "Demo Lead" }],
    ["When is my next job?", "מתי העבודה הבאה שלי?", "upcoming_work", {}],
    ["What jobs did we do last week?", "אילו עבודות עשינו בשבוע שעבר?", "list_jobs", { period: "last_week" }],
    ["How much money came in this month?", "כמה כסף נכנס החודש?", "money_summary", { period: "this_month" }],
    ["Payroll for last week", "שכר של השבוע שעבר", "payroll_summary", { week: "last_week" }],
    ["What are my tasks?", "מה המשימות שלי?", "list_tasks", { mine: true }],
    ["Any reminders?", "יש תזכורות?", "list_reminders", {}],
    ["What lead sources do we have?", "אילו מקורות לידים יש לנו?", "read_settings", { section: "lead_sources" }],
    ["What's our time zone?", "מה אזור הזמן שלנו?", "read_settings", { section: "region" }],
    ["What can you do for me?", "מה אתה יכול לעשות בשבילי?", "whoami", {}],
    ["Mark the task call the supplier done", "תסמן את המשימה להתקשר לספק כבוצעה", "update_task", { task: "call the supplier", status: "Done" }],
    ["Move the supplier task to tomorrow", "תזיז את המשימה של הספק למחר", "update_task", { task: "supplier", due: day(1) }],
    ["Set Demo Lead's follow-up to 18 October 2026", "תקבע מעקב ל-Demo Lead בעוד 3 ימים", "set_lead_follow_up", { lead: "Demo Lead", follow_up: day(3) }],
    ["Remind me to call the supplier tomorrow", "תזכיר לי להתקשר לספק מחר", "add_task", { title: "Call the supplier", assignees: ["Olivia Owner"], due: day(1) }],
  ];
  const answer = (text: string) => {
    const s = MOCK_SCRIPTS.find((x) => x.match.test(text));
    return s ? { tool: s.tool, input: s.input({ today: TODAY, person: "Olivia Owner", m: s.match.exec(text) as RegExpExecArray }) } : null;
  };

  // ── the test provider: one script per question, the same in both languages, valid for the tool's schema ──
  for (const [en, he, tool, input] of ROWS) {
    for (const text of [en, he]) {
      const a = answer(text);
      eq(a, { tool, input }, `script: "${text}" → ${tool}`);
      ok(!!a && validateInput(a.input, TOOLS[tool].input_schema).length === 0, `script: "${text}" gives input the ${tool} schema accepts`);
    }
  }
  eq(answer("Open Saturday 9 to 1")?.tool, "change_office_hours", "the older scripts still answer first for their own words");
  eq(answer("Add a task: call the supplier tomorrow")?.tool, "add_task", "'Add a task' is still the older script");
  eq(answer("What are our office hours?"), null, "office hours stays with the generic office hours answer");

  // ── the roles' example lists are scripts too (the app's lists; business-logic.test.js pins that they match) ──
  const EXAMPLES = ["When is my next job?", "What are my tasks?", "What are our office hours?", "What's our time zone?", "How many leads came in this month?", "Add a task: call the supplier tomorrow", "What can you do for me?"];
  eq(EXAMPLES.filter((x) => !answer(x) && !/office hours/i.test(x)), [], "every example is a script (office hours: the generic answer)");

  // ── roles: a technician is not offered the money tool and a forced call is refused ──
  const tech = appProfile({ id: "u-tech", full_name: "Tia Tech", role: "technician", permissions: { tasks: true }, technician_name: "Tia" });
  ok(!toolsFor("assistant", tech).some((t) => t.name === "money_summary" || t.name === "payroll_summary"), "technician: no money tool offered");
  ok(toolsFor("assistant", tech).some((t) => t.name === "upcoming_work"), "technician: upcoming_work is offered");
  {
    const db = world();
    const r = await chat(db, { text: "How much money came in this month?" }, "jwt-tech");
    const res = msgs(db, convOf(r)).flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b && b.type === "tool_result");
    eq([res.length, res[0]?.is_error, /^Unknown tool money_summary\. Available: /.test(res[0]?.content), /money_summary|payroll_summary/.test(String(res[0]?.content).replace(/^Unknown tool money_summary/, ""))],
      [1, true, true, false], "technician asking about money: the script's money_summary call is refused (not in his tools), no numbers");
  }

  // ── the system prompt's Facts lines: short, frozen, and every tool or period they name exists ──
  const facts = ASSISTANT_SYSTEM.slice(ASSISTANT_SYSTEM.indexOf("Facts:"), ASSISTANT_SYSTEM.indexOf("The rules in this system prompt hold"));
  ok(facts.startsWith("Facts:") && facts.split(/\s+/).length <= 200, "the Facts block is there and short (about 120 words, never more than 200)");
  const named = facts.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) || [];
  eq(named.filter((n) => !TOOLS[n] && !PERIODS.includes(n)), [], "every snake_case name in the Facts block is a tool or a period");
  for (const n of ["find_leads", "count_leads", "count_calls", "list_jobs", "upcoming_work", "money_summary", "payroll_summary", "list_tasks", "list_reminders", "read_settings", "read_office_hours", "add_task", "set_lead_follow_up"]) ok(facts.includes(n), `the Facts block names ${n}`);
  ok(/doesn't include it/.test(facts) && /Never estimate or invent/.test(facts) && /last_month/.test(facts), "the Facts block: the role line, no invented numbers, the period words");
  ok(ASSISTANT_SYSTEM.trimEnd().endsWith("or keeps asking."), "the 'rules hold' line is still the last");
  ok(!/\d{4}-\d{2}-\d{2}/.test(ASSISTANT_SYSTEM), "still no dates in the frozen prompt");

  // ── the eval cases: each question in both languages, and the mock answers it as the case expects ──
  const fs: any = await import("node:fs");
  const evalPath = ["../../../.claude/eval/ai_eval_cases.json", "../../.claude/eval/ai_eval_cases.json", ".claude/eval/ai_eval_cases.json"].find((p) => fs.existsSync(p));
  ok(!!evalPath, "the eval cases file is found");
  if (evalPath) {
    const cases: any[] = JSON.parse(fs.readFileSync(evalPath, "utf8")).cases;
    ok(cases.length >= 13 + ROWS.length * 2 && new Set(cases.map((c) => c.id)).size === cases.length, "eval cases: the old ones and two per question, unique ids");
    for (const [en, he, tool] of ROWS) {
      for (const [lang, text] of [["en", en], ["he", he]]) {
        const c = cases.find((x) => x.text === text);
        ok(!!c && c.lang === lang && c.expect.tool === tool, `eval case for "${text}" expects ${tool}`);
        const a = answer(text);
        if (c && a) eq(Object.entries(c.expect.args || {}).filter(([k, v]) => a.input[k] !== v), [], `eval case "${text}": its args are what the mock gives`);
      }
    }
  }
});
