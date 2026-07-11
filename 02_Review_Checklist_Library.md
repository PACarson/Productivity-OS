# 2.2 Review Checklist Library

**Status:** v1.0 — ratified
**Parent:** `02_Architecture_Review_Standard/`
**Purpose:** one shared bank of checklist items; profiles (`01_Review_Profiles.md`) select subsets from it, no project writes its own

---

## How to use this library

Each item below is written to be answered **Pass / Fail / N/A-with-reason** against real, current code — not against intent or memory of intent (`00_Review_Framework.md` §6). A Fail becomes a finding using the template in `07_Review_Templates.md`, severity assigned from `05_Risk_Matrix.md`.

Items are grouped for readability; a profile's "minimum checklist subset" (per `01_Review_Profiles.md`) names which groups or individual items apply.

---

## A. Structural

### A1. Separation of Concerns
- [ ] Every module's responsibility can be stated in one sentence without "and" joining two unrelated verbs.
- [ ] A module's private helpers are never called from outside it.
- [ ] No module contains logic for two different Blueprint layers (e.g., Runtime request-handling logic living inside what's nominally an Integration adapter).

### A2. Dependency Direction
- [ ] Dependencies point outward from Runtime/Intelligence toward Integration, never the reverse.
- [ ] Within a layer, dependencies point from specific to generic, never generic-depends-on-specific.
- [ ] No cyclic dependency between two modules (A depends on B depends on A).

### A3. Layering
- [ ] Every module maps cleanly to exactly one Blueprint layer; none straddle two.
- [ ] A lower layer (e.g., Foundation) never imports or calls a higher layer (e.g., Integration).
- [ ] Cross-layer communication happens through a defined contract, not shared mutable state.

### A4. Contract Stability
- [ ] Every public function's signature, return shape, and error behavior are documented (even minimally) at the point of definition.
- [ ] A change to a public contract's shape is additive (new optional field) unless a version bump and migration path (`08_Migration_Standard.md`) accompany it.
- [ ] Consumers of a contract are identifiable (searchable), so a breaking change's blast radius is knowable before it's made.

### A5. Event Flow
- [ ] Every emitted event has a single, findable definition of its shape (Blueprint layer `1. Foundation` → Event Definitions).
- [ ] Event emission that happens per-item in a loop uses a batching mechanism where one exists, rather than N individual emissions.
- [ ] A consumer of an event degrades gracefully (logs and continues) if the event payload is malformed, rather than propagating an exception into the emitter's own execution.

---

## B. Quality & Robustness

### B1. Extensibility
- [ ] Adding a second implementation of an existing single-provider dependency (e.g., a second data vendor) would require a change in one place, not a hunt across the codebase.
- [ ] Configuration that plausibly varies per-deployment or per-environment is not hardcoded inline.
- [ ] Extensibility added here is justified by a *named* near-term scenario (Constitution §4.2), not speculative generality.

### B2. Scalability
- [ ] Any per-request resource creation (triggers, files, cache keys) is bounded or pooled, not unbounded-per-request.
- [ ] A loop that calls an external system does so with awareness of that system's rate limits (batching, sleep/backoff, or an explicit per-run cap).
- [ ] A mechanism tested against current load has an explicit note of what load it was validated against, so "this doesn't scale" has a concrete threshold rather than being an unfalsifiable worry.

### B3. Reusability
- [ ] A constant, threshold, or fallback value needed in more than one place is defined once and referenced, not copy-pasted (Constitution §4.7).
- [ ] Where a copy is found anyway, every occurrence is located (not just the ones matching the original bug report's file list — see `08_Review_Knowledge_Base.md`) before the fix is considered complete.
- [ ] A generic utility extracted for reuse is placed where its name doesn't mislead about what it does (a formula-fetch utility living in a "CurrencyAdapter" module, if unavoidable for pragmatic reasons, is documented as a deliberate placement tradeoff, not left unexplained).

### B4. Performance
- [ ] An operation with a known platform-level cost (e.g., a full-workbook recalculation, a synchronous network call) is scoped as narrowly as the platform allows, not accepted as unavoidable without checking.
- [ ] A per-run cap or timeout exists for any operation whose duration scales with data volume, relative to the platform's execution time ceiling.
- [ ] A performance-sensitive path has a stated, even if informal, expectation of "how long is acceptable here" — so a regression is detectable.

### B5. Maintainability
- [ ] A reader unfamiliar with this specific module could locate its responsibility, its public contract, and its known tradeoffs without reading every line.
- [ ] A non-obvious decision (why this threshold, why this fallback, why this ordering) has a comment or ADR reference at the point it matters, not only in a separate document a future editor won't think to check.
- [ ] Naming does not rely on a generic word ("manager," "handler," "helper," "utils") to paper over an unclear responsibility (see A1).

---

## C. Operational

### C1. Testing
- [ ] Every public contract has at least a Contract Test (`05_Testing_Standard.md`) confirming its shape.
- [ ] Every identified failure mode (external dependency down, malformed input, concurrent access) has a corresponding Failure Recovery or Boundary Test, not just a happy-path test.
- [ ] A fix for a specific reported bug includes a test (or a standalone reproduction, where the platform doesn't support automated tests) that would have caught it, not just the patch itself.

### C2. Migration
- [ ] A schema, contract, or API change that affects existing data or existing consumers has a stated migration path (`08_Migration_Standard.md`), even if the path is "no data exists yet, no migration needed" — stated explicitly, not assumed silently.
- [ ] Backward compatibility is either preserved or its break is deliberate, versioned, and announced — never an accidental side effect of an unrelated change.

### C3. AI Readiness
*(Applies fully to AI Module profile; applies partially — "is this module's output consumable by an AI Core caller" — to Service/Connector profiles, and to a Domain OS profile project whose stored data is meant to eventually be queried or summarized by Personal AI Core or a similar cross-project AI caller, even if no such caller exists yet. Origin: Productivity OS 2026-07-11 — a Domain OS with a plausible, named future AI consumer should not wait until that consumer exists to start checking this.)*
- [ ] Output intended for consumption by an AI agent (e.g., Personal AI Core) is structured (typed fields), not free text requiring re-parsing.
- [ ] A module whose core responsibility is a model judgment has a defined fallback for low-confidence or malformed model output — it is never assumed correct by default.
- [ ] Non-determinism (if any) is contained and documented, not silently propagated into a contract that callers assume is deterministic.

### C4. Security
- [ ] Any credential, token, or secret is never hardcoded or logged in plaintext.
- [ ] A boundary that accepts external input (a Service's request payload, a Connector's response parsing) validates shape before acting on it.
- [ ] An unofficial/undocumented external dependency (common in Connector profile) is treated as adversarial-by-default for parsing purposes — a malformed or unexpected response degrades gracefully, never crashes the caller.

---

## D. Governance & Process

### D1. Governance
- [ ] The module or project has an ADR log entry for any decision meeting the criteria in `01_Architecture_Design_Standard.md` §8.
- [ ] The project's Project State document (Constitution §6.2) reflects the current state, not a stale snapshot from an earlier session.
- [ ] Prior review findings for this scope have a recorded disposition (Constitution §5.2), not an unresolved "TODO: check this."
- [ ] A "Won't fix" or "maintain current design" decision is filed as a discrete ADR entry, not only argued inline in a file header or a sibling governance doc. Reasoning that exists but isn't filed under the project's ADR log reads as missing the moment someone checks that log specifically for the full decision list — even when nothing was actually left unreasoned, only mis-filed (see Review Knowledge Base KB-8, origin: Productivity OS 2026-07-11).

### D2. YAGNI
- [ ] Every piece of configurability, abstraction, or generality present in the code is traceable to a named current or near-term need.
- [ ] No dead code path exists that was built for a scenario that never materialized — including a call to a function whose result is silently unused (a real, found example: a fetched value computed and never consumed anywhere downstream).
- [ ] A "just in case" parameter, flag, or branch has an owner scenario stated in a comment or ADR; if none can be stated, it's a candidate for removal, not preservation.

### D3. Doc/Code Drift
- [ ] A comment, ADR, or Project State entry describing this module's behavior matches what the code currently does — checked, not assumed.
- [ ] A changelog comment at the top of a file (where this project's convention uses one) accurately lists what changed and why, including the most recent change.
- [ ] Where a prior audit or review claimed a fix, the current code is checked to confirm the fix is actually present — a written record of "fixed" is a claim, not evidence, until verified against the code doing the thing (`09_Audit_Standard.md` §3).
- [ ] A file's own header version number matches its actual current content, checked against another file that independently records version history (e.g., a Project State doc) rather than assumed consistent just because the file's substantive content looks current (see Review Knowledge Base KB-8, origin: Productivity OS 2026-07-11 — this drifted in three separate files in the same project once actually checked).

---

## Adding a new checklist item

A new item is added here — never as a one-off addition to a single project's private checklist — when a real finding (from any project's review or audit) reveals a check that should have caught it but wasn't on the list. Propose the addition through the same Decision Matrix as any other UEF change (Constitution §7). See `08_Review_Knowledge_Base.md` for the running record of findings that originated new items here.
