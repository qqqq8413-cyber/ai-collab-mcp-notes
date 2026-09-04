import { callProvider } from '../providers/index.js';
import type { ProviderName } from '../config.js';

export interface Panelist {
  id: string;
  provider: ProviderName;
  model?: string;
}

export interface DebateOptions {
  question: string;
  panel: Panelist[];
  /** Defaults to the first panelist. */
  judge?: { provider: ProviderName; model?: string };
  /** Number of critique/revise rounds after the initial independent answers. Default 1. */
  rounds?: number;
}

interface RoundEntry {
  panelistId: string;
  provider: ProviderName;
  answer: string;
}

export async function runDebate(options: DebateOptions) {
  const { question, panel, rounds = 1 } = options;
  if (panel.length === 0) throw new Error('Debate requires at least one panelist');
  const judge = options.judge ?? panel[0];

  const initialAnswers: RoundEntry[] = await Promise.all(
    panel.map(async (p): Promise<RoundEntry> => {
      const result = await callProvider(p.provider, question, { model: p.model });
      return { panelistId: p.id, provider: p.provider, answer: result.text };
    })
  );

  const roundHistory: RoundEntry[][] = [initialAnswers];
  let currentAnswers = initialAnswers;

  for (let r = 0; r < rounds; r++) {
    const nextAnswers: RoundEntry[] = await Promise.all(
      panel.map(async (p): Promise<RoundEntry> => {
        const othersText = currentAnswers
          .filter((a) => a.panelistId !== p.id)
          .map((a) => `### ${a.panelistId}\n${a.answer}`)
          .join('\n\n');
        const ownPrevious = currentAnswers.find((a) => a.panelistId === p.id)?.answer ?? '';
        const critiquePrompt = `Question:
${question}

Here are answers from other panelists:
${othersText}

Your own previous answer:
${ownPrevious}

Critically evaluate all answers (including your own) for errors or gaps, then give your revised, improved answer to the original question.`;
        const result = await callProvider(p.provider, critiquePrompt, { model: p.model });
        return { panelistId: p.id, provider: p.provider, answer: result.text };
      })
    );
    roundHistory.push(nextAnswers);
    currentAnswers = nextAnswers;
  }

  const judgePrompt = `Question:
${question}

Final answers from each panelist after debate:
${currentAnswers.map((a) => `### ${a.panelistId} (${a.provider})\n${a.answer}`).join('\n\n')}

As an impartial judge, determine the best final answer. You may synthesize the strongest points from multiple panelists. Give the final answer, then briefly explain your reasoning and which panelist(s) contributed the most.`;
  const verdict = await callProvider(judge.provider, judgePrompt, { model: judge.model });

  return {
    rounds: roundHistory,
    finalAnswer: verdict.text,
  };
}
