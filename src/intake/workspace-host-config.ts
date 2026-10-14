import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { REPOSITORY_PATTERN } from '../automation/admission.js';
import { GOAL_ID, PROJECT_ID } from '../identity/canonical.js';
import { parseWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.js';

const bindingSchema = z.strictObject({ projectId: z.string().regex(PROJECT_ID), repository: z.string().regex(REPOSITORY_PATTERN) });
// Exact, absolute, normalised server-side paths. Never inferred from cwd, Git, the environment or a request.
const root = () => z.string().refine((path) => isAbsolute(path) && normalize(path) === path && !path.endsWith('/') &&
  !/[\u0000-\u001f]/.test(path));
// G1-WE1-R0: read-only execution status, off unless configured. Its principal is checked by the status preflight.
const executionStatusSchema = z.strictObject({ authorityArchiveDirectory: root(), architectPrincipalRef: z.string().min(1).max(256) });
// EXE-C1: explicit opt-in. The full guarded-live settings are validated by the
// governed execution composition, never accepted from an HTTP request.
const activationPlanSchema = z.strictObject({
  projectId: z.string().regex(PROJECT_ID), goalId: z.string().regex(GOAL_ID),
  bundle: z.strictObject({ implementationPacket: z.unknown(), liveCallAuthorizations: z.array(z.unknown()).max(2) }),
});
const executionStepSchema = z.strictObject({
  governedLive: z.unknown(), activationPlans: z.array(activationPlanSchema).max(100).optional(),
});
export interface ConfiguredActivationPlan {
  projectId: string; goalId: string;
  /** Untrusted until the opt-in Host loads the authority validator. Never sent over HTTP. */
  bundle: { implementationPacket: unknown; liveCallAuthorizations: unknown[] };
}
const schema = z.strictObject({ schemaVersion: z.literal(1), workspace: z.unknown(),
  governance: z.strictObject({ changeRegistryDirectory: root(), controllerStoreDirectory: root(),
    repositories: z.array(bindingSchema).min(1).max(50), executionStatus: executionStatusSchema.optional(),
    executionStep: executionStepSchema.optional() }) });

export type GovernedRepositoryBinding = Readonly<z.infer<typeof bindingSchema>>;
export interface TrustedWorkspaceHostConfig {
  readonly workspace: WorkspaceConfig;
  readonly changeRegistryDirectory: string;
  readonly controllerStoreDirectory: string;
  readonly governedRepositories: readonly GovernedRepositoryBinding[];
  /** G1-WE1-R0 read-only execution status: null (disabled) unless explicitly configured. */
  readonly executionStatus: Readonly<{ authorityArchiveDirectory: string; architectPrincipalRef: string }> | null;
  /** EXE-C1: optional governed one-step execution; off unless fully configured. */
  readonly executionStep: Readonly<{ governedLive: unknown; activationPlans: readonly ConfiguredActivationPlan[] }> | null;
}

export function parseGovernedRepositories(input: unknown, workspace: WorkspaceConfig): readonly GovernedRepositoryBinding[] {
  const bindings = z.array(bindingSchema).min(1).max(50).parse(input);
  const projects = new Set(workspace.projects.map((project) => project.projectId));
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!projects.has(binding.projectId) || seen.has(binding.projectId)) throw new Error('Invalid or duplicate governed project binding');
    seen.add(binding.projectId);
  }
  if (seen.size !== projects.size) throw new Error('Every Workspace project requires an explicit governed repository binding');
  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}

export function parseTrustedWorkspaceHostConfig(input: unknown, baseDirectory: string): TrustedWorkspaceHostConfig {
  const parsed = schema.parse(input);
  if (parsed.governance.executionStep && !parsed.governance.executionStatus) {
    throw new Error('executionStep requires the existing read-only executionStatus configuration');
  }
  const workspace = parseWorkspaceConfig(parsed.workspace, baseDirectory);
  const plans: ConfiguredActivationPlan[] = [];
  const seen = new Set<string>();
  for (const inputPlan of parsed.governance.executionStep?.activationPlans ?? []) {
    const key = JSON.stringify([inputPlan.projectId, inputPlan.goalId]);
    if (seen.has(key) || !workspace.projects.some((project) => project.projectId === inputPlan.projectId)) {
      throw new Error('Duplicate activation plan or unknown project');
    }
    seen.add(key);
    plans.push({ projectId: inputPlan.projectId, goalId: inputPlan.goalId,
      bundle: { implementationPacket: inputPlan.bundle.implementationPacket,
        liveCallAuthorizations: [...inputPlan.bundle.liveCallAuthorizations] } });
  }
  return Object.freeze({ workspace, changeRegistryDirectory: parsed.governance.changeRegistryDirectory,
    controllerStoreDirectory: parsed.governance.controllerStoreDirectory,
    governedRepositories: parseGovernedRepositories(parsed.governance.repositories, workspace),
    executionStatus: parsed.governance.executionStatus ? Object.freeze({ ...parsed.governance.executionStatus }) : null,
    executionStep: parsed.governance.executionStep ? Object.freeze({
      governedLive: parsed.governance.executionStep.governedLive, activationPlans: Object.freeze(plans),
    }) : null });
}

export function loadTrustedWorkspaceHostConfig(file: string): TrustedWorkspaceHostConfig {
  const path = resolve(file);
  return parseTrustedWorkspaceHostConfig(JSON.parse(readFileSync(path, 'utf8')), dirname(path));
}
