import type { HumanPrincipalV1 } from '../identity/canonical.js';

// RA1's injected operational boundary. The Workspace names a project and a goal; the trusted
// host re-derives everything else and establishes the governed Change's one ROOT run in IDLE.
// No raw controller, store, registry, authority or execution capability crosses this port,
// and nothing here starts work: an IDLE run is not execution.

export type GoalRunAdmissionErrorCode = 'UNKNOWN_PROJECT' | 'UNKNOWN_GOAL' | 'UNATTRIBUTED_GOAL' | 'GOAL_PRINCIPAL_MISMATCH' |
  'GOAL_NOT_GOVERNED' | 'CHANGE_SOURCE_BINDING_CONFLICT' | 'REGISTRY_INTEGRITY' | 'GOVERNANCE_STORE_ISOLATION' |
  'RUN_IDENTITY_CONFLICT' | 'RUN_ADMISSION_INTEGRITY' | 'RUN_ADMISSION_UNCERTAIN' | 'RUN_BEYOND_ADMISSION' | 'GOAL_STORE_BUSY';

const messages: Record<GoalRunAdmissionErrorCode, string> = {
  UNKNOWN_PROJECT: 'This project has no trusted governance binding.',
  UNKNOWN_GOAL: 'This goal is not in the durable queue.',
  UNATTRIBUTED_GOAL: 'This goal has no recorded Human attribution.',
  GOAL_PRINCIPAL_MISMATCH: 'This goal belongs to a different Human principal.',
  GOAL_NOT_GOVERNED: 'This goal has no governed Change yet; no run was created.',
  CHANGE_SOURCE_BINDING_CONFLICT: 'This goal no longer matches its governed Change binding; no run was created.',
  REGISTRY_INTEGRITY: 'The Change Registry failed its integrity check; nothing was repaired.',
  GOVERNANCE_STORE_ISOLATION: 'The governance storage isolation check failed.',
  RUN_IDENTITY_CONFLICT: 'This Change already has a different ROOT run; nothing was adopted or rewritten.',
  RUN_ADMISSION_INTEGRITY: 'Run admission state failed its integrity check; nothing was repaired.',
  RUN_ADMISSION_UNCERTAIN: 'Run admission is uncertain after an interrupted write; nothing was repaired. Human recovery is required.',
  RUN_BEYOND_ADMISSION: 'This run has moved beyond admission; this surface reports only an IDLE run.',
  GOAL_STORE_BUSY: 'The goal queue is locked by another operation; nothing was changed.',
};

export class GoalRunAdmissionError extends Error {
  constructor(readonly code: GoalRunAdmissionErrorCode) {
    super(messages[code]);
    this.name = 'GoalRunAdmissionError';
  }
}

interface GovernedChangeFacts {
  change: { kind: 'SLICE'; changeId: string };
  changeKey: string;
  repository: string;
}

/** The Change's ROOT run exists in the Controller store, in IDLE, and nothing has started. */
export interface AdmittedGoalRunView extends GovernedChangeFacts {
  provenance: 'CONTROLLER_STORE';
  state: 'ADMITTED';
  admission: 'ROOT';
  recordClass: 'OPERATIONAL_RECORD';
  runId: string;
  controllerState: 'IDLE';
  execution: 'NOT_STARTED';
  modelStarted: false;
  packetIssued: false;
  authorityGranted: false;
}
/** Governed, but no run exists. ROOT_PENDING: a claim from an interrupted admission that only this Change's run may finish. */
export interface NotAdmittedGoalRunView extends GovernedChangeFacts {
  provenance: 'CONTROLLER_STORE';
  state: 'NOT_ADMITTED';
  rootClaim: 'NONE' | 'ROOT_PENDING';
  runId: null;
  execution: 'NOT_STARTED';
}
export type GoalRunView = AdmittedGoalRunView | NotAdmittedGoalRunView |
  { provenance: 'CHANGE_REGISTRY'; state: 'GOAL_NOT_GOVERNED'; runId: null };

export interface GoalRunAdmissionPort {
  lookup(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalRunView;
  admit(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<AdmittedGoalRunView>;
}
