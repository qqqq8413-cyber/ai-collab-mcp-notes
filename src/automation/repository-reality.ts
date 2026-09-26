import { z } from 'zod';
import { isSha } from './packet.js';
import { isInstant, parseInstant } from './time.js';
import type { ControllerRun, PostPromotionFacts, PromotionPreflightFacts, RemoteShaEvidence } from './types.js';

const name = z.string().min(1).refine((value) => value.trim() === value);
const sha = z.string().refine(isSha);
const at = z.string().refine(isInstant);
const branchSchema = z.strictObject({ repository: name, branch: name, sha, observedAt: at });
const comparisonSchema = z.strictObject({ repository: name, baseSha: sha, headSha: sha,
  aheadBy: z.number().int().nonnegative(), behindBy: z.number().int().nonnegative(),
  hasBaseOnlyCommits: z.boolean(), observedAt: at });
const ciSchema = z.strictObject({ repository: name, branch: name, sha,
  workflowStatus: z.enum(['PENDING', 'SUCCESS', 'FAILURE']), requiredCheckName: name,
  requiredCheckStatus: z.enum(['PENDING', 'SUCCESS', 'FAILURE']), observedAt: at });
const protectionSchema = z.strictObject({ repository: name, branch: name, protected: z.boolean(),
  requiredChecks: z.array(name), observedAt: at });

export interface RepositoryRealityPort {
  observeBranch(repository: string, branch: string): unknown;
  compare(repository: string, baseSha: string, headSha: string): unknown;
  observeCi(repository: string, branch: string, sha: string): unknown;
  observeProtection(repository: string, branch: string): unknown;
}

const unavailable: RepositoryRealityPort = Object.freeze({
  observeBranch(): never { throw new Error('Repository reality port is not configured'); },
  compare(): never { throw new Error('Repository reality port is not configured'); },
  observeCi(): never { throw new Error('Repository reality port is not configured'); },
  observeProtection(): never { throw new Error('Repository reality port is not configured'); },
});
export function unavailableRepositoryRealityPort(): RepositoryRealityPort { return unavailable; }

function timely(observedAt: string, now: number): void {
  if (parseInstant(observedAt)! > now) throw new Error('Repository observation is from the future');
}
export function readBranch(port: RepositoryRealityPort, repository: string, branch: string, now: number): RemoteShaEvidence {
  const fact = branchSchema.parse(port.observeBranch(repository, branch));
  if (fact.repository !== repository || fact.branch !== branch) throw new Error('Repository branch observation mismatch');
  timely(fact.observedAt, now);
  return { ...fact, source: 'GITHUB' };
}
export function readComparison(port: RepositoryRealityPort, repository: string, baseSha: string,
  headSha: string, now: number) {
  const fact = comparisonSchema.parse(port.compare(repository, baseSha, headSha));
  if (fact.repository !== repository || fact.baseSha !== baseSha || fact.headSha !== headSha) {
    throw new Error('Repository comparison mismatch');
  }
  timely(fact.observedAt, now);
  return fact;
}
export function readCi(port: RepositoryRealityPort, repository: string, branch: string, shaValue: string, now: number) {
  const fact = ciSchema.parse(port.observeCi(repository, branch, shaValue));
  if (fact.repository !== repository || fact.branch !== branch || fact.sha !== shaValue) throw new Error('Repository CI observation mismatch');
  timely(fact.observedAt, now);
  return fact;
}
export function readProtection(port: RepositoryRealityPort, repository: string, branch: string, now: number) {
  const fact = protectionSchema.parse(port.observeProtection(repository, branch));
  if (fact.repository !== repository || fact.branch !== branch) throw new Error('Repository protection observation mismatch');
  timely(fact.observedAt, now);
  return fact;
}
export function readPreflight(port: RepositoryRealityPort, run: ControllerRun, now: number): PromotionPreflightFacts {
  const packet = run.activePacket!;
  const acceptedSha = run.acceptance!.reviewedSha;
  const main = readBranch(port, run.repository, 'main', now);
  const comparison = readComparison(port, run.repository, packet.expectedBaseSha, acceptedSha, now);
  const ci = readCi(port, run.repository, packet.targetBranch, acceptedSha, now);
  const protection = readProtection(port, run.repository, 'main', now);
  return { expectedMainSha: packet.expectedBaseSha, observedMainSha: main.sha, acceptedSha,
    aheadBy: comparison.aheadBy, behindBy: comparison.behindBy,
    hasMainOnlyCommits: comparison.hasBaseOnlyCommits,
    acceptedShaCiPassed: ci.workflowStatus === 'SUCCESS',
    requiredCheckPassed: ci.requiredCheckStatus === 'SUCCESS' && protection.requiredChecks.length === 1 &&
      protection.requiredChecks[0] === ci.requiredCheckName,
    mainProtected: protection.protected };
}
export function readPostPromotion(port: RepositoryRealityPort, run: ControllerRun, now: number):
  { facts: PostPromotionFacts; pending: boolean; requiredCheckPresent: boolean; failed: boolean } {
  const acceptedSha = run.acceptance!.reviewedSha;
  const main = readBranch(port, run.repository, 'main', now);
  if (main.sha !== acceptedSha) throw new Error('Main moved from accepted SHA');
  const ci = readCi(port, run.repository, 'main', acceptedSha, now);
  const protection = readProtection(port, run.repository, 'main', now);
  const requiredCheckPresent = protection.requiredChecks.length === 1 && protection.requiredChecks[0] === ci.requiredCheckName;
  return { facts: { observedMainSha: main.sha, expectedAcceptedSha: acceptedSha,
    mainCiPassed: ci.workflowStatus === 'SUCCESS',
    requiredCheckPassed: ci.requiredCheckStatus === 'SUCCESS' && requiredCheckPresent,
    mainProtected: protection.protected },
  pending: ci.workflowStatus === 'PENDING' || ci.requiredCheckStatus === 'PENDING', requiredCheckPresent,
  failed: ci.workflowStatus === 'FAILURE' || ci.requiredCheckStatus === 'FAILURE' };
}
