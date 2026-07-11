# 2.8 Review Knowledge Base

**Status:** living document — append as new patterns are confirmed across more than one occurrence, or judged significant enough to seed on first occurrence
**Parent:** `02_Architecture_Review_Standard/`
**Purpose:** named, recognizable patterns and anti-patterns, so a reviewer sees the shape of a problem instantly instead of re-deriving it from first principles every time

---

## How entries are added

An entry earns a place here when a finding reveals something a *checklist item alone* wouldn't have made a reviewer notice in time — the specific shape, not just the general category. Every entry links to the Review History (`06_Review_History.md`) case it originated from. An entry is not philosophy; it's "here is exactly what this looks like when you find it."

---

## Patterns (anti-patterns) confirmed

### KB-1: Unbounded per-request platform resource creation
**Applies to:** Service, Platform profiles.
**Symptom:** a resource with a hard platform-level quota (a trigger, a file handle, a connection) is created fresh on every incoming request, instead of a single pooled/persistent resource being reused.
**Why it's tempting:** it's the simplest code to write, and it works fine in testing because testing rarely produces the burst concurrency that exhausts the quota.
**Root cause:** the design was validated against single-request correctness, never against aggregate/burst load relative to the *specific number* the platform enforces.
**Fix pattern:** replace "create one per request" with "create one, once, idempotently; have it drain a queue." Check the platform's actual current quota number before assuming a design "should be fine" — quotas are platform facts to verify, not assume from memory (see Infrastructure profile in `01_Review_Profiles.md`).
**Origin case:** Investment OS, `06_Review_History.md` 2026-07-10 entry (deferred job trigger creation vs. a 20-trigger platform ceiling).
**Related checklist item:** B2 (Scalability).

### KB-2: Duplicated fallback constants
**Applies to:** any profile; most common in Engine.
**Symptom:** the same magic number (a default rate, a threshold, a timeout) appears hardcoded in more than one place, usually as a `parseFloat(x) || DEFAULT` inline pattern repeated per caller instead of centralized.
**Why it's tempting:** the very first occurrence is genuinely a one-off convenience; each subsequent occurrence is copy-paste from the nearest existing example rather than a deliberate decision to duplicate.
**Root cause:** no single module was ever designated as the owner of the value, so there was no "obvious place to call instead."
**Fix pattern:** identify (or create) the one owning module; every consumer calls it. **When auditing this pattern, search for the *value* (the actual magic number) across the whole codebase, not just the function name mentioned in whatever report flagged it first** — a duplicated constant rarely announces all of its copies through one consistent wrapper function name; some copies will be bare inline expressions with no function at all.
**Origin case:** Investment OS FX-rate defaults — reported as present in 3 files behind one function name; actually present in 6 files, 4 behind a same-named wrapper function and 2 as bare inline expressions.
**Related checklist item:** B3 (Reusability).

