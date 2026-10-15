#!/bin/bash
# Free-model eval for the ai-gateway (stage 6 v2 G7). NOT part of check_all.sh and never run by a test: it calls Cloudflare
# Workers AI and spends the FREE quota (10,000 neurons/day for the whole account, which the live app uses too).
#
#   bash .claude/eval/run_ai_eval.sh --dry                      no network, no secrets: builds every request, prints the plan and the estimate
#   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AI_TOKEN=... bash .claude/eval/run_ai_eval.sh [flags]
# Flags: --models a,b  --cases id,id  --stream on|off|both (default both)  --thinking on|off|both (default off)
#        --max-neurons N (default 2500: stops before a call that would pass it)  --record  --out <file>  --dry
# --record writes the raw bodies (never headers, the URL or the account) to supabase/functions/ai-gateway/fixtures/
# cf-rec-<model>-<case>-<stream|plain>[-<step>].txt (.json for a non-streamed body); tests_providers.ts parses them.
#
# The secrets come only from the caller's environment, at run time: nothing is written to a file or printed (only
# "set"). The harness uses the production pieces (ASSISTANT_SYSTEM, contextText, toolsFor, apiTools, buildRequest,
# toOpenAiRequest, openAiCompatTurn, validateInput, neuronsOf), so it measures exactly what the gateway sends.
#
# Budget (about 3k prompt + 300 output tokens per call, from research/cloudflare-openai.md's price table):
#   model          neurons per call   one-tool turns per day
#   glm-4.7-flash  about 27           about 180
#   gemma-4-26b    about 36           about 140
#   gpt-oss-120b   about 116          about 43
#   qwen3.8-27b    about 210          about 24
# All 4 models x 13 cases x 2 stream modes is about 10k neurons: the whole day. Run it in TWO SITTINGS (day 1: glm +
# gemma; day 2: gpt-oss + qwen with --stream off), and only BEFORE live uses the free AI on the same account.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
GW="$(cd "$DIR/../../supabase/functions/ai-gateway" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
DRY=0
for a in "$@"; do [ "$a" = "--dry" ] && DRY=1; done
if [ "$DRY" = 0 ]; then
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$CLOUDFLARE_AI_TOKEN" ] || { echo "run_ai_eval.sh: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN in your shell first (or use --dry)." >&2; exit 2; }
  echo "account: set"
  echo "token: set"
fi
OUT="${TMPDIR:-/tmp}/ai_eval_$$.ts"
trap 'rm -f "$OUT"' EXIT
{
  echo '(globalThis as any).__AI_TEST__ = true;'
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
  sed -e '/^import { createClient }/d' -e '/^import Anthropic/d' -e '/^import webpush/d' -e 's/^export //' "$GW/index.ts"
  echo "const EVAL_CASES: any = $(cat "$DIR/ai_eval_cases.json");"
  node -e 'console.log("const EVAL_PATHS = " + JSON.stringify({ fixtures: process.argv[1], root: process.argv[2] }) + ";")' "$GW/fixtures" "$ROOT"
  cat "$DIR/ai_eval.ts"
} > "$OUT"
cd "$GW" && npx --yes tsx "$OUT" "$@"
