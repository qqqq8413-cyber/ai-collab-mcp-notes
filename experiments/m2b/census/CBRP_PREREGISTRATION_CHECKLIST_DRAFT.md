# CBRP — Preregistration Readiness Checklist — DRAFT

```
STATUS:  DRAFT
         NOT ACCEPTED
         NOT PREREGISTERED
```

> Everything that must be resolved before GPT may accept the CBRP census as a
> preregistered study. Companions:
> [`CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md`](CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md),
> [`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md),
> [`CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`](CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md),
> [`CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`](CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md),
> [`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md).
>
> Status vocabulary, strictly:
>
> ```
> OPEN                  no position taken
> PROPOSED              a recommendation exists, marked PROPOSAL ONLY, not accepted
> ARCHITECTURE-DECIDED  GPT has decided it
> IMPLEMENTED           code or artifacts exist
> VERIFIED              proven by a deterministic check
>
> ATTEMPTED … / FAILED CLOSED
>                       a stage was executed, adjudicated a failure, and closed;
>                       its evidence is preserved and is not reusable
> ```
>
> **Nothing below is IMPLEMENTED or VERIFIED.** No task exists, no harness
> exists, no provider call has been made.

---

## A. Study definition

| # | Item | Status | Note |
|---|---|---|---|
| A-1 | CBRP definition — synthetic, preregistered, equally weighted reference frame | **ARCHITECTURE-DECIDED** | Census §2.1 |
| A-2 | Primary estimand `P(deep ∧ assigned ≥ 2 \| CBRP)` | **ARCHITECTURE-DECIDED** | Named *reference-population assignment rate* |
| A-3 | Six primary-intent strata | **ARCHITECTURE-DECIDED** | Census §3 |
| A-4 | Equal weighting, 10 tasks per stratum | **ARCHITECTURE-DECIDED** | Never a usage-frequency claim |
| A-5 | N = 60 | **ARCHITECTURE-DECIDED** | N = 59 is the statistical minimum; **60 is the smallest balanced six-stratum design** meeting it. Derived from θ, never from cost |
| A-6 | θ_feas = 5% | **ARCHITECTURE-DECIDED** | Design decision, not a definition of "rare" |
| A-7 | Decision zones VIABLE / TOO_SPARSE / INCONCLUSIVE | **ARCHITECTURE-DECIDED** | Census §5.2 |
| A-8 | Routing rubric operational enough for two reviewers to agree | **PROPOSED** | D-3 now makes it measurable: the inter-reviewer disagreement rate is reported as a property of the rubric. Still asserted until reviews run |
| A-9 | Study id and version string | **OPEN** | Must be fixed before the first call so artifacts can cite it |

---

## B. Statistical method

| # | Item | Status | Note |
|---|---|---|---|
| B-0 | Model: independent, **non-identically** distributed Bernoulli; estimand `p̄ = (1/N)Σpi`; count is Poisson-binomial, never an ordinary Binomial | **ARCHITECTURE-DECIDED** | Census §2.2 |
| B-1 | **M-CBRP-STAT-01** | **VERIFIED** | Specification CLOSED ｜ implementation VERIFIED ｜ independent reproduction VERIFIED. No methodology blocker remains on the interval formula |
| B-1b | MT endpoints: `k = 1` lower `(1−β)/N`, `k = N−1` upper `1−(1−β)/N`, CP interior | **ARCHITECTURE-DECIDED** | Census §5.2 |
| B-1c | Independence is a **modeling assumption**, not attested by fingerprint / model pin / provider pin | **ARCHITECTURE-DECIDED** | Census §5.2.1 |
| B-2 | Interval **implementation**, including the two MT special cases | **VERIFIED** | `statistics.mjs`; 31 tests including rejection of CP at `k = 1` and `k = N−1` |
| B-3 | Numerical convention — tolerance, iteration bound, reported precision | **VERIFIED** | `NUMERICAL_CONTRACT`: bracket [0,1], 1e-14, 200 fixed iterations, unrounded decisions, 6-dp display |
| B-4 | Edge cases `k = 0`, `k = 1`, `k = N−1`, `k = N` | **VERIFIED** | All four pinned; plus a `beta_N` support guard that fails closed |
| B-5 | Independent reproduction of both bounds | **VERIFIED** | Reproduced independently by Codex: model, `beta_60`, all eight pinned vectors, the zone transitions, and N = 59 / 60. No repository change was made by that audit |
| B-6 | Point estimate reported descriptively only | **ARCHITECTURE-DECIDED** | The ≥ 10% point-estimate rule is explicitly rejected |
| B-7 | Decision-rule version string recorded in the artifact | **OPEN** | |
| B-8 | Asymmetry of the rule, and INCONCLUSIVE as a valid outcome | **ARCHITECTURE-DECIDED** | Accepted for Phase 1; must be stated alongside any verdict |

