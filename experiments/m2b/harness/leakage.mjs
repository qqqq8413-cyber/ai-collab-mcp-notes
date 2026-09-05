/**
 * NC-3 — the leakage guard on arm D-1.
 *
 * This protects the experiment's central identifying assumption. If D-1 sees the peer's
 * argument, `C - D1` collapses toward zero and the study concludes "peer information adds
 * nothing" — a wrong answer, in a known direction, that nothing downstream would catch.
 * So the check runs before every D-1 call and throws rather than warns.
 *
 * What it can prove and what it cannot:
 *
 *   CAN   — that the peer chunk text, the challenge text and the sourceRef string do not
 *           appear in the prompt, verbatim or in any contiguous window of `windowChars`.
 *   CANNOT — that the prompt is free of *semantic* or *topic* leakage. A paraphrase of the
 *           peer's point, or a hint that steers D-1 toward the contested subject, passes
 *           this check. Protocol §19 X11 records that residual risk; this module does not
 *           claim to close it.
 *
 * Naming it after what it actually asserts is deliberate — HANDOFF §25 E4 is the
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
 * Contiguous windows of this many characters are compared. Protocol §14 NC-3 specifies 20.
 *
 * 20 is right for the middle round, where none of the peer's text is legitimately present,
 * so any 20-character coincidence is worth stopping for.
 */
export const DEFAULT_WINDOW_CHARS = 20;

/**
 * The window used for the decision prompt, where Round 1 *is* legitimately present.
 *
 * ⚠️ FINDING FOR HARNESS REVIEW. Protocol §14 fixes the window at 20 characters. Building
 * this guard showed 20 is unusable against `challengeText` in the decision prompt: a
 * gate-authored challenge is written *about* a Round 1 passage, so it reuses that
 * passage's vocabulary, and the shared Round 1 block then trips a 20-character match that
 * is not leakage. The synthetic fixture reproduces it — " the same senior edi" is common
 * to the challenge and to the strategist's answer.
 *
 * The guard therefore uses a longer window here, plus an exact full-string test that
 * catches the failure actually worth catching: a whole challenge string transplanted into
 * a D-1 prompt by a harness bug. That is a deviation from the protocol's stated number and
 * is flagged rather than applied silently.
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
