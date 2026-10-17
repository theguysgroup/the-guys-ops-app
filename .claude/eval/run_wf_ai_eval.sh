#!/bin/bash
# Workflow AI eval for the ai-gateway (stage 7 D, spec §6). NOT part of check_all.sh and never run by a test: a real run calls
# Cloudflare Workers AI and spends the FREE quota (10,000 neurons/day for the whole account, which the live app uses too).
#
#   bash .claude/eval/run_wf_ai_eval.sh --dry            no network, no secrets: builds every request of the 30 cases, runs a scripted
#                                                        turn (the tools the case needs + one canned proposal) on the real checks, writes
#                                                        .claude/eval/wf_ai_eval_dry.json
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AI_TOKEN=... bash .claude/eval/run_wf_ai_eval.sh --max-neurons 2500 [flags]
# Flags: --models a,b (default: the gateway's "cloudflare:heavy" model)  --cases id,id  --stream on|off (default on)
#        --thinking on|off (default off)  --max-neurons N (REQUIRED for a real run: it stops before a call that would pass it)
#        --out <file> (a real run: outside the repo)  --dry
# Scoring (per case, from the case file's `expect`): outcome, tool, forbid_tools, types_all, forbid_types, ops_any, keep_ids,
# valid, hebrew_fields, mentions_any, lang. Pass bar on the free model: >= 24/30, 0 forbidden types, 0 forbidden tools, every
# refusal refused. Cases are never tuned to pass; if the free model misses the bar, run the same set on the paid model.
#
# The harness uses the production pieces (the mode prompts with wf_catalog.ts, the four tools, buildRequest, toOpenAiRequest,
# openAiCompatTurn, proposeChange, validateInput) and the automations function's own code in process (AUTO.apiStep: the real
# registry, validate and patch on a fake database; its save / publish / test steps throw). A proposal is only recorded: no
# database, no write, nothing sent to a customer. The secrets come only from the caller's environment, at run time: nothing is
# written to a file or printed (only "set").
# Budget: about 6-8k prompt tokens a call, 3-5 calls a case: plan <= 2,500 neurons per sitting (the dry run prints the estimate).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
GW="$(cd "$DIR/../../supabase/functions/ai-gateway" && pwd)"
AU="$(cd "$DIR/../../supabase/functions/automations" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
DRY=0
for a in "$@"; do [ "$a" = "--dry" ] && DRY=1; done
if [ "$DRY" = 0 ]; then
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$CLOUDFLARE_AI_TOKEN" ] || { echo "run_wf_ai_eval.sh: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in your shell first (or use --dry)." >&2; exit 2; }
  echo "account: set"
  echo "token: set"
fi
OUT="${TMPDIR:-/tmp}/wf_ai_eval_$$.ts"
trap 'rm -f "$OUT"' EXIT
{
  echo '(globalThis as any).__AI_TEST__ = true;'
  echo '(globalThis as any).__AUTO_TEST__ = true;'
  # read from the caller's environment when the file runs; the values are never in the file
  echo "(globalThis as any).__AI_ENV__ = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-eval', CLOUDFLARE_ACCOUNT_ID: (globalThis as any).process?.env?.CLOUDFLARE_ACCOUNT_ID || '', CLOUDFLARE_AI_TOKEN: (globalThis as any).process?.env?.CLOUDFLARE_AI_TOKEN || '' } as Record<string, string>;"
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__AI_ENV__[k] } };'
  echo 'const createClient = null as any;'
  echo 'const webpush = null as any;'
  cat <<'TS'
class __APIError extends Error { status: any; constructor(status?: any, message = "api error") { super(message); this.status = status; } }
const Anthropic: any = class { constructor() { throw new Error("the eval never uses Anthropic"); } };
for (const n of ["APIUserAbortError", "APIConnectionError", "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError", "RateLimitError", "InternalServerError"]) Anthropic[n] = class extends __APIError {};
Anthropic.APIError = __APIError;
TS
  # the automations function's own code, in a closure (its names clash with the gateway's): the eval calls AUTO.apiStep
  echo 'const AUTO = (() => {'
  sed -e '/^import { createClient }/d' -e '/^import webpush/d' -e 's/^export //' "$AU/index.ts"
  echo 'return { apiStep, BUSINESS_ID };'
  echo '})();'
  sed -e 's/^export //' "$GW/wf_catalog.ts"
  sed -e '/^import { createClient }/d' -e '/^import Anthropic/d' -e '/^import webpush/d' -e '/^import { WF_CATALOG_TEXT }/d' -e 's/^export //' "$GW/index.ts"
  echo "const EVAL_CASES: any = $(cat "$DIR/workflow_ai_cases.json");"
  echo "const EVAL_WORKFLOWS: any = $(cat "$AU/fixtures/workflows.json");"
  node -e 'console.log("const EVAL_PATHS = " + JSON.stringify({ root: process.argv[1] }) + ";")' "$ROOT"
  cat "$DIR/wf_ai_eval.ts"
} > "$OUT"
cd "$GW" && npx --yes tsx "$OUT" "$@"