---

## C. Task population

| # | Item | Status | Note |
|---|---|---|---|
| C-1 | Task template / output format | **ARCHITECTURE-DECIDED** | JSON array of `{stratum, text}`, 12 per session; brief §2.8 |
| C-2 | Realism rubric | **ARCHITECTURE-DECIDED** | Brief §2.2, and a review check |
| C-3 | Self-containment requirement | **ARCHITECTURE-DECIDED** | Brief §2.3, and a review check |
| C-4 | Prohibited leakage term list | **ARCHITECTURE-DECIDED** | Brief §2.7, and a review check |
| C-5 | Diversity dimensions | **ARCHITECTURE-DECIDED** | Nine dimensions of the situation; five forbidden instructions about the answer |
| C-6 | Diversity handling | **ARCHITECTURE-DECIDED** | **No quotas.** Variation requested in the brief; a descriptive diversity report before freeze. Diversity is **not** an admission gate — only structural failure or a confirmed duplicate causes replacement |
| C-7 | Duplicate handling | **ARCHITECTURE-DECIDED** | Removed from per-task review — one reviewer sees one task. Corpus audit over all 60 texts: 2 blinded auditors, 3rd on a disputed pair, retention by lexicographically smallest candidate ID |
| C-8 | **The 60 tasks themselves** | **v1 FAILED CLOSED / v2 INCOMPLETE** | **0 admitted.** v1 produced 60 barred failed-acquisition candidates. CWP-10B attempted v2: B01 produced 12 mechanically extractable provisional candidates; B02 malformed output triggered the run-level STOP after the second call; B03-B05 were not called. The 12/60 v2 records are **unreviewed and not admissible**. No retry, repair or replacement ran |
| C-10 | Authoring v2 methodology amendment and re-freeze | **ARCHITECTURE-DECIDED / FROZEN** | `CBRP-AUTHORING-PROTOCOL-2`; brief `CBRP-AUTHORING-BRIEF-2`, sha256 `a9da93fd…`, 8114 bytes. Exactly one rule changed (§2.7): the lexical word-ban becomes a semantic answer-production-steering rule. New run id, session and candidate namespaces; nothing from v1 carried forward. Method frozen; acquisition attempted and stopped incomplete under CWP-10B |
| C-11 | Authoring v2.1 extraction amendment and re-run | **ARCHITECTURE-DECIDED / FROZEN** | `CBRP-AUTHORING-PROTOCOL-2.1` (D-29); a new run identity `CBRP-AUTHORING-V2P1-ROUND-0` with `AUTHOR21-*` sessions and `V21-*` candidate ids, none colliding with v1 or Protocol 2. B01's 12 valid Protocol-2 candidates are **not** carried forward — homogeneous-provenance choice, not a quality judgement. Method frozen; acquisition **not authorized** |
| C-9 | Difficulty varies within every stratum | **ARCHITECTURE-DECIDED** | "Ordinary" is not a stratum |

---

## D. Authoring and review procedure

