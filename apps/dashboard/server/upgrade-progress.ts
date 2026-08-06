/**
 * Live progress for the upgrade the app runs on first launch after an update.
 *
 * Lives outside `server/index.ts` for the same reason as `mcp-entry.ts` and
 * `cleanup-routes.ts`: that module calls `start()` at import time, so anything
 * defined inside it boots a listening Fastify server and cannot be unit-tested.
 * This store carries real invariants (when the state may be reset, what is
 * allowed to escape it), so it is worth testing without booting anything —
 * everything here is a pure function over explicit inputs, with no `sdk`, no
 * filesystem and no Fastify.
 */

/** Every step `/api/upgrade/run` can emit, including the two conditional ones
 *  (`reembed`, `integrity`). Typing the step name — rather than documenting a
 *  list somewhere — makes a typo or a forgotten step a `tsc` failure at the
 *  push site, and gives the API reference a single line to point at. */
export type DeployStepName =
  | 'database'
  | 'reembed'
  | 'integrity'
  | 'instructions-claude'
  | 'instructions-copilot'
  | 'instructions-opencode'
  | 'mcp-configs'
  | 'mcp-shadow-check'
  | 'skills'
  | 'hooks'
  | 'version';

export type DeployStepStatus = 'success' | 'error' | 'skipped' | 'warning';

/** One entry in a setup/upgrade/redeploy result list. */
export type DeployStep = {
  step: DeployStepName;
  status: DeployStepStatus;
  message?: string;
};

/** What a step looks like once it is safe to publish on the poll endpoint. */
export type ProgressStep = {
  step: DeployStepName;
  status: DeployStepStatus;
};

export type UpgradeProgress = {
  running: boolean;
  /** ISO timestamp of the run currently described, or of the last one. Doubles
   *  as the run identity a polling client latches onto. */
  startedAt: string | null;
  fromVersion: string | null;
  toVersion: string;
  currentStep: DeployStepName | null;
  steps: ProgressStep[];
};

/**
 * Drop `message` before a step can reach the poll endpoint.
 *
 * `DeployStep.message` is not safe to publish: it carries raw `e.message` text
 * from filesystem errors (absolute paths, and with them the OS username),
 * template paths, and the globally-installed MCP version from the shadow check.
 * `GET /api/upgrade/progress` is unauthenticated like every route here, so the
 * projection is what keeps the payload harmless. The full messages stay in the
 * `POST /api/upgrade/run` response, which the app already consumes.
 */
export function toProgressStep(step: DeployStep): ProgressStep {
  return { step: step.step, status: step.status };
}

export type UpgradeProgressStore = {
  /** Current state. Safe to serialize directly. */
  snapshot(): UpgradeProgress;
  /** Start a new run: clears the previous steps and marks it running. Must be
   *  called only once the caller owns the upgrade lock — a queued second
   *  request that reset here would wipe a live run's steps mid-poll. */
  begin(fromVersion: string | null): void;
  /** Name the phase about to start (or `null` once nothing is pending). */
  setStep(step: DeployStepName | null): void;
  /** Publish a finished step. */
  record(step: DeployStep): void;
  /** End the run. The steps deliberately survive so a client that connects late
   *  can still render what happened; `running` is what says it is over. */
  finish(): void;
};

export function createUpgradeProgress(toVersion: string): UpgradeProgressStore {
  let state: UpgradeProgress = {
    running: false,
    startedAt: null,
    fromVersion: null,
    toVersion,
    currentStep: null,
    steps: [],
  };

  return {
    snapshot: () => ({ ...state, steps: [...state.steps] }),
    begin(fromVersion) {
      state = {
        running: true,
        startedAt: new Date().toISOString(),
        fromVersion,
        toVersion,
        currentStep: null,
        steps: [],
      };
    },
    setStep(step) {
      state.currentStep = step;
    },
    record(step) {
      state.steps.push(toProgressStep(step));
    },
    finish() {
      state.running = false;
      state.currentStep = null;
    },
  };
}