### KB-3: Weak-type key comparison across a serialization boundary
**Applies to:** any profile persisting data through a system that performs implicit type coercion (spreadsheets, loosely-typed data stores, CSV round-trips).
**Symptom:** a matching/lookup function compares keys with a same-type-assuming operator (or an unconditional `String(x) === String(y)`) and silently fails to match when the storage layer has coerced one side's type (a leading-zero numeric code stored as a plain string becomes a number, e.g. "0700" → 700) — with no exception thrown, just a silent non-match.
**Why it's dangerous specifically:** it fails silently, not loudly — a delete that doesn't delete, or worse, an update that doesn't find its target row and inserts a duplicate instead, produces no error at all. It's found by data inspection, not by reading logs.
**Root cause:** the comparison function assumes its own type-coercion (`String(...)`) is sufficient to normalize both sides, without accounting for what the *storage layer itself* already did to one side before the comparison ever runs.
**Fix pattern:** normalize with awareness of the specific coercion the storage layer performs (for numeric-looking identifiers, compare through `Number(...)` before re-stringifying) — not just re-apply the same coercion that already failed to help. Apply the fix to *every* function performing this kind of matching, not only the one or two named in whatever report first flagged it (see KB-2's audit-scope lesson — the same "search the pattern, not just the named location" applies here).
**Origin case:** Investment OS `TruthEngine` row-matching — reported in 2 functions; actually present in all 5 functions performing key-based row matching.
**Related checklist item:** C4 (Security, for the general "don't trust a boundary's type" framing) and B5 (Maintainability).

### KB-4: Undifferentiated failure bucketing hides root cause
**Applies to:** Connector profile, primarily.
**Symptom:** every non-success outcome from an external call (auth failure, rate limit, resource-not-found, network error) is collapsed into one "failed" bucket, with the specific HTTP status or error code visible only in raw logs, not in any structured summary.
**Why it's dangerous specifically:** it produces exactly the kind of confusion where a single data-mapping bug (one wrong symbol → 404) gets read against an unrelated structural report (IP-range rate-limiting → 403/429) because nothing in the summary distinguishes them — the investigator has to go re-derive the distinction from raw logs every time instead of reading it directly.
**Root cause:** the failure-handling code was written to answer "did it work," not "if not, why not" — a reasonable-looking simplification that removes exactly the information needed to route the fix correctly.
**Fix pattern:** classify failures into stable, named reason codes (e.g., `AUTH_EXPIRED`, `RATE_LIMITED_OR_BLOCKED`, `SYMBOL_NOT_FOUND`) at the point the failure is first observed, and surface the classification in whatever summary a human or another system will read — not just in the per-line log.
**Origin case:** Investment OS `FundamentalsSync` — a 404 (symbol-mapping bug) was initially conflated with a separate, already-largely-mitigated 403/429 IP-ban risk because both were reported as one undifferentiated "failed."
**Related checklist item:** C4 (Security) and B5 (Maintainability); also directly supports `09_Audit_Standard.md` §3's verification step.

### KB-5: Degenerate-input numerical amplification
**Applies to:** Engine profile.
**Symptom:** a normalization or scoring formula divides by a range (`max - min`) that is guarded against being exactly zero, but not against being *near* zero — so a configuration typo that makes the range merely tiny (not exactly zero) produces wild output swings from trivial input changes, without ever throwing a divide-by-zero error to make the problem visible.
**Why it's tempting to under-guard:** an exact-equality guard (`if (max === min)`) feels like it "handles the edge case," and it does handle the literal one — the near-miss case looks like a different, less obvious edge case rather than the same risk at a different distance.
**Root cause:** the guard was written against the mathematically exact failure condition (division by exactly zero) rather than the practically relevant one (division by a denominator small enough to amplify noise).
**Fix pattern:** guard with an epsilon appropriate to the metric's normal range, not exact equality — `Math.abs(max - min) < EPSILON`, with EPSILON chosen relative to the smallest sensible configured range for that class of metric, and returning a neutral (not zero, not max) fallback value.
**Origin case:** Investment OS `ScannerEngine` scoring functions — reproduced with a standalone test showing a ~0.0000004 input change swinging a 0-100 score from 50 to 90 under the exact-equality-only guard.
**Related checklist item:** B4 (Performance is adjacent, but this is really its own correctness concern) — candidate for a future dedicated "Numerical Stability" item if this pattern recurs in a second project.

### KB-6: Platform-wide operations scoped by convenience, not by necessity
**Applies to:** Engine, Connector profiles operating inside a shared runtime (e.g., a spreadsheet-hosted script).
**Symptom:** an operation with a platform-documented "affects everything, not just what you touched" cost (e.g., a full-recalculation trigger) is invoked against a large shared resource (the main workbook) purely because that resource was the most convenient place to put the scratch work triggering it — not because the operation needed to run against that resource specifically.
**Root cause:** the scratch work and the expensive operation were co-located with the primary data for convenience early on, before the primary data grew large enough for the cost to matter.
**Fix pattern:** isolate the operation against the smallest resource that can host it (a dedicated auxiliary file/table/namespace), created once and reused, so the platform-wide cost stays bounded regardless of how large the primary resource grows.
**Origin case:** Investment OS `PriceSync`/`CurrencyAdapter` — GOOGLEFINANCE formula evaluation lived in a hidden tab inside the main workbook, so a required `flush()` call recalculated the entire workbook; moved to a dedicated auxiliary spreadsheet file.
**Related checklist item:** B4 (Performance).

### KB-7: Fetched-but-unused dependency
**Applies to:** any profile.
**Symptom:** a function calls another module to fetch a value, assigns it to a local variable, and never reads that variable again anywhere in the function body.
**Why it survives review:** it doesn't cause a bug (nothing depends on it), so it produces no failing test and no incorrect output — it's found by reading, not by symptom.
**Root cause:** usually a leftover from an earlier version of the function that did use the value, where the usage was later removed but the fetch wasn't.
**Fix pattern:** when found, don't "fix" it by redirecting it to a better source (per KB-2) — check first whether it's used at all. If unused, delete the call and its now-orphaned dependency entirely; redirecting a call that isn't needed is solving a problem that doesn't exist.
**Origin case:** Investment OS `BuyZoneEngine.getOpportunities()` — called a duplicated-fallback-constant function (KB-2 pattern) whose result was never referenced anywhere in the function.
**Related checklist item:** D2 (YAGNI).

### KB-8: Version-header drift and unfiled-but-argued decisions
**Applies to:** any profile with versioned governance/header files (Constitution, ADR log, File Map, Roadmap, or equivalents).
**Symptom (two related shapes, found together in the same review):** (1) a file's own header states an older version number than its body content actually reflects — the content was updated but the header line wasn't, and this recurs independently across multiple sibling files in the same project rather than being a one-off typo; (2) a "won't fix" or "maintain current design" decision is reasoned thoroughly, but only inline in a file header or a sibling doc's narrative, never filed as a discrete entry in the project's actual ADR log — so a reviewer checking that log specifically for "what decisions exist" doesn't find it, even though the reasoning was never actually missing.
**Why it's tempting:** updating a header line feels redundant once the body content already says what changed; and a decision made in the course of fixing something else naturally gets written down wherever the fix itself is being documented, not filed separately as its own artifact.
**Root cause:** both shapes come from the same thing — a project can have excellent *substantive* documentation discipline (the reasoning is genuinely there, genuinely good) while a *structural filing* convention (this fact belongs in this specific artifact) quietly lapses, because nothing forces the two to move together.
**Fix pattern:** for (1), cross-check a file's header claim against an independent source of version history (a Project State doc, a sibling file's changelog) rather than trusting the header at face value; for (2), when a "won't fix" reasoning is found anywhere in a project, check whether it's also filed in the ADR log specifically — if not, backfill a retroactive ADR entry that formalizes (not re-litigates) the existing reasoning.
**Origin case:** Productivity OS, `06_Review_History.md` 2026-07-11 entry — a Roadmap file's header and current-version section were two full version increments stale, the same lag independently recurred in the ADR log's header and in the File Map's own governance-doc count, and two real, well-reasoned "maintain current design" decisions (a documented dependency-rule exception; a documented bare-global-function risk accepted twice across two audit rounds) had never been filed as ADR entries.
**Related checklist item:** D1 (Governance) and D3 (Doc/Code Drift) — this pattern is why both now carry a dedicated bullet for it.

---

## Process patterns (not code anti-patterns, but review/audit practice)

### KB-P1: An external report's framing is a hypothesis, not a fact
An incoming audit or bug report should be treated as a well-informed hypothesis about the code, checked against the actual current code before any fix is made — not act on unread, and not dismissed unread either. Concretely this means: for every reported finding, actually read the file and function named, confirm the mechanism described actually exists as described, and check whether a prior session already addressed it. See Constitution §5.2 (disposition) and `09_Audit_Standard.md` §3. This single practice is what turned "8 findings" into "4 confirmed, 2 already-resolved, 2 broader-than-reported" in the origin case for this knowledge base — a report acted on without this step would have re-fixed two already-solved problems and under-fixed two others.

### KB-P2: Search the pattern, not the reported location
When a finding names specific files or functions, search the codebase for the underlying *pattern* (the function name, yes, but also the actual magic value, the actual mechanism) before considering the finding's scope closed. Both KB-2 and KB-3 above were reported narrower than they actually were, and both were found to be broader by this specific practice, not by any special insight.
