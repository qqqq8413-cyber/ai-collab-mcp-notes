/**
 * NC-3 — the leakage guard on arm D-1.
 *
 * This protects the experiment's central identifying assumption. If D-1 sees the peer's
 * argument, `C - D1` collapses toward zero and the study concludes "peer information adds
 * nothing" — a wrong answer, in a known direction, that nothing downstream would catch.
 * So the check runs before every D-1 call and throws rather than warns.
 *
 * ## What is a control and what is a diagnostic (harness review, H-02)
 *
 * These are not the same kind of claim, and the difference matters more than any
 * threshold:
 *
 *   PRIMARY STRUCTURAL CONTROLS — these can be reasoned about, not merely sampled:
 *     1. `buildSelfReviewPrompt` has no parameter for a peer chunk, a challenge or a
 *        sourceRef. There is no argument through which any of them could arrive.
 *     2. exact rejection of `sourceRef`
 *     3. exact rejection of `challengeText`
 *     4. exact rejection of `chunkText` in the middle round
 *     5. the guard runs BEFORE the provider call, so a contaminated D-1 costs nothing
 *
 *   SECONDARY DIAGNOSTIC HEURISTIC — the contiguous substring window. It is an extra
 *     lexical leak detector, nothing more. It is NOT a correctness invariant, NOT a
 *     structural guarantee, and NOT a proof that no leakage occurred.
 *
 *   RESIDUAL RISK, unresolved and not claimed to be resolved:
 *     paraphrase · topic steering · semantic leakage · concept-level leakage
 *
 * No window length can close that residual gap, so the window's exact value is a tuning
 * choice inside a diagnostic, not the thing correctness rests on. Protocol §19 X11 records
 * the residual risk and it stays recorded.
 *
 * Naming this after what it actually asserts is deliberate — HANDOFF §25 E4 is the
 * cautionary case, where an invariant named for a property it could not fail on was read
 * as evidence for that property.
 */

export class PeerLeakageDetected extends Error {
  constructor(kind, fragment) {
    super(
      `NC-3: arm D prompt contains ${kind} content that must never reach it — ` +
        `matched fragment ${JSON.stringify(fragment)}. This run is INVALID.`
    );
    this.name = 'PeerLeakageDetected';
    this.kind = kind;
    this.fragment = fragment;
  }
}

/**
 * Window for the middle round. Protocol §14 NC-3 specifies 20.
 *
 * Diagnostic parameter, not a correctness threshold. It is usable here because none of the
 * peer's text is legitimately present in a self-review prompt, so a coincidence at this
 * length is worth surfacing.
 */
export const DEFAULT_WINDOW_CHARS = 20;

/**
 * Window for the decision prompt, where Round 1 *is* legitimately present.
 *
 * Also a diagnostic parameter. 20 is unusable here: a gate-authored challenge is written
 * *about* a Round 1 passage, so it reuses that passage's vocabulary, and the shared Round 1
 * block then trips a 20-character match that is not leakage at all. The synthetic fixture
 * reproduces it — " the same senior edi" is common to the challenge and to the strategist's
 * Round 1 answer.
 *
 * 60 is not a better threshold in any principled sense; it is a less noisy setting for a
 * heuristic. Correctness here rests on the exact-string rejections above, which catch the
 * failure that actually threatens the experiment: a whole challenge or sourceRef
 * transplanted into a D-1 prompt by a harness bug.
 */
export const DECISION_WINDOW_CHARS = 60;

/**
 * Every contiguous window of `size` characters in `text`, whitespace-collapsed first so a
 * reflowed quotation still matches.
 */
function windows(text, size) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i + size <= flat.length; i++) out.add(flat.slice(i, i + size));
  return out;
}