| # | Item | Status | Note |
|---|---|---|---|
| D-1 | Blinded authoring envelope | **ARCHITECTURE-DECIDED** | Twelve exclusions and a closed allow-list; Authoring §3.1 |
| D-2 | Authoring block design | **ARCHITECTURE-DECIDED** | Five **quota blocks**, each × each stratum = 2 admitted tasks. Five initial sessions plus fresh replacement sessions as required; blocks are fixed at five, sessions are not |
| D-3 | Reviewer independence design | **ARCHITECTURE-DECIDED** | Two blinded reviews, third on disagreement, majority final; GPT task-level adjudication **forbidden**. Makes A-8's claim measurable |
| D-4 | Structural review rubric | **ARCHITECTURE-DECIDED** | Six per-task judgements plus `overallPass`; `notDuplicate` removed in CWP-8B. `noSpecialistSteering` rewritten in CWP-10A: it had carried the same lexical error as the v1 brief ("it fails on 'specialist'"), which would have moved the v1 failure to the review gate unchanged |
| D-5 | Reviewer must not score likelihood of the event | **ARCHITECTURE-DECIDED** | Authoring §5.4 |
| D-6 | "Fresh session" and author model rule | **ARCHITECTURE-DECIDED** | Fresh = fresh model context, not necessarily a different model. `openai/gpt-5` **forbidden** as an author. ≥ 2 non-Chief model families across the five blocks. Reduces coupling; does **not** eliminate shared-prior bias |
| D-7 | Blinding described as reduction, never elimination | **ARCHITECTURE-DECIDED** | Must appear in any result. Extends to author independence: fresh contexts reduce conversational contamination, they do **not** make outputs statistically independent |
| D-8 | Corpus duplicate audit procedure | **ARCHITECTURE-DECIDED** | `CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`; runs after all 60 pass per-task review, before freeze; stratum labels withheld; two fresh blinded auditors per round, third on a disputed pair |
| D-9 | Duplicate retention rule | **ARCHITECTURE-DECIDED** | One rule, every round: a component containing incumbents keeps all of them and rejects every replacement in it; a component of replacements only keeps the lexicographically smallest candidate ID. Round 0 has no incumbents, so it reduces to the lexicographic rule. Outcome-blind and deterministic |
| D-10 | Replacement provenance truthfulness | **ARCHITECTURE-DECIDED** | `authorBlockId` separated from `actualAuthorSessionId`; a replacement is never recorded as the original session |
| D-11 | Author model **family** allocation | **ARCHITECTURE-DECIDED** | B01/B03/B05 → CLAUDE_FAMILY, B02/B04 → GEMINI_FAMILY. The 3:2 split is forced by five blocks and two families; every stratum still receives 6 CLAUDE and 4 GEMINI, so family stays orthogonal to stratum |
| D-12 | Corpus duplicate audit **execution** | **OPEN** | 0 rounds run |
| D-13 | Incremental duplicate audit rule | **ARCHITECTURE-DECIDED** | DUP-R00 full (1770 pairs); DUP-R01+ scoped to pairs touching that round's replacements. Old–old re-audit **forbidden**. Invariant: every surviving pair is screened by exactly **one** completed round. Accepted cost: a round-0 false negative is permanent |
| D-14 | Incumbent displacement | **ARCHITECTURE-DECIDED** | **Never.** A task that survived a completed round cannot be removed by a later replacement — otherwise pool membership would be alterable by generating more replacements, and the process controls how many it generates |
| D-15 | Fresh auditor sessions per round | **ARCHITECTURE-DECIDED** | New contexts every round; a reused context would arrive carrying the previous round's outcome. D3 ids order the disputed pair lexicographically, never by flagger |
| D-16 | Round termination | **ARCHITECTURE-DECIDED** | No round cap. Continue until 60 tasks and no in-scope confirmed duplicate. If no valid replacement can be obtained: STOP to GPT. **The rubric is never weakened to make the process terminate** — termination is guaranteed by the STOP, not by the rule |
| D-17 | Round sequencing preconditions | **ARCHITECTURE-DECIDED** | A round may not begin until the previous one is complete and every vacancy is filled by a structurally-passing task. Vacancies are batched; a replacement failing structural review is replaced before the next audit round, and never reaches an auditor |
| D-18 | Session provenance schema | **DRAFT** | `CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`: authoring, review and audit sessions. `freshContextConfirmed` is an operator **attestation**, not a verified fact, and no result may present it as verified |
| D-19 | Chief model as reviewer or auditor | **ARCHITECTURE-DECIDED** | `openai/gpt-5` **forbidden** in all three session kinds. A model under measurement must not control membership in the pool it is later measured on — gatekeeping is as direct a lever as authoring. Does **not** eliminate shared priors |
| D-20 | Exact author provider/model IDs | **ARCHITECTURE-DECIDED** | **FROZEN**, `CBRP-SESSION-MODEL-PINS-1`. B01/B03/B05 → `claude/claude-sonnet-5`; B02/B04 → `gemini/gemini-3.7-flash`. Replacements inherit the block's model; none may switch model to improve acceptance |
| D-21 | Exact reviewer / auditor provider/model IDs | **ARCHITECTURE-DECIDED** | **FROZEN**. R1 = D1 = `claude/claude-opus-5`; R2 = D2 = `gemini/gemini-3.8-flash`. Every task and every round gets one judgement per family |
| D-22 | Reviewer may share the author's model family | **ARCHITECTURE-DECIDED** | **YES.** Both families judge every task, and within a family the reviewing model differs from the authoring one, so no task is admitted by the exact model that wrote it. **Not independence** — shared family priors remain and may not be claimed away |
| D-23 | Third-adjudicator routing | **ARCHITECTURE-DECIDED** | `CBRP-D3-v1`: SHA-256 over byte-exact selector input, first hex char `0-7` → Claude, `8-f` → Gemini. Structural key = taskCandidateId; duplicate key = the pair sorted ascending, so the route belongs to the pair, not the flagger. **No 50/50 guarantee** — over the 60 canonical ids the structural split is 27/33 |
| D-24 | Model availability policy | **ARCHITECTURE-DECIDED** | Aliases, upgrades, fallback, provider substitution, same-family swap and model-retry all **forbidden**. An unavailable pinned model is **STOP → preserve → return to GPT**, never a substitution: a pool screened half by one model and half by its stand-in has two standards in it |
| D-25 | Model-pin provenance recorded per session | **DRAFT** | `modelPinVersion`, `providerRequested`, `modelRequested`, `providerResolved`, `modelResolved`, `modelFamily`; D3 sessions also store selector bytes and digest. Observable mismatch ⇒ STOP, output not admitted, no retry. **Resolved identity is often unobservable in a paste-based session** — then it is an attestation, not a verified fact |
| D-27 | Authoring-run STOP scope | **ARCHITECTURE-DECIDED** | v2 freezes authoring-run STOPs as **mechanical and transport only**. Forbidden literal, semantic leakage, `noSpecialistSteering`, realism, self-containment and stratum correctness are explicitly **not** run-level STOPs — a run-level STOP answers a per-scenario question at the wrong granularity, which is exactly how v1 lost sixty candidates over two words |
| D-28 | Literal scans and reviewer blindness | **ARCHITECTURE-DECIDED** | Literal/token scans are **descriptive audit evidence only**; a lexical hit alone has no protocol disposition. Scanner verdicts, flags and hit counts **never reach a structural reviewer** — a flagged reviewer answers "do you agree with the scanner?", a different and easier question than the rubric's |
| D-29 | Deterministic wrapper extraction (Protocol 2.1) | **ARCHITECTURE-DECIDED / FROZEN** | `CBRP-AUTHOR-EXTRACTOR-2.1`. Three accepted representations — plain JSON, a complete outer fence, or one complete array followed only by an orphan trailing fence. Prompted by M-CBRP-AUTH-02: `AUTHOR2-B02-S00` was a syntactically complete array with a lone trailing fence, which Protocol 2's extractor could not recognize. Repair, prose-stripping and multi-value merging remain forbidden in every representation. Reference implementation and 23 synthetic tests: `experiments/m2b/census/extractor-2.1/` |
| D-26 | One canonical model table | **ARCHITECTURE-DECIDED** | `CBRP_MODEL_PINS_PREREG_DRAFT.md` holds every exact model string; other documents reference it by version. A table copied into six files disagrees with itself by the third edit. Where a string is quoted for readability (D-20, D-21 above, Authoring §6.2, `CURRENT_STATE.md`), **the pin table governs on any discrepancy** |

