import type { ProviderName } from '../config.js';
import type { Worker } from '../modes/orchestrator.js';
import { providerSupports } from '../models/capabilities.js';

/**
 * A specialist the Chief can recruit, defined once instead of being re-declared in
 * every tool call.
 *
 * `defaultProvider` is a binding of convenience, not part of the agent's identity. The
 * agent is its role and its capabilities; which model performs that role is a routing
 * decision that the Model Capability Registry and Model Router will own. Until those
 * exist, the binding lives here where it can be overridden per call and replaced in one
 * place — not spread across every caller.
 */
export interface AgentDefinition {
  id: string;
  /** What this specialist is responsible for. Doubles as its system prompt. */
  role: string;
  /**
   * That this specialist is *meant* to gather external evidence rather than reason from
   * what the model already knows.
   *
   * An intention, not a fact. Whether the specialist can actually do it depends on the
   * model it is bound to, and is decided in `resolveWorker` against the model capability
   * registry — an agent cannot talk itself into an EVIDENCE_BACKED label.
   */
  providesEvidence?: boolean;
  defaultProvider: ProviderName;
  defaultModel?: string;
}

export const AGENT_REGISTRY: Record<string, AgentDefinition> = {
  business_strategist: {
    id: 'business_strategist',
    role: 'Business Strategist / Critical Analyst — 商業模式、財務邏輯、商業風險、策略漏洞、可行性、反方觀點',
    defaultProvider: 'claude',
  },
  market_researcher: {
    id: 'market_researcher',
    role: 'Market / Research Analyst — 市場情報、競品、客群、成長機會、外部環境、證據蒐集',
    providesEvidence: true,
    defaultProvider: 'gemini',
  },
  brand_creative: {
    id: 'brand_creative',
    role: 'Brand / Creative Strategist — 品牌策略、Creative Direction、產品化設計、服務設計、差異化',
    defaultProvider: 'openai',
  },
};

/**
 * How a caller names a specialist: by registry id, or as a full inline definition for
 * one-off specialists that do not belong in the registry. An object carrying a known
 * `id` plus a few fields overrides just those fields on the registry entry.
 */
export type WorkerRef =
  | string
  | {
      id: string;
      provider?: ProviderName;
      model?: string;
      role?: string;
      providesEvidence?: boolean;
    };

export interface ResolvedRoster {
  workers: Worker[];
  /**
   * Gaps between what a specialist is meant to do and what its bound model can do.
   * Surfaced rather than silently applied, because a specialist quietly demoted from
   * evidence-gatherer to opinion-haver is the failure this system keeps rediscovering.
   */
  warnings: string[];
}

export function listAgents(): AgentDefinition[] {
  return Object.values(AGENT_REGISTRY);
}

function unknownAgentError(id: string): Error {
  return new Error(
    `Unknown agent "${id}". Registered agents: ${Object.keys(AGENT_REGISTRY).join(', ')}. ` +
      `Pass a full definition (id, provider, role) to use a specialist that is not registered.`
  );
}

interface ResolvedFields {
  id: string;
  provider: ProviderName;
  model?: string;
  role: string;
  providesEvidence: boolean;
}

function resolveFields(ref: WorkerRef): ResolvedFields {
  if (typeof ref === 'string') {
    const agent = AGENT_REGISTRY[ref];
    if (!agent) throw unknownAgentError(ref);
    return {
      id: agent.id,
      provider: agent.defaultProvider,
      model: agent.defaultModel,
      role: agent.role,
      providesEvidence: agent.providesEvidence ?? false,
    };
  }

  const agent = AGENT_REGISTRY[ref.id];

  if (!agent) {
    // Not registered, so the caller must supply everything the orchestrator needs.
    if (!ref.provider || !ref.role) throw unknownAgentError(ref.id);
    return {
      id: ref.id,
      provider: ref.provider,
      model: ref.model,
      role: ref.role,
      providesEvidence: ref.providesEvidence ?? false,
    };
  }

  return {
    id: agent.id,
    provider: ref.provider ?? agent.defaultProvider,
    model: ref.model ?? agent.defaultModel,
    role: ref.role ?? agent.role,
    providesEvidence: ref.providesEvidence ?? agent.providesEvidence ?? false,
  };
}

export function resolveWorker(ref: WorkerRef, warnings: string[] = []): Worker {
  const fields = resolveFields(ref);

  // An agent may be *meant* to gather evidence; only the model decides whether it can.
  let evidenceCapable = false;
  if (fields.providesEvidence) {
    evidenceCapable = providerSupports(fields.provider, 'grounded_retrieval', fields.model);
    if (!evidenceCapable) {
      warnings.push(
        `"${fields.id}" is defined as an evidence-gathering specialist, but ${fields.provider}` +
          `${fields.model ? ` (${fields.model})` : ''} has no grounded_retrieval capability in ` +
          `this codebase, so it will answer from training data like any other specialist. ` +
          `Runs using it cannot be EVIDENCE_BACKED.`
      );
    }
  }

  return {
    id: fields.id,
    provider: fields.provider,
    model: fields.model,
    role: fields.role,
    evidenceCapable,
  };
}

export function resolveRoster(refs: WorkerRef[]): ResolvedRoster {
  const warnings: string[] = [];
  const workers = refs.map((ref) => resolveWorker(ref, warnings));

  const seen = new Set<string>();
  for (const w of workers) {
    if (seen.has(w.id)) {
      throw new Error(`Duplicate specialist "${w.id}" in the roster.`);
    }
    seen.add(w.id);
  }

  return { workers, warnings };
}
