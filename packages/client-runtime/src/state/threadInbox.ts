import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

/**
 * `finishing` is a run whose provider turn completed and is persisting as
 * `waiting` until checkpoint capture settles it. `waiting` is a settled run
 * held open by background work that will wake the agent.
 */
export type ThreadActivityStatus =
  | "approval"
  | "input"
  | "starting"
  | "queued"
  | "working"
  | "finishing"
  | "waiting"
  | "limited"
  | "failed"
  | "ready";

type ActivityStatusInput = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
> & {
  readonly pendingBackgroundTasks?: EnvironmentThreadShell["pendingBackgroundTasks"] | undefined;
};

export function resolveThreadActivityStatus(thread: ActivityStatusInput): ThreadActivityStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  switch (thread.runtime?.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "queued":
      return "queued";
    case "running":
      return "working";
    case "waiting":
      // Live children keep the roster, which parks the shell at idle instead,
      // so a remaining waiting run is only checkpoint finalization.
      return "finishing";
    case "idle":
      // Imported and retained provider threads present idle with nothing to wake them.
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "waiting"
        : "ready";
    case "failed":
      return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
    default:
      return "ready";
  }
}

export function threadActivityStatusIsWorking(
  status: ThreadActivityStatus,
): status is "starting" | "queued" | "working" | "finishing" | "waiting" {
  return (
    status === "starting" ||
    status === "queued" ||
    status === "working" ||
    status === "finishing" ||
    status === "waiting"
  );
}

const ACTIVITY_STATUS_LABELS: Partial<Record<ThreadActivityStatus, string>> = {
  starting: "Starting",
  queued: "Queued",
  working: "Working",
  finishing: "Finishing",
  waiting: "Waiting",
};

export function threadActivityStatusLabel(status: ThreadActivityStatus): string | null {
  return ACTIVITY_STATUS_LABELS[status] ?? null;
}

type WorkingThreadInput = ActivityStatusInput &
  Pick<EnvironmentThreadShell, "hasActionableProposedPlan" | "interactionMode" | "latestRun">;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (!threadActivityStatusIsWorking(resolveThreadActivityStatus(thread))) return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/**
 * Keep one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell on each list rebuild, or with
 * null to reset while the beta is off.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<WorkingThreadInput & InboxThreadInput> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
