# To Tomer's Claude, from Ofek's Claude: FULL HANDOFF (16 Oct 2026, morning)

## Why this file
- **My limit:** my weekly Claude usage is used up (resets Wed 21 Oct 06:00 Sydney).
- **Ofek's instruction:** your Claude finishes **ALL** the remaining work.
- **I still deploy:** I keep **every live deploy**, after my own checks.
- **What you send:** never deploy to live. Send me results (PR + head sha + check results + staging verification) by email in this thread, and I review and deploy as soon as I have capacity again.

All earlier rules still hold:
- Hebrew to Ofek;
- never message customers; customer automations are created Draft/OFF;
- no secrets (Ofek creates them);
- SaaS: everything configurable, `business_id` + RLS on new tables;
- staging only.

Attached:
- `stage2-design.md`, the binding design for stage 2;
- `ghl-account-scan.md` and `ghl-public-research.md`, GHL research for exact labels;
- `stage2-phase4-findings.md`, review findings still to fix.

## 1. Status: about 52% of the whole project
**Live (`main` a8c6d2d):**
- stage 1 (settings + SaaS basics, any time zone);
- stage 5 (private connector) + its 5 follow-ups;
- stage 3 (On vacation).

**Reviewed, waiting for my deploy:**
- **PR #3, stage 4 (2950477):** the re-review is CLEAN. I still owe it a live-origin browser check, then a fast-forward merge.

**Your open PRs that need fixes** (see my email of 16 Oct ~06:20 in this thread):
- **PR #5 (stage-3 follow-ups):** blocking A1, data loss when the notes load fails. Also: `lock_timeout`, drop part B step 8, `Number()` in `vacBackDay`.
- **PR #4 (stage 6 Cobra):** B1 banned users, B3 roles default-deny, B6 `context.page` short id. Then note B2/B4/B5/D1/D3/D6 in the PR.
- **Rebase:** if PR #3 is not on `main` yet when you rebase, stack the branches: PR #5 on top of PR #3's head, and PR #4 on top of PR #5. Then I merge in that order.

**Built but NOT live, now yours to finish:** stage 2 (automations), branch `stage2-automations` on origin (I'm pushing it now). Its history:
- phases 1–3 committed and fully reviewed (engine v2, event store, nodes, API, migration adapter, Automation page, Q5/Q6, quiet imports, SQL Parts 1–3 + RUNBOOK);
- main a8c6d2d merged in (engine v2 carries your quiet imports + vacations);
- **phase 4 (Standard builder)** as a WIP commit: builds G4.1–G4.4 are done, the review found 35 items (32 confirmed), and the fixes were in progress (customer-safety lens first).

## 2. What remains, in this order
1. **Your PR fixes** (PR #5 A1 etc., PR #4 B1/B3/B6) and the rebase stack. Email me the shas.
2. **Stage 8, the general assistant** (as planned; it reuses the stage-5 role block in `ai-gateway`).
3. **Stage 2, finish phase 4:**
   - Fix every item in `stage2-phase4-findings.md` (verify first; skip only with proof).
   - The offline differential (`supabase/functions/automations/differential/run.sh`) must stay IDENTICAL.
   - Run the app diff against the phase-3 commit (67c4240 + merge 59238c1) for every builder path: open / save no-op / edit round trip / publish refusals (the 14 old-editor problem shapes must stay refused) / duplicate / the old editor still reachable.
4. **Stage 2, phases 5–7** exactly per `stage2-design.md` §7:
   - **Phase 5:** Advanced builder.
   - **Phase 6:** history, logs, path, stats, versions, Test workflow (dry run), manual add (owners + managers only, Q2), error alerts (phone push at most once a day, Q7; flip `WF_FEATURES.errorDigest` when the digest sends).
   - **Phase 7:** cleanup + the first System moves.
   - **§10 holds:** Ofek's answers (Q1–Q7).
   - **Also:**
     - register the builder's layers and leave guard with stage 4's `NAV_LAYERS` / `NAV_LEAVERS` / `NAV_RESTORERS` once stage 4 is on `main` (the builder has one adapter for this, `wfNavHooks`; wire it there);
     - the lead "Assigned to" picker must grey people on vacation like the other pickers.
5. **Stage 7, Workflow AI** (after stage 6 and stage 2 phase 4+):
   - **Decided:**
     - "Build" mode: a description becomes workflow JSON for the stage-2 schema (the registries go in as cached context), validated server-side and saved as a DRAFT only, never published or enabled.
     - The canvas shows it, and the AI explains it in the user's language.
     - "Edit this workflow" (a diff applied to the draft after Confirm) and "Describe this workflow" (mostly deterministic text).
     - Greyed/unavailable actions are never generated.
     - Entry points: the floating button on the automations board, "Build using AI" on the Workflows list, and the left-rail Workflow AI (⇧A).
   - **Provider order** as decided on 15 Oct: own key → business paid (switch + cap > 0) → Cloudflare free → mock.
   - **Plug in through your gateway hooks** (`registerMode` / `registerTool` / `cobraOpen` / `COBRA_CARDS`, escape the HTML).
   - **Limits:**
     - context ≤ 4 KB (send the workflow id, not the JSON);
     - free-AI tool result ≤ 8k chars and chat ≤ 16k tokens;
     - 5 tool steps; 3 proposals per turn.
   - **Drafts:** they need their own write path through the automations function's v2 `step: "save"` (never `publish`).
   - **Acceptance:** a 30-prompt Hebrew/English eval set passes on the free model if possible, and you report quality honestly.

## 3. How to work (lessons from this week)
- **check_all is slow.** It now takes **over 10 minutes**. Agent/workflow watchdogs kill a tool call that is silent for ~3 minutes, so run the suites one by one (business-logic, read-only, each function's `run_tests.sh`; the automations one includes the differential at ~2 min).
- **Main is truth.** Stage 2 lives on `stage2-automations`. Merge `main` into it before each phase, and keep both sides' behaviour.
- **SQL:**
  - idempotent sections with checks before/after and an exact ROLLBACK;
  - `set local lock_timeout = '5s'` after `begin`;
  - never on live (I run it).
- **Functions:**
  - fingerprints of the deployed code matter: tell me the commit to deploy from;
  - Verify JWT: automations / push / voice / mcp OFF, ai-gateway ON.
- **For every PR, send me:**
  - head sha;
  - the check tails;
  - the differential result;
  - the staging browser check (0 idle renders, no console errors, 375 px);
  - the deploy order;
  - the SQL to run;
  - open questions for Ofek (multiple choice, Hebrew, through Tomer).

## 4. Where things are
- **Repo:** `theguysgroup/the-guys-ops-app` (public; never commit business names, customer data or secrets).
- **Branches:** `main` (live), `stage2-automations` (stage 2 WIP).
- **Your PRs:** #3, #4, #5. Open new ones per piece.
- **Staging:** wblsrpmjiqwuxmrmuklc ("Demo Home Services").
