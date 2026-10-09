// ingest-ads-stats: receives keyword / search-term / ad / campaign / segment stats (Google Ads) and
// ad-level stats (Meta) from the cloud routine and REPLACES the stored snapshot for each
// (platform, account, win, level) in public.ads_stats. Same auth model as ingest-ad-spend / ingest-ad-calls:
// the Supabase gateway needs the publishable key, and this function checks the shared X-Intake-Secret.
// Since 9 Oct it also takes Google's conversion settings and conversions per action (conv_setting / conv_action, for
// the Tracking problems list), hands the nightly routine the real leads (realLeads), and checks the lead emails in
// info@ against the CRM (leadEmails), saved per day in lead_email_checks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INTAKE_SECRET = Deno.env.get("INTAKE_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const LEVELS = new Set(["campaign", "keyword", "search_term", "ad", "hour", "dow", "device", "geo", "adset", "placement", "conv_setting", "conv_action"]);

// --- lead email check (pure) ---
// Every website form and chat also sends an email to info@. The nightly routine reads those emails and sends them
// here; each one is matched to a CRM card by phone or email, so a lead that reached the inbox but not the app shows
// up the next morning. A repeat enquiry matches the customer's existing card (intake adds it there), which is right.
const sydneyDay = (ts: string | number | Date) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const decodeHtml = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The last 9 digits of an Australian number, so 0412 345 678, +61412345678 and 61412345678 are the same person.
function phoneKey(s: unknown): string {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("61") && d.length === 11) d = "0" + d.slice(2);
  return d.length >= 9 ? d.slice(-9) : "";
}
const PHONE_RE = /(?<!\d)(?:\+?61[\s-]?|0)[2-478](?:[\s-]?\d){8}(?!\d)/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function parseLeadEmail(e: any) {
  const subject = decodeHtml(String(e?.subject || "")).trim();
  const text = decodeHtml(String(e?.body || e?.snippet || "")).replace(/\s+/g, " ").trim();
  const email = (text.match(EMAIL_RE) || []).find((x) => !/@theguyservicegroup\.com$/i.test(x)) || "";
  const phone = ((text.match(PHONE_RE) || subject.match(PHONE_RE)) || [""])[0].trim();
  const field = (k: string) => { const m = text.match(new RegExp("\\b" + k + ":\\s*([^\\s:]+)(?=\\s|$)", "i")); return m ? m[1] : ""; };
  const src = field("utm_source").toLowerCase(), medium = field("utm_medium").toLowerCase();
  let name = (text.match(/Name:\s*(.+?)\s+(?:Phone|Email|Suburb|Post ?code|Message)\b/i) || [])[1] || "";
  if (!name) { const cut = text.search(/[A-Z0-9._%+-]+@|(?<!\d)(?:\+?61|0)[2-478]\d/i); name = cut > 0 ? text.slice(0, cut) : ""; }
  name = name.trim().slice(0, 80);
  const google = src.includes("google") || /\b(?:gclid|gbraid|wbraid)\s*:\s*[A-Za-z0-9_-]{10,}/i.test(text) || /\bgad_source\s*:\s*\d/i.test(text);
  const meta = /^(?:fb|ig|facebook|instagram|meta)$/.test(src) && /paid|cpc/.test(medium);
  // The ads agency's test forms (and the business's own 1300 number) are not leads.
  const test = /@searchrescue\.com\.au$/i.test(email) || email.toLowerCase() === "heythere@gmail.com" || /^test\b/i.test(name) ||
    (!phone && /(?<!\d)1[38]00[\s-]?\d{3}[\s-]?\d{3}(?!\d)/.test(subject + " " + text));
  return { subject, name, phone, phoneKey: phoneKey(phone), email, kind: /chat/i.test(subject) ? "chat" : "form", hint: google ? "Google Ads" : meta ? "Meta Ads" : "", test };
}
// emails: [{ id, date, subject, sender?, snippet, body? }] from the routine; contacts: CRM cards, newest first; today: Sydney
// day (today's emails are left for tomorrow night, when the day is complete); from: the first day the routine read in full
// (days before it are left alone, so a partly-read day never replaces a complete one). Replies and forwards in the same
// thread, and mail not sent by the website forms (info@) or the chat (apptbot), are not lead emails. One summary per day.
function checkLeadEmails(emails: any[], contacts: any[], today: string, from = "") {
  const byPhone = new Map<string, any>(), byEmail = new Map<string, any>();
  for (const c of contacts) {
    const k = phoneKey(c.phone); if (k && !byPhone.has(k)) byPhone.set(k, c);
    const em = String(c.email || "").trim().toLowerCase(); if (em && !byEmail.has(em)) byEmail.set(em, c);
  }
  const days = new Map<string, any>(), needBody: string[] = [], seen = new Set<string>();
  for (const e of emails) {
    const id = String(e?.id || ""); if (!id || seen.has(id)) continue; seen.add(id);
    const at = new Date(e.date); if (isNaN(at.getTime())) continue;
    const day = sydneyDay(at); if (day >= today || (from && day < from)) continue;
    if (/^\s*(?:re|fwd?|aw)\s*:/i.test(String(e.subject || ""))) continue;
    if (e.sender && !/info@theguyservicegroup\.com|apptbot\.ai/i.test(String(e.sender))) continue;
    const p = parseLeadEmail(e);
    const d = days.get(day) || { day, emails: 0, matched: 0, missing: [], tests: [], mismatch: [], google_emails: 0, google_matched: 0 };
    days.set(day, d);
    const item = { id, at: at.toISOString(), subject: p.subject.slice(0, 120), name: p.name, phone: p.phone, email: p.email, kind: p.kind, hint: p.hint };
    if (p.test) { d.tests.push(item); continue; }
    d.emails++;
    if (!p.phoneKey && !p.email) {   // nothing to match on: ask for the full email; until then it counts as missing
      if (!e.body) needBody.push(id);
      d.missing.push({ ...item, unreadable: true });
      continue;
    }
    const c = (p.phoneKey && byPhone.get(p.phoneKey)) || (p.email && byEmail.get(p.email.toLowerCase())) || null;
    const isGoogle = c ? c.source === "Google Ads" : p.hint === "Google Ads";
    if (isGoogle) d.google_emails++;
    if (!c) { d.missing.push(item); continue; }
    d.matched++;
    if (isGoogle) d.google_matched++;
    // The email names the ad it came from but the card says otherwise (only for a card made that day, not an old customer).
    if (p.hint && c.source !== p.hint && String(c.created_at || "").slice(0, 10) >= day) d.mismatch.push({ ...item, contact_id: c.id, app_source: c.source || "" });
  }
  return { days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), need_body: needBody };
}
// --- end lead email check ---

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const provided = req.headers.get("x-intake-secret") || "";
  if (!INTAKE_SECRET || provided !== INTAKE_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  // Keyword -> job attribution (30 Sep). The nightly Google routine asks which leads carry a Google click id (gclid)
  // that is not matched yet (pendingGclids), looks each up in Google Ads click_view (clicks are kept ~90 days), and
  // sends back campaign / ad group / keyword (clickAttribution), saved in gads_click_attribution.
  if (body && body.pendingGclids) {
    const sbp = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const since = new Date(Date.now() - 85 * 86400000).toISOString().slice(0, 10);
    const cq = await sbp.from("contacts").select("gclid, created_at").not("gclid", "is", null).neq("gclid", "").gte("created_at", since);
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const dq = await sbp.from("gads_click_attribution").select("gclid");
    if (dq.error) return json({ ok: false, error: "attribution failed: " + dq.error.message }, 500);
    const have = new Set((dq.data || []).map((r: any) => r.gclid));
    const pending = (cq.data || []).filter((c: any) => c.gclid && !have.has(c.gclid)).map((c: any) => ({ gclid: c.gclid, lead_date: String(c.created_at).slice(0, 10) }));
    return json({ ok: true, pending });
  }
  if (body && Array.isArray(body.clickAttribution)) {
    const txt = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, 300));
    const rows = body.clickAttribution.filter((r: any) => r && typeof r.gclid === "string" && r.gclid.length > 10).slice(0, 2000).map((r: any) => ({
      gclid: r.gclid,
      account: txt(r.account) || "6569440597",
      click_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.click_date || "")) ? r.click_date : null,
      network: txt(r.network), campaign: txt(r.campaign), ad_group: txt(r.ad_group), keyword: txt(r.keyword), match_type: txt(r.match_type),
      looked_up_at: new Date().toISOString(),
    }));
    if (!rows.length) return json({ ok: true, saved: 0 });
    const sba = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const up = await sba.from("gads_click_attribution").upsert(rows, { onConflict: "gclid" });
    if (up.error) return json({ ok: false, error: up.error.message }, 500);
    return json({ ok: true, saved: rows.length });
  }
  if (body && body.crmDigest) {
    // Read-only digest of Meta-sourced CRM leads per ad set (utm_content) for the nightly Meta assessment.
    const end = String(body.crmDigest.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return json({ ok: false, error: "invalid end" }, 400);
    const sbd = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const sinceIso = new Date(Date.now() - 110 * 86400000).toISOString();
    const cq = await sbd.from("contacts").select("id,created_at,source,utm_source,utm_content,fbclid").gte("created_at", sinceIso).limit(5000);
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const sydDay = (ts: string) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
    // One definition everywhere (app Dashboard, Meta board, this digest): a Meta lead is a lead whose source is Meta Ads.
    // An fbclid alone isn't enough — it also comes with organic Facebook shares.
    const isMeta = (c: any) => c.source === "Meta Ads";
    const leads = (cq.data || []).filter(isMeta).map((c: any) => ({ id: c.id, day: sydDay(c.created_at), adset: c.utm_content || "" }));
    const ids = leads.map((l: any) => l.id);
    const jq = ids.length ? await sbd.from("jobs").select("contact_id,amount").in("contact_id", ids) : { data: [], error: null };
    const rev: Record<string, { jobs: number; revenue: number }> = {};
    for (const j of (jq.data || []) as any[]) { const r = (rev[j.contact_id] ||= { jobs: 0, revenue: 0 }); r.jobs++; r.revenue += Number(j.amount) || 0; }
    const out: Record<string, any> = {};
    for (const [w, n] of [["7d", 7], ["14d", 14], ["30d", 30], ["60d", 60], ["90d", 90]] as [string, number][]) {
      const endD = new Date(end + "T00:00:00Z"); const startD = new Date(endD.getTime() - (n - 1) * 86400000);
      const start = startD.toISOString().slice(0, 10);
      const inW = leads.filter((l: any) => l.day >= start && l.day <= end);
      const per: Record<string, any> = {};
      for (const l of inW) { const k = l.adset || "(no ad set tag)"; const p = (per[k] ||= { leads: 0, jobs: 0, revenue: 0 }); p.leads++; const r = rev[l.id]; if (r) { p.jobs += r.jobs; p.revenue += r.revenue; } }
      out[w] = { start, end, crm_leads: inW.length, per_adset: per };
    }
    return json({ ok: true, crm: out });
  }
  if (body && body.insight) {
    const ins = body.insight;
    const p = String(body.platform || "");
    if (!["google", "meta"].includes(p)) return json({ ok: false, error: "invalid platform" }, 400);
    const day = String(ins.day || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, error: "invalid insight day" }, 400);
    const sbi = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    // basis "real" (since 9 Oct): the Google assessment is written from the real leads, not Google's conversion count.
    const up = await sbi.from("ads_insights").upsert({ platform: p, account: String(body.account || ""), day, summary: String(ins.summary || ""), points: Array.isArray(ins.points) ? ins.points : [], ...(ins.basis === "real" ? { basis: "real" } : {}) }, { onConflict: "platform,account,day" });
    if (up.error) return json({ ok: false, error: "insight failed: " + up.error.message }, 500);
    return json({ ok: true, insight: true });
  }
  // The real leads (CRM forms and chats from Google clicks, Google ad calls of a minute or more) per window, kind and
  // campaign, plus the last week of lead email checks: what the nightly Google assessment is written from.
  if (body && body.realLeads) {
    const sbr = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const rq = await sbr.from("gads_real_leads").select("win,kind,campaign,n");
    if (rq.error) return json({ ok: false, error: "real leads failed: " + rq.error.message }, 500);
    const kq = await sbr.from("lead_email_checks").select("day,emails,matched,missing,mismatch,google_emails,google_matched").order("day", { ascending: false }).limit(7);
    if (kq.error) return json({ ok: false, error: "lead checks failed: " + kq.error.message }, 500);
    return json({ ok: true, real: rq.data || [], checks: kq.data || [] });
  }
  if (body && body.leadEmails) {
    const list = Array.isArray(body.leadEmails.emails) ? body.leadEmails.emails.slice(0, 500) : null;
    if (!list) return json({ ok: false, error: "invalid leadEmails.emails: expected an array" }, 400);
    const sbl = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
    const cq = await sbl.from("contacts").select("id,phone,email,source,created_at").order("created_at", { ascending: false }).limit(20000);
    if (cq.error) return json({ ok: false, error: "contacts failed: " + cq.error.message }, 500);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(body.leadEmails.from || "")) ? String(body.leadEmails.from) : "";
    const res = checkLeadEmails(list, cq.data || [], sydneyDay(Date.now()), from);
    if (res.days.length) {
      const now = new Date().toISOString();
      const up = await sbl.from("lead_email_checks").upsert(res.days.map((d: any) => ({ ...d, checked_at: now })), { onConflict: "day" });
      if (up.error) return json({ ok: false, error: "lead checks failed: " + up.error.message }, 500);
    }
    return json({ ok: true, saved: res.days.length, need_body: res.need_body,
      days: res.days.map((d: any) => ({ day: d.day, emails: d.emails, matched: d.matched, tests: d.tests.length, google_emails: d.google_emails, google_matched: d.google_matched,
        missing: d.missing.map((m: any) => `${m.name || "(no name)"} ${m.phone || m.email || ""}${m.unreadable ? " (details not readable)" : ""}`),
        source_differs: d.mismatch.map((m: any) => `${m.name}: email says ${m.hint}, app says ${m.app_source || "nothing"}`) })) });
  }
  const platform = String(body?.platform || "");
  const account = String(body?.account || "");
  const win = String(body?.win || "");
  const level = String(body?.level || "");
  const rowsIn = body?.rows;
  if (!["google", "meta"].includes(platform)) return json({ ok: false, error: "invalid platform" }, 400);
  if (!win || win.length > 12) return json({ ok: false, error: "invalid win" }, 400);
  if (!LEVELS.has(level)) return json({ ok: false, error: "invalid level" }, 400);
  if (!Array.isArray(rowsIn)) return json({ ok: false, error: "invalid rows: expected an array" }, 400);

  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const r of rowsIn) {
    const row = {
      platform, account, win, level,
      campaign: String(r?.campaign ?? ""), ad_group: String(r?.ad_group ?? ""),
      item: String(r?.item ?? ""), item2: String(r?.item2 ?? ""),
      impressions: Math.round(num(r?.impressions)), clicks: Math.round(num(r?.clicks)),
      cost: num(r?.cost), conversions: num(r?.conversions),
      extra: (r?.extra && typeof r.extra === "object") ? r.extra : {},
      updated_at: new Date().toISOString(),
    };
    const k = [row.campaign, row.ad_group, row.item, row.item2].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(row);
  }

  const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);
  const del = await sb.from("ads_stats").delete().eq("platform", platform).eq("account", account).eq("win", win).eq("level", level);
  if (del.error) return json({ ok: false, error: "delete failed: " + del.error.message }, 500);
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await sb.from("ads_stats").insert(rows.slice(i, i + 500));
    if (ins.error) return json({ ok: false, error: "insert failed: " + ins.error.message }, 500);
  }
  return json({ ok: true, rowsWritten: rows.length });
});
