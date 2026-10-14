import { parseAuthorityDocument, type AuthorityDocumentV1 } from '../automation/authority/document.js';
import type { ConfiguredActivationPlan } from './workspace-host-config.js';

// Dynamically loaded only when EXE-C2's live path is explicitly configured. The
// read-only/disabled Trusted Host must not load authority parsing at startup.
export interface TrustedActivationPlan {
  projectId: string;
  goalId: string;
  bundle: { implementationPacket: AuthorityDocumentV1; liveCallAuthorizations: readonly AuthorityDocumentV1[] };
}

export function validateActivationPlans(configured: readonly ConfiguredActivationPlan[]): readonly TrustedActivationPlan[] {
  return Object.freeze(configured.map((plan) => {
    const packet = parseAuthorityDocument(plan.bundle.implementationPacket);
    const grants = plan.bundle.liveCallAuthorizations.map(parseAuthorityDocument);
    if (packet.kind !== 'IMPLEMENTATION_PACKET' || grants.some((doc) => doc.kind !== 'AUTHORIZATION')) {
      throw new Error('The Host requires an externally issued packet and only externally issued grant documents');
    }
    // These are asserted issuer identities, not signatures or Human authentication.
    return Object.freeze({ projectId: plan.projectId, goalId: plan.goalId,
      bundle: Object.freeze({ implementationPacket: packet, liveCallAuthorizations: Object.freeze(grants) }) });
  }));
}
