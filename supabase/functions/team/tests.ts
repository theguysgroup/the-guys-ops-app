// Tests for team/index.ts. Run: bash supabase/functions/team/run_tests.sh
// deno-lint-ignore-file no-explicit-any
let pass = 0, fail = 0;
function eq(got: any, want: any, name: string) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); } }
function fakeSb(seed: { users: any[]; profiles: any[]; settings?: any[] }) {
  const T: any = { profiles: seed.profiles, settings: seed.settings || [{ id: 1, catalog: {} }] };
  const users = seed.users;
  const calls: any[] = [];
  function from(table: string) {
    const filters: any[] = []; let op = "select", payload: any = null, single = false;
    const b: any = {
      select() { return b; }, insert(p: any) { op = "insert"; payload = p; return b; },
      eq(k: string, v: any) { filters.push((r: any) => r[k] === v); return b; }, single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (op === "insert") { if (T[table].some((r: any) => r.id === payload.id)) return { error: { message: "duplicate" } }; T[table].push({ ...payload }); return { error: null }; }
      const out = T[table].filter((r: any) => filters.every((f: any) => f(r)));
      return { data: single ? out[0] || null : out, error: null };
    }
    return b;
  }
  const admin = {
    listUsers: async () => ({ data: { users }, error: null }),
    generateLink: async (o: any) => { calls.push(["link", o.type, o.email]); let u = users.find((x) => x.email === o.email); if (!u) { u = { id: "new-" + users.length, email: o.email }; users.push(u); } return { data: { user: u, properties: { action_link: `https://example.test/verify?type=${o.type}` } }, error: null }; },
    deleteUser: async (id: string) => { calls.push(["delete", id]); return { error: null }; },
    updateUserById: async (id: string, o: any) => { calls.push(["ban", id, o.ban_duration]); return { error: null }; },
  };
  return { T, users, calls, from, auth: { admin } };
}
const OFEK = { id: "u-ofek", role: "owner", full_name: "Ofek" }, RON = { id: "u-ron", role: "va", full_name: "Ron" };
(async () => {
  const sb = fakeSb({
    users: [{ id: "u-ofek", email: "o@x.com", last_sign_in_at: "2026-10-12T00:00:00Z", email_confirmed_at: "2026-09-01" }, { id: "u-ron", email: "r@x.com", invited_at: "2026-10-01", email_confirmed_at: null }],
    profiles: [OFEK, RON],
    settings: [{ id: 1, catalog: { roles: { technician: { tasks: true, closings: true } } } }],
  });
  eq((await handle(sb, { step: "list" }, RON)).status, 403, "owners only");
  const l = await handle(sb, { step: "list" }, OFEK);
  eq(l.body.people.map((p: any) => [p.id, p.email, p.joined]), [["u-ofek", "o@x.com", true], ["u-ron", "r@x.com", false]], "list: email and whether each person has joined");
  eq((await handle(sb, { step: "invite", email: "bad", fullName: "X", role: "va" }, OFEK)).body.reason, "That email doesn't look right.", "invite: checks the email");
  eq((await handle(sb, { step: "invite", email: "r@x.com", fullName: "Ron 2", role: "va" }, OFEK)).status, 409, "invite: an email that already has an account");
  eq((await handle(sb, { step: "invite", email: "g@x.com", fullName: "Guy", role: "owner" }, OFEK)).status, 400, "invite: an owner can't be invited from the app");
  const inv = await handle(sb, { step: "invite", email: " G@X.com ", fullName: "Guy Galili", role: "technician", technicianName: "Guy" }, OFEK);
  const prof = sb.T.profiles.find((p: any) => p.full_name === "Guy Galili");
  const P = (on: string[]) => Object.fromEntries(PAGES.map((k) => [k, on.includes(k)]));
  // A technician's profile also gets finance: true (not a page), which their own jobs and rates need in the database.
  const TP = (on: string[]) => ({ ...P(on), finance: true });
  eq([inv.status, !!inv.body.link, prof.role, prof.technician_name, prof.permissions, inv.body.permissions], [200, true, "technician", "Guy", TP(["closings", "tasks"]), TP(["closings", "tasks"])], "invite: account + profile with the technician's saved Role defaults (every page named, the rest off), and a link to join");
  eq((await handle(sb, { step: "link", id: "u-ron" }, OFEK)).body.kind, "join", "link: someone who hasn't joined gets a link to join");
  eq((await handle(sb, { step: "link", id: "u-ofek" }, OFEK)).body.kind, "password", "link: someone who has joined gets a new-password link");
  eq((await handle(sb, { step: "access", id: "u-ofek", on: false }, OFEK)).status, 400, "access: not your own");
  const off = await handle(sb, { step: "access", id: "u-ron", on: false }, OFEK);
  eq([off.body.accessOff, sb.calls.find((c: any) => c[0] === "ban")], [true, ["ban", "u-ron", "87600h"]], "access: switched off (their profile and history stay)");
  // P9 (Ofek 14 Oct): with nothing saved in Role defaults, a new person gets the app's built-in pages, never none.
  const sb2 = fakeSb({ users: [{ id: "u-ofek", email: "o@x.com" }], profiles: [OFEK], settings: [{ id: 1, catalog: {} }] });
  const pagesOf = async (email: string, role: string, extra: any = {}) => { const r = await handle(sb2, { step: "invite", email, fullName: email, role, ...extra }, OFEK); const p = sb2.T.profiles.find((x: any) => x.full_name === email); return [r.status, p && p.permissions, r.body.permissions]; };
  const tech = await pagesOf("t@x.com", "technician");
  eq([tech[0], tech[1], tech[2]], [200, TP(["payroll", "reminders", "tasks"]), TP(["payroll", "reminders", "tasks"])], "invite: a technician with nothing saved gets payroll, reminders and tasks (the app's defaults), and finance for their own pay");
  eq([tech[1].finance, "finance" in ((await pagesOf("v0@x.com", "va"))[1] as any), "finance" in ((await pagesOf("m0@x.com", "marketing"))[1] as any)], [true, false, false], "invite: only a technician gets finance (their pay page reads their jobs and rates through it)");
  eq((await pagesOf("m@x.com", "marketing"))[1], P(["adsGoogle"]), "invite: marketing with nothing saved gets the Google Ads board only (it used to get no page at all)");
  eq((await pagesOf("v@x.com", "va"))[1], P(["crm", "closings", "jobs", "payroll", "outstanding", "reminders", "openItems", "tasks", "reference"]), "invite: an office assistant with nothing saved gets the app's VA pages");
  const sb3 = fakeSb({ users: [], profiles: [OFEK], settings: [{ id: 1, catalog: { roles: { technician: {}, va: { crm: true } } } }] });
  await handle(sb3, { step: "invite", email: "t2@x.com", fullName: "T2", role: "technician" }, OFEK);
  await handle(sb3, { step: "invite", email: "v2@x.com", fullName: "V2", role: "va" }, OFEK);
  eq(sb3.T.profiles.filter((p: any) => p.full_name !== "Ofek").map((p: any) => p.permissions), [{ ...ROLE_DEFAULTS.technician, finance: true }, P(["crm"])], "invite: an empty saved role falls back to the defaults; a saved one wins");
  const mine = await pagesOf("c@x.com", "technician", { permissions: { crm: true, settings: true, bogus: true } });
  eq([mine[1], mine[2], "settings" in mine[1], "bogus" in mine[1]], [TP(["crm"]), TP(["crm"]), false, false], "invite: the pages ticked for this person win; Settings and unknown pages are never given");
  eq([(await pagesOf("x1@x.com", "technician", { permissions: "x" }))[1], (await pagesOf("x2@x.com", "technician", { permissions: {} }))[1]], [{ ...ROLE_DEFAULTS.technician, finance: true }, { ...ROLE_DEFAULTS.technician, finance: true }], "invite: pages that aren't a page map fall back to the role's");
  eq((await pagesOf("x3@x.com", "technician", { permissions: { payroll: true, finance: false } }))[1], TP(["payroll"]), "invite: a technician's finance can't be switched off from the invite (it is not a page)");
  eq([newProfilePermissions({}, "technician", { crm: true }), newProfilePermissions({}, "manager"), newProfilePermissions({}, "va", { finance: true, crm: true })], [TP(["crm"]), ROLE_DEFAULTS.manager, P(["crm"])], "newProfilePermissions: the pages, plus finance for a technician only");
  eq((await pagesOf("mg@x.com", "manager", { permissions: { crm: false } }))[1], ROLE_DEFAULTS.manager, "invite: a manager's pages can't be changed per person");
  eq([cleanPages(null), cleanPages([1]), Object.keys(cleanPages({ crm: 1 })!).length, cleanPages({ crm: 1 })!.crm, rolePages(null, "marketing"), rolePages({ roles: { marketing: { tasks: true } } }, "marketing", { nope: true }), rolePages({}, "nobody")],
    [null, null, 11, true, ROLE_DEFAULTS.marketing, P(["tasks"]), P([])], "cleanPages / rolePages: maps only, saved roles, an unknown role gets no page");
  eq([PAGES.length, Object.keys(ROLE_DEFAULTS).sort(), Object.values(ROLE_DEFAULTS).every((m) => JSON.stringify(Object.keys(m)) === JSON.stringify(PAGES))], [11, ["manager", "marketing", "technician", "va"], true], "role defaults: every role names all 11 pages, in order");
  console.log(`team: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
