import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { REPOSITORY_PATTERN } from '../automation/admission.js';
import { PROJECT_ID } from '../identity/canonical.js';
import { parseWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.js';

const bindingSchema = z.strictObject({ projectId: z.string().regex(PROJECT_ID), repository: z.string().regex(REPOSITORY_PATTERN) });
// Exact, absolute, normalised server-side paths. Never inferred from cwd, Git, the environment or a request.
const root = () => z.string().refine((path) => isAbsolute(path) && normalize(path) === path && !path.endsWith('/') &&
  !/[\u0000-\u001f]/.test(path));
const schema = z.strictObject({ schemaVersion: z.literal(1), workspace: z.unknown(),
  governance: z.strictObject({ changeRegistryDirectory: root(), controllerStoreDirectory: root(),
    repositories: z.array(bindingSchema).min(1).max(50) }) });

export type GovernedRepositoryBinding = Readonly<z.infer<typeof bindingSchema>>;
export interface TrustedWorkspaceHostConfig {
  readonly workspace: WorkspaceConfig;
  readonly changeRegistryDirectory: string;
  readonly controllerStoreDirectory: string;
  readonly governedRepositories: readonly GovernedRepositoryBinding[];
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
  const workspace = parseWorkspaceConfig(parsed.workspace, baseDirectory);
  return Object.freeze({ workspace, changeRegistryDirectory: parsed.governance.changeRegistryDirectory,
    controllerStoreDirectory: parsed.governance.controllerStoreDirectory,
    governedRepositories: parseGovernedRepositories(parsed.governance.repositories, workspace) });
}

export function loadTrustedWorkspaceHostConfig(file: string): TrustedWorkspaceHostConfig {
  const path = resolve(file);
  return parseTrustedWorkspaceHostConfig(JSON.parse(readFileSync(path, 'utf8')), dirname(path));
}
