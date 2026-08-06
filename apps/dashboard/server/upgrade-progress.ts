/**
 * The deploy step vocabulary, and live progress for the upgrade the app runs on
 * first launch after an update.
 *
 * Owns `DeployStep`/`DeployStepName` for every deploy path (upgrade, redeploy,
 * the startup self-heal), not just the ones that publish progress.
 *
 * Lives outside `server/index.ts` for the same reason as `mcp-entry.ts` and
 * `cleanup-routes.ts`: that module calls `start()` at import time, so anything
 * defined inside it boots a listening Fastify server and cannot be unit-tested.
 * This store carries real invariants (when the state may be reset, what is
 * allowed to escape it, which runs may be replayed), so it is worth testing
 * without booting anything — everything here is a pure function over explicit
 * inputs, with no `sdk`, no filesystem and no Fastify.
 */

/** Every step a deploy can emit, including the two conditional upgrade ones
 *  (`reembed`, `integrity`). Typing the step name — rather than documenting a
 *  list somewhere — makes a typo or a forgotten step a `tsc` failure at the
 *  emit site, and gives the API reference a single line to point at. */
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

/** A finished run, as the upgrade endpoint may replay it. */
export type CompletedRun = {
  fromVersion: string | null;
  steps: DeployStep[];
};

/**
 * A deploy "went well" when nothing failed outright. `warning` is advisory (the
 * global-MCP shadow check); `skipped` is a real shortfall, so it does NOT count
 * — the caller is told to retry.
 *
 * This is also the replay guard: `.version` is written whenever no step hard-
 * errored, so a `skipped` step (re-embed with Ollama still starting) would
 * otherwise leave the upgrade endpoint replaying `success: false` forever and
 * the upgrade screen's Retry button permanently dead.
 */
export function deployWentWell(steps: DeployStep[]): boolean {
  return steps.every((s) => s.status === 'success' || s.status === 'warning');
}

/**
 * Drop `message` before a step can reach the poll endpoint.
 *
 * `DeployStep.message` is not safe to publish: it carries raw `e.message` text
 * from filesystem errors (absolute paths, and with them the OS username),
 * template paths, and the globally-installed MCP version from the shadow check.
 * `GET /api/upgrade/progress` is unauthenticated like every route here, so the
 * projection is what keeps the payload harmless. The full messages stay in the
 * `POST /api/upgrade/run` response, which the app already consumes.
 *
 * Applied at read time, not at write time: nothing can append a step that
 * bypasses the redaction.
 */
export function toProgressStep(step: DeployStep): ProgressStep {
  return { step: step.step, status: step.status };
}

export type UpgradeProgressStore = {
  /** Current state, with messages redacted. Safe to serialize directly. */
  snapshot(): UpgradeProgress;
  /** Steps recorded so far in the running deploy, messages included. */
  steps(): DeployStep[];
  /** The last run that finished, or `null` when none has this process. */
  lastRun(): CompletedRun | null;
  /** Start a new run: clears the previous steps and marks it running. Must be
   *  called only once the caller owns the upgrade lock — a queued second
   *  request that reset here would wipe a live run's steps mid-poll. */
  begin(fromVersion: string | null): void;
  /** Name the phase about to start (or `null` once nothing is pending). */
  setStep(step: DeployStepName | null): void;
  /** Publish a finished step. The single append path for a deploy's results. */
  record(step: DeployStep): void;
  /** End the run. The steps deliberately survive so a client that connects late
   *  can still render what happened; `running` is what says it is over. */
  finish(): void;
};

export function createUpgradeProgress(toVersion: string): UpgradeProgressStore {
  let running = false;
  let startedAt: string | null = null;
  let fromVersion: string | null = null;
  let currentStep: DeployStepName | null = null;
  let steps: DeployStep[] = [];
  let last: CompletedRun | null = null;

  return {
    snapshot: () => ({
      running,
      startedAt,
      fromVersion,
      toVersion,
      currentStep,
      steps: steps.map(toProgressStep),
    }),
    steps: () => [...steps],
    lastRun: () => (last === null ? null : { fromVersion: last.fromVersion, steps: [...last.steps] }),
    begin(from) {
      running = true;
      startedAt = new Date().toISOString();
      fromVersion = from;
      currentStep = null;
      steps = [];
    },
    setStep(step) {
      currentStep = step;
    },
    record(step) {
      steps.push(step);
    },
    finish() {
      running = false;
      currentStep = null;
      last = { fromVersion, steps: [...steps] };
    },
  };
}
