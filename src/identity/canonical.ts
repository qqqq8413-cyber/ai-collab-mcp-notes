import { z } from 'zod';

// Shared identity vocabulary. These are exact identifiers, not roles, credentials,
// authority, or permission to create a governed Change.
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const GOAL_ID = /^goal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const principalRef = z.string().min(1).max(256)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value), 'principalRef must be exact and contain no control characters');
export const humanPrincipalSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('HUMAN'), principalRef });
export type HumanPrincipalV1 = Readonly<z.infer<typeof humanPrincipalSchema>>;

export function parseHumanPrincipalV1(input: unknown): HumanPrincipalV1 {
  return Object.freeze(humanPrincipalSchema.parse(input));
}
