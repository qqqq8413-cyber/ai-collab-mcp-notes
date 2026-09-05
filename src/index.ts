#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { availableProviders, isProviderConfigured } from './config.js';
import { listAgents, resolveRoster } from './agents/registry.js';
import {
  MODEL_REGISTRY,
  modelsWithCapability,
  providerSupports,
  unwiredCapabilities,
} from './models/capabilities.js';
import { runPipeline } from './modes/pipeline.js';
import { runOrchestrator } from './modes/orchestrator.js';
import { runDebate } from './modes/debate.js';

const providerEnum = z.enum(['claude', 'openai', 'gemini']);

const server = new McpServer({
  name: 'ai-collab-mcp',
  version: '1.0.0',
});

server.registerTool(
  'list_providers',
  {
    title: 'List configured AI providers',
    description:
      'Lists which AI providers (claude, openai, gemini) currently have API keys configured and are usable in the other tools.',
    inputSchema: {},
  },
  async () => {
    const configured = availableProviders();
    const all = ['claude', 'openai', 'gemini'] as const;
    const status = all.map((p) => `${p}: ${isProviderConfigured(p) ? 'configured' : 'missing API key'}`);
    return {
      content: [
        {
          type: 'text',
          text: `Configured providers: ${configured.join(', ') || 'none'}\n\n${status.join('\n')}`,
        },
      ],
    };
  }
);

server.registerTool(
  'list_agents',
  {
    title: 'List registered specialists',
    description:
      'Lists the specialists registered for run_orchestrator: id, role, which provider currently performs the role, and whether the specialist gathers external evidence. Pass these ids in run_orchestrator\'s workers array instead of redeclaring each specialist.',
    inputSchema: {},
  },
  async () => {
    const lines = listAgents().map((a) => {
      const model = a.defaultModel ? ` (${a.defaultModel})` : '';
      // What the agent is for, and separately whether its bound model can actually do it.
      let evidence = '';
      if (a.providesEvidence) {
        evidence = providerSupports(a.defaultProvider, 'grounded_retrieval', a.defaultModel)
          ? ' [evidence-gathering]'
          : ' [evidence-gathering INTENDED — bound model cannot retrieve; answers from training data]';
      }
      return `${a.id} — ${a.defaultProvider}${model}${evidence}\n  ${a.role}`;
    });
    return {
      content: [
        {
          type: 'text',
          text: `${lines.join('\n\n')}\n\nProvider bindings are defaults and can be overridden per call; they are not part of an agent's identity. See list_models for what each binding can actually do.`,
        },
      ],
    };
  }
);

server.registerTool(
  'list_models',
  {
    title: 'List model capabilities',
    description:
      'Lists what each model can do as wired up in this codebase — not what its vendor advertises. Use it to see which models support grounded retrieval, and which have verified pricing.',
    inputSchema: {},
  },
  async () => {
    const lines = MODEL_REGISTRY.map((p) => {
      const caps = Object.entries(p.capabilities).map(([name, state]) => {
        // "Offered by the vendor" and "wired up here" are reported separately on purpose.
        const status = state.enabledInRuntime
          ? 'enabled'
          : state.supportedByProvider
            ? 'NOT WIRED UP (vendor offers it)'
            : 'unavailable';
        return `    ${name}: ${status}${state.notes ? ` — ${state.notes}` : ''}`;
      });
      const pricing = p.pricing
        ? `$${p.pricing.inputPerMTokUsd}/$${p.pricing.outputPerMTokUsd} per Mtok (${p.pricing.source}, checked ${p.pricing.checkedOn})`
        : 'pricing: unverified — cost reporting must treat this as unknown, not zero';
      return `${p.provider} / ${p.model}\n  capabilities:\n${caps.join('\n')}\n  ${pricing}`;
    });

    const retrieval = modelsWithCapability('grounded_retrieval');
    const retrievalLine =
      retrieval.length === 0
        ? 'No model has grounded_retrieval enabled, so no specialist can currently gather external evidence — every deep run is a HYPOTHESIS by construction.'
        : `Grounded retrieval enabled on: ${retrieval.map((p) => p.model).join(', ')}. ` +
          `It is attached per call to evidence-gathering specialists only, never by default. ` +
          `A grounded run is labelled PARTIALLY_GROUNDED at best: claim-level coverage is the Validation Layer's job.`;

    const gaps = unwiredCapabilities();
    const gapLine = gaps.length
      ? `\n\nOffered by the vendor but not wired up here: ${gaps
          .map((g) => `${g.profile.model}/${g.capability}`)
          .join(', ')}.`
      : '';

    return {
      content: [{ type: 'text', text: `${lines.join('\n\n')}\n\n${retrievalLine}${gapLine}` }],
    };
  }
);