/**
 * Throws if any peer-derived string has leaked into an arm D prompt.
 *
 * ## Why `allowPeerChunk` exists
 *
 * The peer passage is a paragraph of a Round 1 answer, and every decision-synthesis
 * prompt — arm C's and arm D-1's alike — contains the full Round 1 specialist block. So
 * the peer chunk is *necessarily* present there, in both arms, and that is evidence
 * parity rather than leakage: the two synthesizers must see the same Round 1 corpus or
 * `C - D1` measures what they were shown instead of the treatment.
 *
 * The treatment lives in the middle round. What must never reach D-1 is the peer passage
 * as a *directed* input to the target specialist, plus the gate-authored challenge and the
 * sourceRef, neither of which exists anywhere in Round 1.
 *
 * Hence two modes:
 *
 *   middle round (self_review)   full check — chunk, challenge, sourceRef
 *   decision synthesis           challenge and sourceRef only
 *
 * Turning the chunk check off for the decision prompt is not a weakening of the guard. Not
 * turning it off would forbid D-1 from carrying the same specialist block as C, which
 * would break the parity the experiment depends on.
 *
 * @param {string} prompt              the D-1 prompt about to be sent
 * @param {object} peer
 * @param {string} peer.chunkText      the exact peer passage arm C was given
 * @param {string} peer.challengeText  the gate-authored challenge arm C was given
 * @param {string} peer.sourceRef      e.g. "business_strategist:p5"
 * @param {object} [options]
 * @param {number} [options.windowChars]
 * @param {boolean} [options.allowPeerChunk]  true only for the decision-synthesis prompt
 */
export function assertNoPeerLeakage(prompt, peer, options = {}) {
  const { windowChars = DEFAULT_WINDOW_CHARS, allowPeerChunk = false } =
    typeof options === 'number' ? { windowChars: options } : options;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('assertNoPeerLeakage: prompt must be a non-empty string');
  }
  for (const key of ['chunkText', 'challengeText', 'sourceRef']) {
    if (typeof peer?.[key] !== 'string') {
      throw new Error(`assertNoPeerLeakage: peer.${key} must be a string`);
    }
  }

  // sourceRef is short and structural — an exact substring test is the right one.
  if (peer.sourceRef.length > 0 && prompt.includes(peer.sourceRef)) {
    throw new PeerLeakageDetected('sourceRef', peer.sourceRef);
  }

  // Exact whole-string containment, in both modes. This is the check that catches the
  // failure that actually threatens the experiment: a harness bug passing `excerpt.text`
  // or `selected.challenge` straight into a D-1 prompt.
  if (peer.challengeText.length > 0 && prompt.includes(peer.challengeText)) {
    throw new PeerLeakageDetected('peer challenge', peer.challengeText.slice(0, 60));
  }
  if (!allowPeerChunk && peer.chunkText.length > 0 && prompt.includes(peer.chunkText)) {
    throw new PeerLeakageDetected('peer chunk', peer.chunkText.slice(0, 60));
  }

  const effectiveWindow = allowPeerChunk ? Math.max(windowChars, DECISION_WINDOW_CHARS) : windowChars;
  const promptWindows = windows(prompt, effectiveWindow);
  const targets = allowPeerChunk
    ? [['peer challenge', peer.challengeText]]
    : [['peer chunk', peer.chunkText], ['peer challenge', peer.challengeText]];

  for (const [kind, text] of targets) {
    for (const w of windows(text, effectiveWindow)) {
      if (promptWindows.has(w)) throw new PeerLeakageDetected(kind, w);
    }
  }

  return {
    checked: allowPeerChunk ? ['sourceRef', 'peer challenge'] : ['sourceRef', 'peer chunk', 'peer challenge'],
    windowChars: effectiveWindow,
    exactStringChecked: allowPeerChunk ? ['sourceRef', 'challengeText'] : ['sourceRef', 'challengeText', 'chunkText'],
    allowPeerChunk,
    /** Stated on the record so a reader cannot mistake this for a semantic guarantee. */
    notChecked: allowPeerChunk
      ? ['peer chunk (present in Round 1 for both arms, by design)', 'paraphrase', 'topic steer', 'semantic leakage']
      : ['paraphrase', 'topic steer', 'semantic leakage'],
  };
}
