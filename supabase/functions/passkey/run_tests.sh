#!/bin/bash
# Runs the passkey function tests locally: the function with its imports stubbed and a pretend Deno.env, then tests.ts.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/passkey_test_$$.ts"
{
  echo '(globalThis as any).__PASSKEY_TEST__ = true;'
  echo '(globalThis as any).Deno = { env: { get: (_k: string) => undefined } };'
  echo 'const createClient = null as any; const generateRegistrationOptions = null as any; const verifyRegistrationResponse = null as any; const generateAuthenticationOptions = null as any; const verifyAuthenticationResponse = null as any;'
  sed -e '/^import { createClient }/d' -e '/^import { generateRegistrationOptions/d' -e 's/^export //' "$DIR/index.ts"
  cat "$DIR/tests.ts"
} > "$OUT"
cd "$DIR" && npx --yes tsx "$OUT"
rm -f "$OUT"
