#!/bin/bash
# Runs the voice function tests locally (the steps in README.md): the function with its esm.sh import stubbed, a pretend
# Deno.env with test values, and the expected Twilio signature for auth token "testtoken"; then tests.ts, with npx tsx.
set -e
set -o pipefail   # a failing test (exit 1) fails the run even through the grep below
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$DIR/index.ts}"
OUT="${TMPDIR:-/tmp}/voice_test_$$.ts"
SIG=$(python3 -c 'import hmac,hashlib,base64; print(base64.b64encode(hmac.new(b"testtoken", b"https://example.supabase.co/functions/v1/voice?step=incomingCallSidCA1From+61412345678To+61290001111", hashlib.sha1).digest()).decode())')
{
  echo '(globalThis as any).__VOICE_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (k: string) => (({ TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "testtoken", TWILIO_API_KEY_SID: "SKtest", TWILIO_API_KEY_SECRET: "secrettest", TWILIO_TWIML_APP_SID: "APtest", TWILIO_NUMBER: "+61400000001", VOICE_FUNCTION_URL: "https://example.supabase.co/functions/v1/voice" }) as any)[k] } };'
  echo "const SIG_EXPECTED = \"$SIG\";"
  echo 'const createClient = null as any;'
  sed -e '/^import { createClient }/d' -e 's/^export //' "$SRC"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT" | grep -v '^TOKEN '
rm -f "$OUT"
