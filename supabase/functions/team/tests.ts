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
  eq([inv.status, !!inv.body.link, prof.role, prof.technician_name, prof.permissions], [200, true, "technician", "Guy", { tasks: true, closings: true }], "invite: account + profile with the technician's pages from Settings, and a link to join");
  eq((await handle(sb, { step: "link", id: "u-ron" }, OFEK)).body.kind, "join", "link: someone who hasn't joined gets a link to join");
  eq((await handle(sb, { step: "link", id: "u-ofek" }, OFEK)).body.kind, "password", "link: someone who has joined gets a new-password link");
  eq((await handle(sb, { step: "access", id: "u-ofek", on: false }, OFEK)).status, 400, "access: not your own");
  const off = await handle(sb, { step: "access", id: "u-ron", on: false }, OFEK);
  eq([off.body.accessOff, sb.calls.find((c: any) => c[0] === "ban")], [true, ["ban", "u-ron", "87600h"]], "access: switched off (their profile and history stay)");
  console.log(`team: ${pass} passed, ${fail} failed`);
  if (fail) (globalThis as any).process?.exit(1);
})();
