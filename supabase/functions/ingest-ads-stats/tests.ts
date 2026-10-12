
// ── tests ──
let pass = 0, fail = 0;
function eq(got: unknown, want: unknown, name: string) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
(async () => {
  // Upload tickets (13 Oct): made with the key, checked with the key, short-lived, and only good for ad-stat rows.
  const KEY = "test-key-0123456789", NOW = 1791900000;
  const t = await makeTicket(KEY, NOW, 150);
  eq([/^v1\.\d{10}\.[0-9a-f]{64}$/.test(t.ticket), t.expires], [true, NOW + 150 * 60], "ticket shape and 150-minute expiry");
  eq(await ticketOk(KEY, t.ticket, NOW + 60), true, "a fresh ticket is accepted");
  eq(await ticketOk("another-key", t.ticket, NOW + 60), false, "a ticket made with another key is refused");
  eq(await ticketOk(KEY, t.ticket, NOW + 150 * 60), false, "an expired ticket is refused");
  const tampered = t.ticket.replace(/\.(\d{10})\./, (_m, e) => "." + String(Number(e) + 3600) + ".");
  eq(await ticketOk(KEY, tampered, NOW + 60), false, "a ticket with a later expiry written in is refused");
  eq(await ticketOk(KEY, t.ticket.slice(0, -1) + (t.ticket.endsWith("0") ? "1" : "0"), NOW + 60), false, "a changed signature is refused");
  eq([await ticketOk(KEY, "", NOW), await ticketOk(KEY, "v1.abc.def", NOW), await ticketOk("", t.ticket, NOW + 60)], [false, false, false], "empty or malformed tickets and a missing key are refused");
  const long = await makeTicket(KEY, NOW, 9999), short = await makeTicket(KEY, NOW, 0);
  eq([long.expires - NOW, short.expires - NOW], [3 * 3600, 60], "a ticket lasts between 1 minute and 3 hours");
  const far = `v1.${NOW + 5 * 3600}.${"a".repeat(64)}`;
  eq(await ticketOk(KEY, far, NOW), false, "a ticket claiming more than 3 hours is refused");

  // What a ticket may do: replace ad-stat rows and read the real-lead counts. Nothing else.
  eq([
    requestKind({ platform: "google", account: "1", win: "30d", level: "keyword", rows: [] }),
    requestKind({ realLeads: true }), requestKind({ insight: { day: "2026-10-12" } }), requestKind({ leadEmails: { emails: [] } }),
    requestKind({ issueTicket: { minutes: 150 } }), requestKind({ pendingGclids: true }), requestKind({ clickAttribution: [] }), requestKind({ crmDigest: { end: "2026-10-12" } }),
  ], ["rows", "realLeads", "insight", "leadEmails", "issueTicket", "pendingGclids", "clickAttribution", "crmDigest"], "each kind of request is recognised");
  eq(["rows", "realLeads", "insight", "leadEmails", "issueTicket", "pendingGclids", "clickAttribution", "crmDigest"].map((k) => TICKET_ALLOWS.has(k)),
    [true, true, false, false, false, false, false, false], "a ticket allows rows and real-lead counts only");
  eq(requestKind({ issueTicket: { minutes: 10 }, platform: "google", rows: [] }), "issueTicket", "asking for a ticket inside a rows body is still a ticket request (needs the key)");

  console.log(`ingest-ads-stats: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