---

## E. Freeze and execution order

| # | Item | Status | Note |
|---|---|---|---|
| E-1 | Freeze before first planning call | **ARCHITECTURE-DECIDED** | Authoring §8 |
| E-2 | Per-task SHA-256 and a pool manifest | **OPEN** | Schema decided; **no self-referential commit SHA** — a commit cannot contain its own. Identified from outside as `POOL_FREEZE_COMMIT`. No task exists to hash |
| E-3 | Freeze provenance | **OPEN** | Required contents decided: bytes, ids, hashes, strata, session ids, review ids and results, replacement lineage. Not run |
| E-4 | Invalid-task policy | **ARCHITECTURE-DECIDED** | Three moments, three rules: pre-freeze replace; post-freeze whole-pool re-freeze; post-first-call STOP. Never dropped for its result |
| E-5 | Ordering rule | **ARCHITECTURE-DECIDED** | `CBRP-ORDER-v1`: seeded round-robin, ten rounds of six, no PRNG. Full spec in the manifest schema §4 |
| E-6 | Seed and permutation | **ARCHITECTURE-DECIDED** | `seed = SHA256(POOL_FREEZE_COMMIT + "\\n" + "CBRP-ORDER-v1")`, plus byte-exact task-order and round-stratum key derivations. Seed shopping is **structurally impossible** — the seed is a function of a commit that already exists |
| E-7 | No outcome-informed replacement, ever | **ARCHITECTURE-DECIDED** | |

