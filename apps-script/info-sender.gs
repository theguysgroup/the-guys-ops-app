// Jobs sheet → OPS app, and review-request emails — runs under info@theguyservicegroup.com (The Guys Service Group).
// Every 15 minutes:
//   1. sends every job in the last three week tabs to the OPS app, which keeps Jobs & Commissions in step with this
//      sheet (new invoices added, changed fields updated; nothing deleted) — added 2 Oct 2026;
//   2. sends the review-request emails the OPS app hands back, from this mailbox, as "The Guys Service Group"
//      (since 2 Oct the office asks for a review with a button on the job; the sheet no longer triggers it).
// Every minute: the email about each new website chat lead (sent from and to this mailbox) — added 3 Oct 2026.
// The OPS app only hands out emails to this account: it checks this script's Google identity with Google.
// Nothing goes to customers until sending is switched on in the OPS app.
const OPS_URL = 'https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/review-requests';
const OPS_KEY = 'sb_publishable_CYDF61njgAU74Dm3PvkLGQ_4N6qfvIi';   // the app's public key (the same one the website uses) — not a secret
const SHEET_ID = '1RPaB-b3NWaIbfEhL07fIte0UkWwQzHBMq1CV8fV98BQ';   // "the guys group - מעקב עבודות"
const SENDER_NAME = 'The Guys Service Group';

function recentJobs_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  // Week tabs are the ones whose first two headers are "date" and "name" (not the template or the Windsor project tab).
  const weekTabs = ss.getSheets().filter(function (sh) {
    const h = sh.getRange(1, 1, 1, 2).getDisplayValues()[0].map(function (x) { return String(x).trim().toLowerCase(); });
    return sh.getName() !== 'TEMPLATE' && h[0] === 'date' && h[1] === 'name';
  }).slice(-2);
  const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const rows = [];
  weekTabs.forEach(function (sh) {
    const range = sh.getDataRange();
    const values = range.getValues(), shown = range.getDisplayValues();
    const head = shown[0].map(function (x) { return String(x).trim().toLowerCase(); });
    const c = { date: head.indexOf('date'), name: head.indexOf('name'), invoice: head.indexOf('invoice'), type: head.indexOf('job type'), review: head.indexOf('review'), tech: head.indexOf('technician') };
    for (var i = 1; i < values.length; i++) {
      const d = values[i][c.date];
      if (!(d instanceof Date) || d < cutoff) continue;
      const invoice = String(shown[i][c.invoice] || '').trim(), name = String(shown[i][c.name] || '').trim();
      if (!invoice || !name) continue;
      rows.push({ date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), name: name, invoice: invoice, job_type: c.type < 0 ? '' : shown[i][c.type], technician: c.tech < 0 ? '' : shown[i][c.tech], review: c.review < 0 ? '' : shown[i][c.review] });
    }
  });
  return rows;
}

// Every job row (with a date, name and invoice) in the last three week tabs, with all the columns the app needs.
function sheetJobs_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const weekTabs = ss.getSheets().filter(function (sh) {
    const h = sh.getRange(1, 1, 1, 2).getDisplayValues()[0].map(function (x) { return String(x).trim().toLowerCase(); });
    return sh.getName() !== 'TEMPLATE' && h[0] === 'date' && h[1] === 'name';
  }).slice(-3);
  const jobs = [];
  weekTabs.forEach(function (sh) {
    const range = sh.getDataRange();
    const values = range.getValues(), shown = range.getDisplayValues();
    const head = shown[0].map(function (x) { return String(x).trim().toLowerCase(); });
    const col = function (k) { return head.indexOf(k); };
    const c = { date: col('date'), name: col('name'), invoice: col('invoice'), status: col('status'), method: col('payment method'), amount: col('amount'), gst: col('gst'), type: col('job type'), thc: col('thc%'), parts: col('parts'), review: col('review'), tech: col('technician') };
    const v = function (i, k) { return c[k] < 0 ? '' : values[i][c[k]]; };
    const t = function (i, k) { return c[k] < 0 ? '' : String(shown[i][c[k]] || '').trim(); };
    for (var i = 1; i < values.length; i++) {
      const d = values[i][c.date];
      if (!(d instanceof Date)) continue;
      const invoice = t(i, 'invoice'), name = t(i, 'name');
      if (!invoice || !name) continue;
      jobs.push({ date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), name: name, invoice: invoice, status: t(i, 'status'), payment_method: t(i, 'method'),
        amount: v(i, 'amount'), gst: v(i, 'gst'), job_type: t(i, 'type'), thc: v(i, 'thc'), parts: v(i, 'parts'), review: t(i, 'review'), technician: t(i, 'tech') });
    }
  });
  return jobs;
}

function callOps_(payload) {
  payload.id_token = ScriptApp.getIdentityToken();
  const res = UrlFetchApp.fetch(OPS_URL, { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + OPS_KEY, apikey: OPS_KEY }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : { emails: [] };
}

function sendReviewRequests() {
  const rows = recentJobs_(), jobs = sheetJobs_();
  const result = callOps_({ rows: rows, jobs: jobs });
  const j = result.jobs || {};
  console.log('sheet jobs sent: ' + jobs.length + ' (added ' + (j.inserted || 0) + ', updated ' + (j.updated || 0) + ', unchanged ' + (j.unchanged || 0) + ', first seen ' + (j.adopted || 0) + ') | verified as info@: ' + result.mailbox + ' | emails to send ' + (result.emails || []).length);
  const sent = [];
  (result.emails || []).forEach(function (m) {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, htmlBody: m.html, body: m.text, name: SENDER_NAME });
      sent.push(m.id);
    } catch (e) { console.error('Email to ' + m.to + ' failed: ' + e); }
  });
  if (sent.length) callOps_({ rows: [], email_sent: sent });
}

// New website chat → an email to this mailbox within a minute (the OPS app's "conversations" function writes it).
const CHAT_ALERTS_URL = 'https://dszlllazwmllmoklzjwl.supabase.co/functions/v1/conversations?step=alerts';
function sendChatAlerts() {
  const ask = function (sent) {
    const res = UrlFetchApp.fetch(CHAT_ALERTS_URL, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ id_token: ScriptApp.getIdentityToken(), sent: sent }), muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : { emails: [] };
  };
  const sent = [];
  (ask([]).emails || []).forEach(function (m) {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.text, name: SENDER_NAME });
      sent.push(m.id);
    } catch (e) { console.error('Chat email failed: ' + e); }
  });
  if (sent.length) ask(sent);
}

// Run once: sets the timers (15 minutes for jobs + review emails, 1 minute for chat emails) and removes older ones.
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendReviewRequests').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('sendChatAlerts').timeBased().everyMinutes(1).create();
}
