# voice — the business phone line (Twilio)

`index.ts` is deployed as the Supabase Edge Function `voice` (JWT verification OFF: Twilio cannot send a Supabase
token; every Twilio request is checked with X-Twilio-Signature instead, and `token`/`play` check the signed-in user).

Tests: `tests.ts` holds the test cases. To run them, build a test file from `index.ts` (swap the supabase import for
`const createClient = null as any;`, drop `export`), prepend a fake `Deno.env` with test values and a `SIG_EXPECTED`
computed with Python's `hmac` (SHA1, auth token `testtoken`), then `npx tsx voice_test.ts`.

## Secrets (Supabase → Edge Functions → Secrets)
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID,
TWILIO_NUMBER (+61…, the number Twilio answers and the caller ID), OWNER_MOBILES (comma-separated),
VOICE_FUNCTION_URL = https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/voice

## Twilio console
- Phone number → Voice: "A call comes in" → Webhook POST `…/voice?step=incoming`; "Call status changes" → `…/voice?step=status`.
- TwiML App (for the browser phone) → Voice Request URL POST `…/voice?step=outbound`, Status callback `…/voice?step=status`.
- API key (Standard) → SID + secret.

Switch on in the app: `update public.settings set phone_enabled = true;`