---

## F. Harness and runtime

| # | Item | Status | Note |
|---|---|---|---|
| F-1 | Planning-only harness | **OPEN** | `runPlanningStage()` exists; the **census** harness around it does not |
| F-2 | `runPlanningStage()` behaviour-preserving extraction | **IMPLEMENTED** | See CENSUS-REQ-01 |
| F-3 | Proof the extraction moved no behaviour | **VERIFIED** | Full Round 1 output, provider call order and the five-read stepped clock all asserted unchanged |
| F-4 | Chief system prompt unchanged | **ARCHITECTURE-DECIDED** | |
| F-5 | `SPECIALIST_CAP`, registry, planner logic unchanged | **ARCHITECTURE-DECIDED** | |
| F-6 | Planning provider/model pin | **ARCHITECTURE-DECIDED** | `openai/gpt-5`, no fallback, no substitution; `EXPECTED_PLANNING_PIN`, enforced pre-call and by the verifier |
| F-7 | Transport retry policy for census calls | **IMPLEMENTED** | `explicit-no-retry` reused; every call records `transportMaxRetriesRequested = 0` |
| F-8 | Dependency provenance recorded and enforced against a baseline | **IMPLEMENTED** | `census-provenance.mjs`, own baseline `CBRP-CENSUS-DEPS-1`, Zod included |
| F-9 | Runtime fingerprint recorded **and enforced** | **VERIFIED** | See CENSUS-REQ-09. Scope stays src/ + dist/; dependency, toolchain and Node provenance sit beside it, never inside it |
| F-10 | Call budget | **IMPLEMENTED** | 60 global, 1 per task; no slots×4 semantics |
| F-11 | STOP rules — integrity violations, budget, failure paths | **IMPLEMENTED** | Pre-dispatch refusals cost no attempt; settled failures stop the session with no verdict |
| F-12 | Retrieval and temperature policy | **IMPLEMENTED** | Both refused pre-call by the census recorder |

---

## G. Artifact contract — DRAFT, not final

`[DRAFT]` Field names are illustrative. **This is not the final schema.**

### G.1 Session level

```
studyId ｜ studyVersion ｜ decisionRuleVersion
executionHead ｜ frozenPopulationCommit ｜ taskManifestSha256
N ｜ theta_feas ｜ alpha
plannerProviderRequested / Resolved ｜ plannerModelRequested / Resolved
dependencyProvenance ｜ runtimeFingerprintStart / End ｜ fingerprintDrift
callBudget ｜ orderRule ｜ orderSeed (if any)
startedAt ｜ completedAt ｜ stopCondition (null if none)
```

### G.2 Per task

```
taskId ｜ taskSha256 ｜ stratum ｜ orderIndex
rawPlanningResponseSha256
complexity ｜ requiredCapabilities
assignments ｜ assignmentCount ｜ assignedAgentIds
requiresRedTeam ｜ reason ｜ planningAdjustments
providerRequested / Resolved ｜ modelRequested / Resolved
callStatus ｜ error
eventDeep ｜ eventAssignedGte2 ｜ eventJoint
```

| # | Item | Status |
|---|---|---|
| G-1 | Session field set | **DRAFT** |
| G-2 | Per-task field set | **DRAFT** |
| G-5 | Pool manifest schema and identity schemes | **DRAFT** | `CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md`; task ids encode stratum only, review ids encode order only |
| G-6 | Order manifest, separate from the pool manifest | **DRAFT** | Separate so the freeze commit exists before the seed is derived from it |
| G-7 | Order validation contract | **ARCHITECTURE-DECIDED** | A verifier must recompute the whole ordering from `POOL_FREEZE_COMMIT` plus the frozen pool, trusting none of `seed`, the keys, or `orderedTaskIds`. Documented; **not implemented** |
| G-3 | Event fields recomputable from the post-enforcement plan | **VERIFIED** |
| G-4 | Verifier for census artifacts | **IMPLEMENTED** |

