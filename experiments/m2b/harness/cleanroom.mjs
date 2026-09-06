/**
 * Clean-room annotation packet builder and its leakage scanner.
 *
 * ## What "clean room" has to mean here
 *
 * The annotator's answer is the ground truth the Gate is later measured against. If the
 * packet leaks what the Gate did — which disagreement it picked, which passage it cited,
 * or even which fixture is the intended negative control — then the measurement grades
 * the Gate against a target drawn after seeing its shot. That failure is invisible in the
 * results: Gate precision simply looks good.
 *
 * So the packet carries the original task, the missions, the complete Round 1 outputs and
 * deterministic passage ids, and nothing else. No archetype labels, no expectations, no
 * project history, no arm names. The scanner below refuses to emit a packet that carries
 * any of it.
 *
 * The scanner is a lexical check and is not claimed to be more: it cannot prove the
 * absence of a subtle steer, only the absence of the named terms. Same classification as
 * NC-3 — a diagnostic, not a guarantee.
 */
import { createHash } from 'node:crypto';
import { loadFixture, passagesOf } from './fixtures.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

export class PacketLeakageDetected extends Error {
  constructor(term, context) {
    super(`clean-room packet contains a forbidden term "${term}" — ${context}. Packet is INVALID.`);
    this.name = 'PacketLeakageDetected';
    this.term = term;
  }
}

/**
 * Terms that must never reach a clean-room annotator.
 *
 * Three kinds: things that reveal what the Gate did, things that reveal the experiment's
 * structure, and things that reveal which fixture is which.
 */
export const FORBIDDEN_TERMS = Object.freeze([
  // what the Gate did
  'selectedIssue', 'sourceRef', 'challengeText', 'peer_challenge', 'collaborationIssues',
  'synthesis_gate', 'round2', 'round2_worker', 'decision_synthesis', 'self_review',
  'provisional', 'triggered', 'SKIPPED', 'Gate selected', 'gate output',
  // experiment structure
  'Replay #3', 'Replay #4', 'controlled-replay', 'business_strategist:p5',
  'B_prime', "B'", 'D1', 'D₁', 'arm C', 'arm B', 'M2-A', 'M2-B', 'HANDOFF',
  'peer challenge', 'Targeted Peer-Challenge', 'claims ladder',
  // which fixture is which
  'negative control', 'positive fixture', 'archetype', 'strategy conflict',
  'execution constraint conflict', 'evidence interpretation conflict',
]);

/**
 * Scans packet text for forbidden terms.
 *
 * Case-insensitive, because a leak in different casing is still a leak.
 */
export function scanPacket(text) {
  const haystack = text.toLowerCase();
  const hits = [];
  for (const term of FORBIDDEN_TERMS) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at !== -1) hits.push({ term, context: text.slice(Math.max(0, at - 40), at + term.length + 40).replace(/\s+/g, ' ') });
  }
  return hits;
}

/** Throws on the first hit. A packet that leaks is not sent, not annotated. */
export function assertPacketClean(text) {
  const hits = scanPacket(text);
  if (hits.length) throw new PacketLeakageDetected(hits[0].term, hits[0].context);
  return { scanned: FORBIDDEN_TERMS.length, clean: true, lexicalOnly: true };
}

/**
 * The order fixtures appear in the packet.
 *
 * Deliberately not fixture-id order. If the intended negative control sat last, an
 * annotator who guessed "the odd one out is last" could be right without reading. Fixed
 * rather than random so the packet is reproducible and hashable.
 */
export const PACKET_ORDER = Object.freeze(['fx-03', 'fx-01', 'fx-04', 'fx-02']);