server.registerTool(
  'run_pipeline',
  {
    title: 'Run a sequential AI pipeline',
    description:
      'Runs a sequential pipeline where each step is handled by a chosen AI provider, and each step\'s output feeds into the next step\'s input (accessible via {{input}} in promptTemplate).',
    inputSchema: {
      input: z.string().describe('The initial input to the pipeline.'),
      steps: z
        .array(
          z.object({
            provider: providerEnum,
            model: z.string().optional(),
            system: z.string().optional(),
            promptTemplate: z
              .string()
              .optional()
              .describe('Prompt template for this step. Use {{input}} for the running input. If omitted, the running input is passed through as-is.'),
          })
        )
        .min(1),
    },
  },
  async ({ input, steps }) => {
    const result = await runPipeline(input, steps);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'run_orchestrator',
  {
    title: 'Run an orchestrator/worker collaboration',
    description:
      'A Chief provider classifies the task\'s complexity, picks the minimum sufficient set of specialists, gives each one coherent mission, then a synthesizer merges their results into one final answer. Specialist count is capped by complexity (simple 1, normal 3, deep 4). Returns a run report: SUCCESS/DEGRADED/FAILED plus an evidence label, and a deep answer with no evidence behind it is marked UNVERIFIED in the output itself.',
    inputSchema: {
      task: z.string().describe('The overall task to accomplish.'),
      orchestrator: z.object({
        provider: providerEnum,
        model: z.string().optional(),
        systemPrompt: z
          .string()
          .optional()
          .describe("Replaces the Chief's standing brief. Omit to use the default Chief of Staff prompt."),
      }),
      workers: z
        .array(
          z.union([
            z
              .string()
              .describe('Id of a registered agent (see list_agents).'),
            z.object({
              id: z.string().describe('Registered agent id, or a new id for an inline specialist.'),
              provider: providerEnum.optional().describe('Overrides the registered default; required for an unregistered id.'),
              model: z.string().optional(),
              role: z.string().optional().describe('Overrides the registered role; required for an unregistered id.'),
              providesEvidence: z
                .boolean()
                .optional()
                .describe(
                  'True if this specialist is meant to gather external evidence rather than reason from training data. Only takes effect if the bound model has grounded_retrieval in the model registry; otherwise the run reports a warning and cannot be EVIDENCE_BACKED.'
                ),
            }),
          ])
        )
        .min(1)
        .describe('The specialists available to the Chief: registered agent ids, or full inline definitions.'),
      synthesizer: z
        .object({ provider: providerEnum, model: z.string().optional() })
        .optional()
        .describe('Provider that synthesizes specialist results. Defaults to the orchestrator.'),
      budget: z
        .object({
          maxSpecialists: z.number().int().min(1).optional(),
          maxCostUsd: z.number().positive().optional(),
          maxLatencySeconds: z.number().positive().optional(),
        })
        .optional()
        .describe('Constraints the Chief must plan within. maxSpecialists is enforced; cost and latency are stated to the Chief as planning constraints.'),
      experimental: z
        .object({
          collaboration: z
            .object({
              enabled: z
                .boolean()
                .default(false)
                .describe(
                  'Off by default. When on and the run is a clean multi-specialist deep run, the synthesis call may also report one cross-specialist challenge, which sends exactly one specialist a targeted second round. Prototype under measurement: not a supported feature, and the deliverable never depends on it.'
                ),
              peerExcerptChars: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(
                  'How much of the referenced passage is quoted into the second round. An experimental parameter with no measurement behind its default; the value used is recorded in the run\'s collaboration report.'
                ),
              disableRound2: z
                .boolean()
                .optional()
                .describe(
                  'Runs the gate but never fires the second round. The control condition for measuring what the gate instruction alone does to the answer, separately from the peer exchange.'
                ),
            })
            .optional(),
        })
        .optional()
        .describe(
          'Prototypes under measurement. Omit for the standard orchestrator: with this absent, the run and its returned payload are identical to a build without it.'
        ),
    },
  },
  async ({ task, orchestrator, workers, synthesizer, budget, experimental }) => {
    const roster = resolveRoster(workers);
    const result = await runOrchestrator({
      task,
      orchestrator,
      workers: roster.workers,
      synthesizer,
      budget,
      experimental,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...result, rosterWarnings: roster.warnings }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  'run_debate',
  {
    title: 'Run a multi-model debate / cross-validation',
    description:
      'Multiple AI providers independently answer the same question, then critique each other\'s answers over one or more rounds, and finally a judge provider synthesizes or selects the best final answer.',
    inputSchema: {
      question: z.string().describe('The question or problem for the panel to answer.'),
      panel: z
        .array(
          z.object({
            id: z.string().describe('Unique id for this panelist.'),
            provider: providerEnum,
            model: z.string().optional(),
          })
        )
        .min(1),
      judge: z
        .object({ provider: providerEnum, model: z.string().optional() })
        .optional()
        .describe('Provider that renders the final verdict. Defaults to the first panelist.'),
      rounds: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Number of critique/revise rounds after the initial independent answers. Default 1.'),
    },
  },
  async ({ question, panel, judge, rounds }) => {
    const result = await runDebate({ question, panel, judge, rounds });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ai-collab-mcp server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting ai-collab-mcp server:', err);
  process.exit(1);
});
