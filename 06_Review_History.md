# 2.6 Review History

**Status:** living document — append-only, newest entry first
**Parent:** `02_Architecture_Review_Standard/`
**Purpose:** a record of every completed architecture review across the ecosystem, so a pattern repeated across projects is visible instead of rediscovered each time

---

## How this document works

This is not a template to be copied per-project — it is the **one shared log**, ecosystem-wide. Each project keeps its own detailed review artifacts (findings, dispositions) in its own Governance layer; what's recorded here is a compact entry per completed review, sufficient to spot cross-project patterns without duplicating full detail.

**Entry schema:**

```
### [Date] — [Project] — [Scope] (Profile: [profile])
Reviewer:      [who]
Gate feeding:  [which Architecture Gate this review fed]
Findings:      [count by severity, e.g. "1 HIGH, 2 MEDIUM, 3 LOW"]
Dispositions:  [count by disposition, e.g. "4 confirmed+fixed, 2 already resolved, 1 rescoped-broader"]
Notable:       [one or two sentences — anything worth a future reviewer knowing before they hit something similar]
Full record:   [pointer to the project's own detailed findings, if not inlined here]
```

A new checklist item added to `02_Review_Checklist_Library.md` or a new pattern added to `08_Review_Knowledge_Base.md` should reference the entry here that motivated it.

---

## Entries

### 2026-07-11 — Productivity OS — Review #2 (Profile: Domain, project-declared enhanced subset: A5/B1/B2/C3)
Reviewer: Claude (single-project review, evidence-first — every claim checked against actual code/governance files before being raised, no assumption-based findings)
Gate feeding: Testing Gate (continuation of the same retroactive review as 2026-07-11 Review #1, scoped to the project's newly-declared deeper checklist)
Findings: 0 HIGH, 1 MEDIUM, 1 LOW
Dispositions: 2 confirmed, both left as tracked Roadmap follow-ups rather than fixed in-review (Review is not Rewrite — UEF `00_Review_Framework.md` §6)
Notable:
  - A5 (Event Flow) and B1 (Extensibility) both passed cleanly with strong evidence on first check — a reminder that not every checklist category run against a project will surface a finding, and reporting "passed, here's the evidence" is itself a complete and useful result, not a sign the review wasn't thorough enough.
  - The MEDIUM finding (a purpose-built bounded table, correctly maintained, never actually read by any query — the reads instead scan the full unbounded history table and filter in memory to the same result) is a distinct failure shape from anything in Review #1: the code isn't wrong or untested here, it's an already-built solution to a real problem that simply never got wired up to the queries that would benefit from it. Worth watching for elsewhere — a project can pass Layering and Separation of Concerns cleanly while a specific *Query Layer* choosing the wrong Read Model table (of several available and equally valid ones) slips through, because nothing about the layering itself is wrong.
  - Where a single function among several near-identical siblings had a written scale assumption ("this is fast enough for a typical personal task volume") and the rest had none, the presence of that one comment could have created a false impression that the pattern as a whole had been reasoned about — it hadn't; only one of nine call sites had.
Full record: project's own Governance layer (`00_Architecture_Review.gs`).

---

### 2026-07-11 — Productivity OS — Full-project review (Profile: Domain, minimum checklist subset)
Reviewer: Claude (single-project review, first UEF-profile review for this project — its prior 5 audit rounds predate UEF v1.0 and used an ad hoc process, not this framework's checklist)
Gate feeding: Testing Gate (pre-existing implementation, retroactive review — project already deployed and running V4.6 in production)
Findings: 0 HIGH, 2 MEDIUM, 1 LOW
Dispositions: 3 confirmed (1 MEDIUM — testing coverage gap — left open pending the project owner's choice between a dedicated test-writing session or an accepting-deferral ADR; the other MEDIUM — a stale Roadmap version header, two full version increments behind actual state — and the 1 LOW — two "won't fix" decisions argued inline but never filed as discrete ADR entries — were both corrected directly as documentation fixes within the review itself)
Notable:
  - A project can pass Separation of Concerns and Layering cleanly while having near-zero test coverage — these are independent health axes; clean layering is not evidence that testing exists, and a reviewer should check both explicitly rather than let one stand in for the other.
  - A "won't fix" decision argued only inside a file header or a sibling governance doc (not filed as a discrete ADR entry) reads as a gap the moment someone checks the ADR log specifically for the full decision list — even when the underlying reasoning was never actually missing, only mis-filed. This is the origin case suggesting Checklist Library item D1 should treat "argued but unfiled" as its own sub-case, distinct from "no reasoning exists at all."
  - Version-header drift (a file's own header claiming an older version than its actual content reflects) showed up three times independently in the same project (Roadmap, ADR, File Map) once actually checked against the project's real changelog rather than trusted at face value — suggesting this class of drift is worth a dedicated Checklist Library / Review Knowledge Base entry rather than treating each instance as a one-off.
Full record: project's own Governance layer (`00_Architecture_Review.gs`).

---

### 2026-07-10 — Investment OS — Full-codebase audit follow-up (Profile: Domain, with Service/Connector/Engine sub-scopes)
Reviewer: Principal Architecture function (session-based review, single-project)
Gate feeding: Testing Gate (pre-existing implementation, retroactive review of an external audit's findings against current code)
Findings: 2 live crash reports (not from the audit) + 8 external-audit items (3 HIGH, 3 MEDIUM, 3 LOW)
Dispositions: 2 confirmed+fixed (the live crashes); of the 8 audit items — 4 confirmed+fixed, 2 already resolved (by an earlier internal session, verified rather than re-patched), 2 rescoped-broader (confirmed real but with a larger actual footprint than reported: 6 files instead of 3, and 5 functions instead of 2), 1 effectively re-scoped by fixing its root cause (an orphaned-trigger risk eliminated as a side effect of fixing the trigger-quota-exhaustion risk it shared a root cause with)
Notable: this review is the origin case for several items now in the shared library rather than one-off findings:
  - The "already resolved" dispositions only became knowable by checking findings against actual current code and the project's own prior fix history, not by trusting an external report's framing at face value — this is why Constitution §5.2 (disposition, not blind action) and `09_Audit_Standard.md` §3 (verify before fixing) exist as explicit, required steps rather than assumed good practice.
  - Both "broader than reported" cases were found by searching the *pattern* (a function name, a magic-constant value) across the whole codebase rather than trusting the reporting document's file list — this is now Checklist Library item B3's second bullet.
  - The trigger-quota and duplicated-fallback-constant findings from this review are the origin cases for two Review Knowledge Base entries (`08_Review_Knowledge_Base.md`): "unbounded per-request platform resource creation" and "duplicated fallback constants."
Full record: project's own session fix log (`00_Project_State.txt` equivalent, Session 7 entry).

---

*(New reviews are appended above this line, newest first, as they complete.)*
