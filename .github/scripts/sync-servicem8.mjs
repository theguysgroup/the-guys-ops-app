// ServiceM8 integration — Phase 2 (read-only pull).
//
// Matches our jobs.invoice_number to ServiceM8's generated_job_id (confirmed
// with Ofek: technicians literally type the ServiceM8 job number into our
// "Invoice #" field) and pulls payment status back in, so nobody has to
// manually re-enter what's already been paid in ServiceM8.
//
// Deliberately narrow scope for this first phase: only payment_status and
// date_paid are pulled. Amount/GST are left as manually entered — ServiceM8's
// total_invoice_amount doesn't have a documented pre/post-GST distinction
// matching our amount+includesGST model, so touching it risks silently
// corrupting commission math. Revisit only if that mapping gets confirmed.
//
// Runs from GitHub Actions using the Supabase service_role key, which
// bypasses RLS by design — this is a trusted server-side job, not a
// browser-facing one, so that's the correct key to use here (never the
// anon/publishable key, which wouldn't have write access anyway).

const SM8_KEY = process.env.SERVICEM8_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SM8_KEY || !SB_URL || !SB_KEY) {
  console.error('Missing required environment variables (SERVICEM8_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

function sbHeaders(extra) {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}

async function main() {
  const ourJobsRes = await fetch(
    `${SB_URL}/rest/v1/jobs?select=id,invoice_number,payment_status,date_paid,servicem8_job_uuid`,
    { headers: sbHeaders() }
  );
  if (!ourJobsRes.ok) {
    throw new Error(`Failed to fetch our jobs: ${ourJobsRes.status} ${await ourJobsRes.text()}`);
  }
  const ourJobs = (await ourJobsRes.json()).filter(j => (j.invoice_number || '').trim());
  if (!ourJobs.length) {
    console.log('No jobs with an invoice number to check against ServiceM8.');
    return;
  }

  // Not paginated/filtered on purpose for this first version — the business's
  // total ServiceM8 job count is small enough that one unfiltered GET is well
  // within the 180/min, 20,000/day rate limit. Revisit with $filter or
  // cursor pagination if that ever stops being true.
  const sm8Res = await fetch('https://api.servicem8.com/api_1.0/job.json', {
    headers: { 'X-API-Key': SM8_KEY, Accept: 'application/json' },
  });
  if (!sm8Res.ok) {
    throw new Error(`ServiceM8 API error: ${sm8Res.status} ${await sm8Res.text()}`);
  }
  const sm8Jobs = await sm8Res.json();

  const byJobNumber = new Map();
  for (const j of sm8Jobs) {
    if (j.generated_job_id) byJobNumber.set(String(j.generated_job_id).trim(), j);
  }

  let updated = 0, checked = 0;
  for (const ours of ourJobs) {
    const match = byJobNumber.get(String(ours.invoice_number).trim());
    if (!match) continue;
    checked++;

    // Only ever move a job FORWARD to Paid — never revert an existing Paid
    // status back to Unpaid automatically. A human marking something paid
    // (e.g. cash confirmed in hand) is real information that must not be
    // silently undone just because ServiceM8's own record hasn't caught up
    // yet; the reverse (staying "Unpaid" a little longer than necessary) is
    // harmless and self-corrects on the next sync.
    const sm8IsPaid = Number(match.payment_received) === 1;
    const weAreAlreadyPaid = ours.payment_status === 'Paid';
    const statusChanged = sm8IsPaid && !weAreAlreadyPaid;
    const uuidChanged = match.uuid !== ours.servicem8_job_uuid;
    if (!statusChanged && !uuidChanged) continue;

    const patch = {
      servicem8_job_uuid: match.uuid,
      servicem8_last_synced_at: new Date().toISOString(),
    };
    if (statusChanged) {
      patch.payment_status = 'Paid';
      patch.date_paid = match.payment_received_stamp ? match.payment_received_stamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
    }

    const patchRes = await fetch(`${SB_URL}/rest/v1/jobs?id=eq.${ours.id}`, {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    if (!patchRes.ok) {
      console.error(`Failed to update job ${ours.id}: ${patchRes.status} ${await patchRes.text()}`);
      continue;
    }

    if (statusChanged) {
      await fetch(`${SB_URL}/rest/v1/activity_log`, {
        method: 'POST',
        headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify({
          record_kind: 'job',
          record_id: ours.id,
          actor: 'ServiceM8 sync',
          text: `Payment status synced from ServiceM8: "${ours.payment_status}" → "Paid"`,
          manual: false,
        }),
      });
    }
    updated++;
  }

  console.log(`Checked ${checked} job(s) against ServiceM8, updated ${updated}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
