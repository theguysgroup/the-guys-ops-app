
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

  // ── organic (13 Oct) ──
  eq([requestKind({ organic: {} }), requestKind({ seoWeekly: {} }), requestKind({ organicFindings: true }), requestKind({ organicDigest: { end: "2026-10-12" } })],
    ["organicRows", "organicWeekly", "organicFindings", "organicDigest"], "organic requests are recognised");
  eq(["organicRows", "organicWeekly", "organicFindings", "organicDigest"].map((k) => TICKET_ALLOWS.has(k)), [true, false, false, false], "a ticket may load Search Console / GA4 rows, nothing else organic");
  const B = organicBatch({ source: "gsc", win: "28d", level: "page", rows: [
    { item: "https://theguyservicegroup.com/services/chimney-sweep-sydney/", clicks: 31, impressions: 2689, position: 1.6396 },
    { item: "https://theguyservicegroup.com/aircon-cleaning-service/", clicks: 50, impressions: 900, position: 3 },
    { item: "https://theguyservicegroup.com/aircon-split-system-cleaning-service/?gclid=x", clicks: 5, impressions: 90, position: 4 },
    { item: "https://theguyservicegroup.com/services/chimney-sweep-sydney/", clicks: 1, impressions: 1, position: 1 },
    { item: "https://theguyservicegroup.com/", clicks: -3, impressions: "x", position: "" } ] });
  eq(B.ok ? B.rows.map((r) => [r.item.replace("https://theguyservicegroup.com", ""), r.clicks, r.impressions, r.position]) : B,
    [["/services/chimney-sweep-sydney/", 31, 2689, 1.64], ["/", 0, 0, null]], "ad landing pages and repeats dropped; bad numbers become 0 or no position");
  eq([organicBatch({ source: "gsc", win: "30d", level: "page", rows: [] }), organicBatch({ source: "gsc", win: "28d", level: "keyword", rows: [] }), organicBatch({ source: "bing", win: "28d", level: "page", rows: [] }), organicBatch({ source: "serp", win: "28d", level: "localpack", rows: [] })].map((x) => x.ok ? "ok" : x.error),
    ["invalid win", "invalid level", "invalid source", "invalid win"], "only the known sources, levels and windows (the weekly check uses its date)");
  eq([urlPath("https://theguyservicegroup.com/services/air-conditioning-cleaning"), urlPath("/aircon-cleaning-service/?utm=1"), isPpcUrl("https://theguyservicegroup.com/services/air-conditioning-cleaning/")], ["/services/air-conditioning-cleaning/", "/aircon-cleaning-service/", false], "paths compare without the domain, query or a missing slash; the aircon service page is not an ad page");
  const WK = weeklyBatches({ week: "2026-10-19", localpack: [{ query: "aircon cleaning sydney", region: "Sydney CBD", position: 1, organic: null, aiOverview: false, top: [{ name: "The AC Cleaning Guys", rating: 5, reviews: 104 }] }, { query: "ducted aircon cleaning sydney", region: "Parramatta", position: null }],
    aimode: [{ query: "aircon cleaning sydney", runs: 2, mentioned: 0, named: ["A Grade", "Coolguys"] }], reviews: { ours: { name: "The AC Cleaning Guys", count: 104, rating: 5, thisWeek: 1, newestDays: 16 }, competitors: [{ name: "Eco Aircon", count: 181 }] } });
  eq(WK.ok ? WK.batches.map((b) => [b.level, b.win, b.rows.length]) : WK, [["localpack", "2026-10-19", 2], ["aimode", "2026-10-19", 1], ["reviews", "2026-10-19", 2]], "the weekly check becomes one batch per level, kept under its date");
  eq([weeklyBatches({ week: "13/10" }), weeklyBatches({ week: "2026-10-19" })].map((x) => x.ok ? "ok" : x.error), ["invalid week", "nothing in the weekly data"], "a weekly upload needs its date and some data");
  eq([expectedCtr(1), expectedCtr(1.6), expectedCtr(5), expectedCtr(13.8), expectedCtr(40)], [0.25, 0.14, 0.055, 0.012, 0.004], "the usual click rate by position");
  eq([BRAND_RE.test("the guys service group"), BRAND_RE.test("guys group chimney"), BRAND_RE.test("aircon cleaning sydney"), BRAND_RE.test("cool guys aircon")], [true, true, false, false], "searches for the business by name are left out of the rules");
  // A night's rows: one search far below the usual click rate, one close to page 1, one page that dropped, the weekly check.
  const R = (source: string, win: string, level: string, item: string, item2: string, clicks: number, impressions: number, position: number | null, extra: any = {}) => ({ source, win, level, item, item2, clicks, impressions, position, extra });
  const S = "https://theguyservicegroup.com";
  const night = [
    R("gsc", "28d", "total", "", "", 120, 15000, 9.1),
    R("gsc", "28d", "page_query", S + "/services/chimney-sweep-sydney/", "chimney sweep sydney", 2, 900, 1.7),
    R("gsc", "28d", "page_query", S + "/services/air-conditioning-cleaning/", "aircon cleaning sydney", 3, 2000, 2.1),
    R("gsc", "28d", "page_query", S + "/services/pressure-washing-sydney/", "pressure washing sydney", 1, 450, 12.4),
    R("gsc", "28d", "page_query", S + "/services/pressure-washing-sydney/", "driveway cleaning", 0, 60, 11),
    R("gsc", "28d", "page_query", S + "/", "the guys service group", 1, 300, 1.2),
    R("gsc", "28d", "page", S + "/services/chimney-cleaning/", "", 7, 1099, 11.5),
    R("gsc", "prev28d", "page", S + "/services/chimney-cleaning/", "", 25, 1300, 8.2),
    R("gsc", "prev28d", "page", S + "/services/fireplace-cleaning-sydney/", "", 22, 400, 9),
    R("serp", "2026-10-12", "localpack", "aircon cleaning sydney", "Parramatta", 0, 0, 1),
    R("serp", "2026-10-19", "localpack", "aircon cleaning sydney", "Parramatta", 0, 0, 3),
    R("serp", "2026-10-19", "localpack", "aircon cleaning sydney", "Sydney CBD", 0, 0, 1),
    R("serp", "2026-10-19", "localpack", "ducted aircon cleaning sydney", "Bondi Junction", 0, 0, null),
    R("serp", "2026-10-19", "reviews", "The AC Cleaning Guys", "us", 104, 0, 5, { newestDays: 22, thisWeek: 0 }),
    R("serp", "2026-10-19", "aimode", "aircon cleaning sydney", "", 0, 2, null, { named: ["A Grade"] }),
    R("serp", "2026-10-19", "aimode", "split system cleaning sydney", "", 1, 2, null, { named: [] }) ];
  const F = organicFindings(night as any);
  eq(F.findings.map((f) => [f.issue_type, f.priority, f.dedupe_key]), [
    ["ctr", "P1", "ctr|/services/air-conditioning-cleaning/|aircon cleaning sydney"],
    ["ctr", "P1", "ctr|/services/chimney-sweep-sydney/|chimney sweep sydney"],
    ["near", "P1", "near|/services/pressure-washing-sydney/|pressure washing sydney"],
    ["drop", "P1", "drop|/services/chimney-cleaning/"],
    ["drop", "P1", "drop|/services/fireplace-cleaning-sydney/"],
    ["map", "P1", "map|aircon cleaning sydney|parramatta"],
    ["map", "P1", "map|ducted aircon cleaning sydney|bondi junction"],
    ["reviews", "P0", "reviews|stale"],
    ["ai", "P2", "ai|aircon cleaning sydney"],
  ], "the nightly rules: low click rate for the position, close to page 1, dropped pages, map pack, reviews, AI Mode (brand and small searches left out)");
  const gbp = F.findings.find((f) => f.dedupe_key.startsWith("ctr|/services/air-conditioning-cleaning/"))!;
  eq([!!(gbp.evidence as any).note, (F.findings.find((f) => f.issue_type === "drop")!.evidence as any).why], [true, "its average position fell from 8.2 to 11.5"], "the map-linked page carries its caveat; a drop says why");
  eq(F.findings.find((f) => f.issue_type === "map" && f.query === "aircon cleaning sydney")!.title, `#3 in the map pack for "aircon cleaning sydney" in Parramatta (was #1)`, "a fall in the map pack says where it was");
  eq(F.evaluated, ["ctr", "near", "drop", "map", "reviews", "ai"], "the rules that had data tonight");
  eq(organicFindings([R("serp", "2026-10-19", "localpack", "aircon cleaning sydney", "Sydney CBD", 0, 0, 1)] as any).evaluated, ["map"], "no Search Console data: those rules are not run");
  // The list: new ones added, open ones refreshed, done / not relevant left alone, solved-by-themselves reopened, gone ones solved.
  const ex = [
    { id: 1, source: "nightly", dedupe_key: "reviews|stale", issue_type: "reviews", status: "open" },
    { id: 2, source: "nightly", dedupe_key: "drop|/services/chimney-cleaning/", issue_type: "drop", status: "done" },
    { id: 3, source: "nightly", dedupe_key: "ai|aircon cleaning sydney", issue_type: "ai", status: "resolved" },
    { id: 4, source: "nightly", dedupe_key: "near|/old/|old search", issue_type: "near", status: "in_progress" },
    { id: 5, source: "nightly", dedupe_key: "map|x|y", issue_type: "map", status: "rejected" },
    { id: 6, source: "seo_chat", dedupe_key: "ctr|/services/chimney-sweep-sydney/|chimney sweep sydney", issue_type: "ctr", status: "open" },
    { id: 7, source: "nightly", dedupe_key: "gbp|posts", issue_type: "gbp", status: "open" } ];
  const SY = syncSuggestions(F.findings, ex, F.evaluated, "2026-10-20T08:00:00.000Z");
  eq([SY.inserts.map((i) => i.dedupe_key).length, SY.updates.map((u) => [u.id, (u as any).status || "same"]), SY.resolves.map((r) => [r.id, r.status])],
    [5, [[1, "same"], [3, "open"]], [[4, "resolved"]]], "sync: 5 new (the SEO chat's same issue is not copied), open refreshed, solved-itself reopened, done/rejected untouched, a gone one solved, an unrun rule left alone");
  eq(SY.inserts[0].status + "|" + SY.inserts[0].source, "open|nightly", "a new nightly suggestion starts open");
  // The digest the assessment is written from.
  const lines = organicDigest([...night, R("gsc", "7d", "total", "", "", 30, 3800, 9.5, { start: "2026-10-04", end: "2026-10-10" }), R("ga4", "28d", "channel", "Organic Search", "", 415, 0, null, { keyEvents: 45 }), R("ga4", "28d", "channel", "AI Assistant", "", 8, 0, null, {})] as any,
    [{ id: "a", day: "2026-10-12", source: "Organic", sub_source: "" }, { id: "b", day: "2026-10-01", source: "Google Maps", sub_source: "Aircon profile" }, { id: "c", day: "2026-08-30", source: "Organic", sub_source: "" }],
    { b: { jobs: 1, revenue: 349 } }, [{ priority: "P2", status: "open", title: "AI" }, { priority: "P0", status: "in_progress", title: "Reviews" }], null, "2026-10-12");
  const has = (part: string) => lines.some((l) => l.includes(part));
  eq([has("last 7 days (2026-10-04..2026-10-10): clicks 30, shown 3800 times, click rate 0.8%, average position 9.5"), has("Organic Search 415 visits (45 key actions), AI Assistant 8"),
    has("last 7 days (2026-10-06..2026-10-12): 1 leads (Organic web 1, Google Maps 0), 0 jobs"), has("last 28 days (2026-09-15..2026-10-12): 2 leads (Organic web 1, Google Maps 1: Aircon profile 1), 1 jobs so far, $349"),
    has("the 28 days before (2026-08-18..2026-09-14): 1 leads (Organic web 1, Google Maps 0), 0 jobs so far, $0 revenue before GST [Organic web NOT reliable"),
    has(`"aircon cleaning sydney" in Parramatta: #3 (week before: #1)`), has(`"ducted aircon cleaning sydney" in Bondi Junction: not in the pack (week before: not checked)`), has("REVIEWS (aircon profile): 104 reviews, rating 5, 0 new this week, newest 22 days old"),
    lines.findIndex((l) => l.includes("P0 [being worked on] Reviews")) < lines.findIndex((l) => l.includes("P2 AI")), has("PREVIOUS ORGANIC ASSESSMENT: none")],
    [true, true, true, true, true, true, true, true, true, true], "the digest: search, visits, leads by window (the old window flagged), map pack vs the week before, reviews, suggestions by priority");

  console.log(`ingest-ads-stats: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
