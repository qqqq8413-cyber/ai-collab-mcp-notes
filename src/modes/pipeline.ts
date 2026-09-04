import { callProvider } from '../providers/index.js';
import type { ProviderName } from '../config.js';

export interface PipelineStep {
  provider: ProviderName;
  model?: string;
  system?: string;
  /** Template for this step's prompt. Use {{input}} to refer to the running input; if omitted, the running input is used as-is. */
  promptTemplate?: string;
}

export interface PipelineStepResult {
  step: number;
  provider: ProviderName;
  model: string;
  prompt: string;
  output: string;
}

export interface PipelineResult {
  finalOutput: string;
  history: PipelineStepResult[];
}

export async function runPipeline(input: string, steps: PipelineStep[]): Promise<PipelineResult> {
  if (steps.length === 0) throw new Error('Pipeline requires at least one step');

  let current = input;
  const history: PipelineStepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prompt = step.promptTemplate ? step.promptTemplate.split('{{input}}').join(current) : current;
    const result = await callProvider(step.provider, prompt, {
      model: step.model,
      system: step.system,
    });
    history.push({ step: i + 1, provider: step.provider, model: result.model, prompt, output: result.text });
    current = result.text;
  }

  return { finalOutput: current, history };
}
