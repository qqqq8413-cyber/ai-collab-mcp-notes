import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { PROJECT_ID, humanPrincipalSchema, parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';

// Local operator configuration for the Workspace: which projects exist and where their
// non-authoritative goal queues are kept. CHIEF has no canonical Project entity yet, so
// projects come only from this file. Nothing here is inferred from Controller storage,
// and nothing here is an authority record.

export { PROJECT_ID, humanPrincipalSchema, parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';
const MAX_PROJECTS = 50;

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'control characters are not allowed');

const projectSchema = z.strictObject({
  projectId: z.string().regex(PROJECT_ID, 'projectId must be lower-case letters, digits, and hyphens (at most 63)'),
  displayName: text(80),
  /** Where the project's work lives, for display only (for example "owner/repository" or a local path). Never opened by the Workspace. */
  repository: text(300),
});

const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Directory holding the goal queues. Relative paths resolve against the configuration file's directory. */
  dataDirectory: text(1024),
  humanPrincipal: z.strictObject({ principalRef: humanPrincipalSchema.shape.principalRef }),
  projects: z.array(projectSchema).min(1).max(MAX_PROJECTS),
});

export type WorkspaceProject = Readonly<z.infer<typeof projectSchema>>;
export interface WorkspaceConfig {
  readonly dataDirectory: string;
  readonly humanPrincipal: HumanPrincipalV1;
  readonly projects: readonly WorkspaceProject[];
}

/** A validated, frozen configuration. `baseDirectory` anchors a relative dataDirectory. */
export function parseWorkspaceConfig(input: unknown, baseDirectory: string): WorkspaceConfig {
  const parsed = configSchema.parse(input);
  const ids = new Set<string>();
  for (const project of parsed.projects) {
    if (ids.has(project.projectId)) throw new Error(`Duplicate projectId ${project.projectId}`);
    ids.add(project.projectId);
  }
  const dataDirectory = isAbsolute(parsed.dataDirectory) ? parsed.dataDirectory : resolve(baseDirectory, parsed.dataDirectory);
  return Object.freeze({
    dataDirectory,
    humanPrincipal: parseHumanPrincipalV1({ schemaVersion: 1, kind: 'HUMAN', principalRef: parsed.humanPrincipal.principalRef }),
    projects: Object.freeze(parsed.projects.map((project) => Object.freeze({ ...project }))),
  });
}

export function loadWorkspaceConfig(file: string): WorkspaceConfig {
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read Workspace configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWorkspaceConfig(raw, dirname(path));
}
