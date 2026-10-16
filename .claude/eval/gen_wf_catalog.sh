#!/bin/bash
# Writes supabase/functions/ai-gateway/wf_catalog.ts (Workflow AI's static catalog, stage 7 spec D11) from the automations
# registry: the function's index.ts with its imports stubbed (as automations/run_tests.sh), then gen_wf_catalog.ts.
#   bash .claude/eval/gen_wf_catalog.sh           regenerate the file (after any registry change)
#   bash .claude/eval/gen_wf_catalog.sh --print   the file's text on stdout (ai-gateway/run_tests.sh compares it)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
FN="$(cd "$DIR/../../supabase/functions" && pwd)"
OUT="${TMPDIR:-/tmp}/gen_wf_catalog_$$.ts"
trap 'rm -f "$OUT"' EXIT
{
  echo '(globalThis as any).__AUTO_TEST__ = true;'
  echo '(globalThis as any).__AUTO_ENV__ = {} as Record<string, string>;'
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (globalThis as any).__AUTO_ENV__[k] } };'
  echo 'const createClient = null as any;'
  echo 'const webpush = null as any;'
  sed -e '/^import { createClient }/d' -e '/^import webpush/d' -e 's/^export //' "$FN/automations/index.ts"
  sed -e 's/^export //' "$DIR/gen_wf_catalog.ts"
} > "$OUT"
cd "$FN/automations" && WF_CATALOG_OUT="$FN/ai-gateway/wf_catalog.ts" npx --yes tsx "$OUT" "$@"