const CONFLICT_INSTRUCTIONS = `# 標註任務 A —— 跨專家分歧判定

你會看到四份彼此獨立的決策情境。每一份包含：原始任務、兩位專家各自的任務指派(mission)、
以及兩位專家各自的完整書面意見。每段意見都已切成有編號的段落。

**請只根據這些內容作答。** 不要推測任何後續系統、模型或流程可能會怎麼處理它們。

對每一份情境，請回答：

**A. 是否存在 material、cross-agent、decision-sensitive 的分歧？**(是 / 否)

- *material*：實質的，不是措辭、語氣、強調或呈現方式的差異
- *cross-agent*：分歧存在於兩位專家之間，不是同一位專家內部的猶豫
- *decision-sensitive*：如果這個分歧被解決，最終決策(選哪個選項、或決策的關鍵條件)
  有實質可能改變

**B. 若「是」**：用一句話描述該分歧。

**C. 若「是」**：指出分歧雙方各自出現在哪些段落編號。

**D. 若「否」**：description 填 null，passageRefs 留空陣列。

## 輸出格式

請輸出一個 JSON 陣列，每份情境一個物件，並在 JSON 之後附上簡短的中文說明。

\`\`\`json
[
  {
    "fixtureId": "...",
    "materialConflict": true,
    "description": "一句話描述",
    "passageRefs": ["<agentId>:pN", "<agentId>:pN"]
  }
]
\`\`\`

\`passageRefs\` 只能使用下面各情境實際列出的段落編號，格式必須完全一致。

四份情境彼此獨立，判斷不需要一致，也不需要湊出特定比例。`;

const GOLD_INSTRUCTIONS = `# 標註任務 B —— 決策必須處理的關鍵議題

你會看到四份彼此獨立的決策情境。每一份包含：原始任務、兩位專家各自的任務指派(mission)、
以及兩位專家各自的完整書面意見。每段意見都已切成有編號的段落。

**請只根據這些內容作答。** 不要推測任何後續系統、模型或流程可能會怎麼處理它們。

對每一份情境，請列出：**一份好的最終決策必須處理的關鍵議題。**

判準：

- 只列**決策相關**的議題 —— 沒有處理它，這個決策就站不住
- 每一項都必須能由原始任務或專家意見中的內容支持，不要引入外部知識
- 每一項要具體到可以判斷「答案有沒有處理它」
- 不要寫成給任何人的提問或挑戰，寫成議題本身
- 數量由情境決定，不要為了湊數而拆分或合併

## 輸出格式

請輸出一個 JSON 陣列，每份情境一個物件，並在 JSON 之後附上簡短的中文說明。

\`\`\`json
[
  {
    "fixtureId": "...",
    "goldIssues": [
      {
        "id": "gi-1",
        "issue": "這個決策必須處理的議題，一到兩句",
        "supportRefs": ["<agentId>:pN"]
      }
    ]
  }
]
\`\`\`

\`supportRefs\` 只能使用下面各情境實際列出的段落編號，格式必須完全一致。`;

/**
 * Builds one combined packet covering all four fixtures.
 *
 * @param {'conflict'|'gold'} kind  which annotation task this packet is for
 */
export function buildCleanRoomPacket(kind) {
  const instructions = kind === 'conflict' ? CONFLICT_INSTRUCTIONS : GOLD_INSTRUCTIONS;
  const parts = [instructions, '\n---\n'];

  for (const fixtureId of PACKET_ORDER) {
    const fx = loadFixture(fixtureId);
    const passages = passagesOf(fx);
    parts.push(`\n# 情境 ${fixtureId}\n`);
    parts.push(`## 原始任務\n\n${fx.snapshot.task}\n`);
    for (const result of fx.snapshot.workerResults) {
      const specialist = fx.roster.specialists.find((s) => s.id === result.agentId);
      parts.push(`\n## 專家 \`${result.agentId}\`\n`);
      parts.push(`**角色:** ${specialist.role}\n`);
      parts.push(`**任務指派:** ${result.mission}\n`);
      parts.push(`**書面意見(依段落編號):**\n`);
      for (const p of passages[result.agentId]) {
        parts.push(`\n\`${p.passageId}\`\n${p.text}\n`);
      }
    }
    parts.push('\n---\n');
  }

  const text = parts.join('\n');
  assertPacketClean(text);
  return { kind, text, sha256: sha256(text), fixtureOrder: [...PACKET_ORDER], bytes: Buffer.byteLength(text) };
}
