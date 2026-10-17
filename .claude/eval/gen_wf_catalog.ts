// Workflow AI's static catalog (stage 7, spec D11), appended to the automations function's index.ts by gen_wf_catalog.sh
// (which strips its imports, as automations/run_tests.sh does). It reads the engine's own registry (registryExport with
// every connector on) and writes supabase/functions/ai-gateway/wf_catalog.ts: one line per type, sorted. The gateway bakes it
// into the Workflow AI system prompt (the cached prefix); what THIS business has comes from the workflow_options tool.
//   --print   the file's text on stdout (ai-gateway/run_tests.sh compares it with the committed file)
//   (none)    writes the file
// deno-lint-ignore-file no-explicit-any

const WFC_MAX_CHARS = 9000;
const WFC_ALL_ON: AvailCtx = { phone: true, xero: true, gbp: true, reviews: true, ai: true, teamEmail: true, atomicTags: true };

// One config field: name, * when required, :type (an enum's values, a catalog list's name, list/object/number/text/yes-no).
function wfcField(name: string, p: any, required: string[]): string {
  const s = p && typeof p === "object" ? p : {};
  const src = typeof s["x-source"] === "string" ? s["x-source"].replace(/^catalog\./, "") : "";
  const items = s.items && typeof s.items === "object" ? s.items : null;
  const itemSrc = items && typeof items["x-source"] === "string" ? items["x-source"].replace(/^catalog\./, "") : "";
  let t = "";
  if (Array.isArray(s.enum)) t = s.enum.length <= 8 ? s.enum.join("|") : s.enum.slice(0, 8).join("|") + "|…";
  else if (src) t = src;
  else if (s.const !== undefined) t = JSON.stringify(s.const);
  else if (Array.isArray(s.anyOf) && s.anyOf.length && s.anyOf.every((x: any) => x && Array.isArray(x.enum))) t = s.anyOf.flatMap((x: any) => x.enum).join("|");
  else {
    const ty = Array.isArray(s.type) ? s.type.filter((x: string) => x !== "null")[0] : s.type;
    t = ty === "array" ? `list of ${itemSrc || (items && Array.isArray(items.enum) ? items.enum.join("|") : items && items.type === "object" ? "objects" : (items && items.type) || "values")}`
      : ty === "integer" || ty === "number" ? "number" : ty === "boolean" ? "yes/no" : ty === "object" ? "object" : "text";
  }
  return `${name}${required.includes(name) ? "*" : ""}:${t}`;
}
function wfcConfig(fields: any): string {
  const f = fields && typeof fields === "object" ? fields : {}, props = f.properties && typeof f.properties === "object" ? f.properties : {};
  const req = Array.isArray(f.required) ? f.required : [];
  const list = Object.keys(props).map((k) => wfcField(k, props[k], req));
  return list.length ? list.join(", ") : "none";
}
function wfcPorts(e: any): string {
  if (e.kind === "if_else") return "<branch ids>|none";
  if (e.kind === "split") return "<path ids>";
  if (e.kind === "goto") return "none (ends the path)";
  if (e.kind === "wait" && e.portLabels) return "next|timeout (timeout only with a timeout)";
  if (e.key === "remove_from_workflow") return "next (none when scope is current or all)";
  return "next";
}
export function wfCatalogText(reg: any): string {
  const usable = (e: any) => !e.hidden && e.availability && e.availability.ok === true;
  const lines: string[] = [];
  // the filter lists most triggers share, named once: LEAD (a lead's fields, the clock) and JOB (a job's fields + LEAD)
  const of = (k: string) => ((reg.triggers.find((t: any) => t.key === k) || {}).filters || []) as string[];
  const LEAD = of("newLead").filter((f) => f !== "not_picked"), JOB = of("jobClosed");
  const short = (list: string[]) => {
    const all = (g: string[]) => g.length > 0 && g.every((f) => list.includes(f));
    const [name, g] = all(JOB) ? ["JOB", JOB] : all(LEAD) ? ["LEAD", LEAD] : ["", [] as string[]];
    return [...(name ? [name] : []), ...list.filter((f) => !g.includes(f))].join(", ") || "none";
  };
  const cfg = (e: any) => { const c = wfcConfig(e.fields); return c === "none" ? "" : ` — config: ${c}`; };
  for (const t of reg.triggers.filter(usable)) lines.push(`trigger/${t.key} — ${t.label} — filters: ${short(t.filters || [])}${cfg(t)}`);
  for (const group of ["actions", "waits", "goals", "logic"]) {
    for (const e of reg[group].filter(usable)) { const p = wfcPorts(e); lines.push(`${e.kind}/${e.key} — ${e.label}${cfg(e)}${p === "next" ? "" : ` — ports: ${p}`}`); }
  }
  lines.sort();
  const ops: Record<string, string[]> = {};
  for (const o of reg.ops) for (const vt of o.valueTypes || []) (ops[vt] = ops[vt] || []).push(o.op);
  const fields = reg.fields.filter((f: any) => !f.hidden && !f.gate && (!f.availability || f.availability.ok)).map((f: any) => `${f.key}(${f.valueType})`).sort();
  return [
    "Workflow types (kind/type — label — config fields, * = required — ports: a step's out keys; none listed = next):",
    ...lines,
    `Filter groups: LEAD = ${LEAD.join(", ")}; JOB = ${JOB.filter((f) => !LEAD.includes(f)).join(", ")} + LEAD`,
    "Condition fields (field(value type)): " + fields.join(", "),
    "Ops by value type: " + Object.keys(ops).sort().map((k) => `${k}: ${ops[k].join(" ")}`).join("; "),
  ].join("\n");
}
export function wfCatalogFile(reg: any): string {
  const text = wfCatalogText(reg);
  if (text.length > WFC_MAX_CHARS) throw new Error(`gen_wf_catalog: the catalog is ${text.length} characters (at most ${WFC_MAX_CHARS})`);
  return [
    "// GENERATED by .claude/eval/gen_wf_catalog.sh from the automations registry (registryExport, every connector on). Never edit",
    "// it by hand: run `bash .claude/eval/gen_wf_catalog.sh` after a registry change (ai-gateway/run_tests.sh compares it).",
    `export const WF_CATALOG_TEXT = ${JSON.stringify(text)};`,
    "",
  ].join("\n");
}

(async () => {
  const P: any = (globalThis as any).process;
  const out = wfCatalogFile(registryExport(WFC_ALL_ON, {}));
  if (P.argv.includes("--print")) { P.stdout.write(out); return; }
  const fs: any = await import("node:fs");
  fs.writeFileSync(P.env.WF_CATALOG_OUT, out);
  console.log(`gen_wf_catalog: wrote ${P.env.WF_CATALOG_OUT} (${out.length} characters)`);
})().catch((e) => { console.error(String((e && e.message) || e)); (globalThis as any).process.exit(1); });