---

## H. Analysis and reproducibility

| # | Item | Status | Note |
|---|---|---|---|
| H-1 | Analysis recomputation | **IMPLEMENTED** | The verifier recomputes events, k, bounds and zone; never reads `eventJoint` as given |
| H-2 | Reproducibility check — same artifacts, same verdict | **VERIFIED** | Bit-identical bounds on repeat; the verifier re-derives the verdict from artifacts |
| H-3 | Independent bound reproduction by a reviewer | **OPEN** | See B-5 |
| H-4 | Descriptive measures reported | **PROPOSED** | Census §8 |
| H-5 | No causal language in results | **ARCHITECTURE-DECIDED** | |

---

## I. Claim boundary

| # | Item | Status | Note |
|---|---|---|---|
| I-1 | Every conclusion scoped "within the preregistered CBRP reference frame" | **ARCHITECTURE-DECIDED** | |
| I-2 | Production-wide prevalence claims prohibited | **ARCHITECTURE-DECIDED** | |
| I-3 | `assigned ≥ 2` never called F2 | **ARCHITECTURE-DECIDED** | Census §7 |
| I-4 | No worker-success, F2, quality or peer-challenge claim | **ARCHITECTURE-DECIDED** | |
| I-5 | No causation claims — task type, complexity, provider, model, role | **ARCHITECTURE-DECIDED** | |
| I-6 | **M-ACQ-01 not closed by this study** | **ARCHITECTURE-DECIDED** | CBRP gives a balanced-reference rate, not telemetry prevalence |
| I-7 | Phase 2 not designed, not preregistered, not authorized | **ARCHITECTURE-DECIDED** | Prerequisites listed in Census §7.1 |

---

## K. Engineering requirements for a live census

Raised by the planning-stage extraction and the statistical correction. **Do not
read any of 03–06 as implemented; they are not.**

| # | Requirement | Status | Note |
|---|---|---|---|
| **CENSUS-REQ-01** | `runPlanningStage()` parity — a production plan obtainable with zero worker calls, behaviour provably unmoved | **IMPLEMENTED** | Extracted; 32 planning-stage tests and 18 Round 1 boundary tests, both in the root test command |
| **CENSUS-REQ-02** | Post-enforcement event source — the formal assignment count is `runPlanningStage().plan.assignments.length`, never the raw Chief JSON | **ARCHITECTURE-DECIDED** | Documented in Census §2.2; a test pins that raw 5 becomes enforced 4. **The census consumer of it does not exist yet** |
| **CENSUS-REQ-03** | Durable **pre-dispatch** attempt reservation | **IMPLEMENTED** | `attempt-registry.mjs`: append-only NDJSON, fsync per record, three distinguishable recovery states; reserved-but-unsettled = `AMBIGUOUS_ATTEMPT_CONSUMED`, session INCOMPLETE, no retry |
| **CENSUS-REQ-04** | Source ↔ dist execution binding | **IMPLEMENTED / VERIFIED OFFLINE** | Now consumes CENSUS-REQ-07 and -08: toolchain and runtime are asserted before the reference build, and travel in the artifact. Historical `runtimeFingerprint` untouched |
| **CENSUS-REQ-05** | Zod installed-byte provenance | **IMPLEMENTED** | In the census baseline with lock integrity, manifest hash, entrypoint, digest and file count. No package version changed |
| **CENSUS-REQ-06** | Census-specific recorder and artifact contract | **IMPLEMENTED** | `planning-recorder.mjs`, `census-session.mjs` (`CBRP-CENSUS-1`), `census-verify.mjs`; 69 rehearsal tests |
| **CENSUS-REQ-07** | Build toolchain provenance | **CLOSED / VERIFIED OFFLINE** | Both TypeScript packages attested. TS 7 is the native port, so the compiler is a binary in `@typescript/typescript-darwin-arm64`; the executable is resolved by asking the launcher, not by reading a path, and must land inside the approved package |
| **CENSUS-REQ-08** | Node runtime pin | **CLOSED / VERIFIED OFFLINE** | `process.version` pinned at `v24.15.0` and fail-closed; platform, arch and other `process.versions` fields recorded as context and never compared |
| **CENSUS-REQ-09** | Runtime drift enforcement | **CLOSED / VERIFIED OFFLINE** | Historical fingerprint semantics unchanged. Missing start → pre-dispatch stop; any start/end difference → INCOMPLETE and no verdict, even on sixty successes. Re-sampled at each task boundary; **cannot** prove a transient change inside one call |
| **CENSUS-REQ-10** | Pre-call provenance revalidation | **CLOSED / VERIFIED OFFLINE** | The session calls the verifier's own `toolchainProblems` and `matchesCensusBaseline` on the actual records. A forged `match: true` or `problems: []` is refused before any reservation |

## J. Readiness summary

```
108 checklist items

ARCHITECTURE-DECIDED             63
ARCHITECTURE-DECIDED / FROZEN     3
PROPOSED                          2
OPEN                              7
DRAFT                             6
IMPLEMENTED                      12
IMPLEMENTED / VERIFIED OFFLINE    1
CLOSED / VERIFIED OFFLINE         4
VERIFIED                          9
v1 FAILED CLOSED / v2 INCOMPLETE  1
```

**AUTHORING v2 METHODOLOGY FROZEN, ACQUISITION INCOMPLETE — study NOT PREREGISTERED.** Method,
estimand, decision rule, execution infrastructure, and every authoring, review,
duplicate-audit, invalid-task, ordering and model-pin procedure are decided and written to
the level of pasteable briefs and a byte-exact ordering algorithm.

One acquisition ran under `CBRP-AUTHORING-PROTOCOL-1` and was adjudicated INCOMPLETE: 60
candidates produced, 0 admissible, the brief superseded, and all sixty permanently barred.
`CBRP-AUTHORING-PROTOCOL-2` corrects the single rule responsible — prospectively, and
without rehabilitating anything. CWP-10B then attempted v2: B01 yielded 12 mechanically
extractable candidates and B02 malformed output stopped the run after two calls. The
required 60-candidate content and complete execution record are still missing; no review or
audit has run, no pool is frozen, no seed has been materialized, and no Chief call has been
made.

**No methodology decision known to this checklist is open.** Every remaining item is a
record that a complete future architecture-authorized process would have to produce:

```
C-8            the 60 task texts                      0 admitted; v1 acquisition FAILED CLOSED
               v2 acquisition INCOMPLETE — 12/60 provisional, unreviewed, not admissible
D-12           duplicate audit rounds                 0 run
E-2, E-3       pool manifest and freeze provenance    0 pools frozen
F-1            the census harness around runPlanningStage()
A-9, B-7       study-id and decision-rule version strings, fixed at first execution
H-3            independent bound reproduction by a reviewer
```

`[DESIGN]` Most of these are **unexecuted, not undecided** — a record that a complete run
has to produce. CWP-10B authorized only the now-stopped v2 initial acquisition.

**C-8 changed character in CWP-9B and C-10 closed in CWP-10A.** Authoring was attempted
under v1 and **failed closed**: 60 candidates exist, none is admissible, and the brief that
produced them is superseded. The amendment that failure required is now written and frozen —
`CBRP-AUTHORING-PROTOCOL-2`, one rule changed — so what stands between here and a task pool
was execution. CWP-10B attempted that run, which is now **INCOMPLETE** and awaiting GPT
Architecture review after its B02 malformed-response STOP.

**A-8 is the one item that is neither decided nor merely unexecuted.** It **asserts** the
routing rubric is operational enough for two readers to agree, and nothing has measured it.
D-3's two-reviewer design is what turns the assertion into a number — the realized
inter-reviewer disagreement rate — and that number cannot exist before reviews run. It stays
`PROPOSED`, not because a decision is missing but because the evidence is.

**Do not read any of this as a task-content freeze.** The procedure is frozen. Twelve
partial provisional records exist, but no complete, admitted or frozen content exists.

Every execution-infrastructure requirement CENSUS-REQ-01 … 10 is closed offline. What stands
between here and a preregisterable study is a complete sixty-task acquisition, its
screening, and the freeze. CWP-10B stopped before any of those conditions was met.

`[OPEN]` One more limit worth restating: **the census harness has been rehearsed, never
run.** Every path is exercised against a stub, which proves the refusals fire and the
artifact is verifiable. It does not prove the production Chief behaves as the stub did, and
nothing offline can.
