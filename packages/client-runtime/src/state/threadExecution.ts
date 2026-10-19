import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  latestProviderTurnForAttempt,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderGoal,
  type ServerProviderModel,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "./models.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  const turnStatus = ACTIVITY_RUN_STATUSES.has(run.status)
    ? latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status
    : undefined;
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(turnStatus === undefined || turnStatus === "pending" || turnStatus === "running"
      ? {}
      : { turnEnded: true }),
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  return usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  );
}

function presentedLatestRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent.
 */
export function deriveRunlessWorkStartedAt(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const status = deriveProviderSubagentStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function deriveProviderSubagentStatus(
  projection: OrchestrationV2ThreadProjection,
): ProviderSubagentStatus | null {
  if (!isProviderNativeSubagentThread(projection.thread)) return null;
  const node = projection.nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
}

export function deriveReportedModelSelection(
  projection: OrchestrationV2ThreadProjection,
): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const descriptors = getProviderOptionDescriptors({ caps, selections: selection.options });
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const label = getProviderOptionCurrentLabel(descriptor, selection, reportedSelection);
    if (label) return label;
  }
  return null;
}

const SUBAGENT_STATUS_LABELS: Record<OrchestrationV2ExecutionNode["status"], string> = {
  idle: "Idle",
  pending: "Working",
  running: "Working",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Cancelled",
};

export function formatProviderSubagentStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
): string {
  if (status === null) return "Starting";
  const label = SUBAGENT_STATUS_LABELS[status.status];
  const live = isOrchestrationV2WorkActive(status.status);
  if (!live && status.status !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  const usageLimitedRun = presentedUsageLimitRun(projection);
  const latestRunProjection = presentedLatestRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const liveActivityRun = latestMatchingRun(projection, (run) =>
    ACTIVITY_RUN_STATUSES.has(run.status),
  );
  const backgroundWorkHoldsRun = backgroundWorkHoldsCompletion(
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  );
  // A pull request watch can hold a thread that never ran.
  if (
    latestRun === null &&
    projection.thread.activeProviderThreadId === null &&
    !backgroundWorkHoldsRun
  ) {
    return null;
  }
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    status: usageLimitedRun
      ? "failed"
      : backgroundWorkHoldsRun && latestRunProjection?.status !== "failed"
        ? "idle"
        : (activityRun?.status ?? "idle"),
    activeRunId,
    activityStartedAt:
      liveActivityRun === null
        ? null
        : DateTime.formatIso(orchestrationV2RunWorkStartedAt(liveActivityRun)),
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...threadErrorSummary(
      latestRootProviderFailure(latestRunProjection, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

/**
 * Why the activity run looks the way it does, from persisted projection
 * signals only. Silence is never a signal: a long inference or tool call
 * reports nothing until it ends. Only a stopped or errored provider session for
 * the run's own provider thread reads as a possible stall, and only external
 * work that outlives that session (a command, a dynamic tool, or a live child)
 * overrides it; unfinished assistant or reasoning text cannot advance once the
 * provider is gone. `lastProgressAt` is the newest recorded change to the run's
 * own rows; streamed text may land between records, so present it as recorded
 * progress rather than proof of idleness.
 */
export type ThreadActivityReason =
  | { readonly kind: "approval" | "input" | "queued" | "starting" }
  | {
      readonly kind: "working" | "tools" | "children" | "finishing";
      readonly lastProgressAt: string | null;
    }
  | {
      readonly kind: "may_be_stalled";
      readonly detail: string;
      readonly lastProgressAt: string | null;
    };

type ThreadProjectionRun = OrchestrationV2ThreadProjection["runs"][number];

const TERMINAL_RUN_STATUSES = new Set<ThreadProjectionRun["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const EXTERNAL_TOOL_ITEM_TYPES = new Set<
  OrchestrationV2ThreadProjection["turnItems"][number]["type"]
>(["command_execution", "dynamic_tool"]);

export function deriveThreadActivityReason(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId | null,
): ThreadActivityReason | null {
  const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
  if (pending.some((request) => request.kind === "user_input")) return { kind: "input" };
  if (pending.some((request) => request.kind !== "auth_refresh")) return { kind: "approval" };
  const run =
    runId === null ? undefined : projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined || TERMINAL_RUN_STATUSES.has(run.status)) return null;
  if (run.status === "queued") return { kind: "queued" };
  if (run.status === "preparing" || run.status === "starting") return { kind: "starting" };

  const attempts = projection.attempts.filter((attempt) => attempt.runId === run.id);
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const turns = projection.providerTurns.filter(
    (turn) => turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId),
  );
  const items = projection.turnItems.filter((item) => item.runId === run.id);
  const messages = projection.messages.filter((message) => message.runId === run.id);
  const subagents = projection.subagents.filter((subagent) => subagent.runId === run.id);
  let latestMs = Number.NEGATIVE_INFINITY;
  const observe = (value: DateTime.Utc | null | undefined) => {
    if (value != null) latestMs = Math.max(latestMs, DateTime.toEpochMillis(value));
  };
  observe(run.startedAt);
  observe(run.workStartedAt);
  for (const turn of turns) {
    observe(turn.startedAt);
    observe(turn.completedAt);
  }
  for (const row of [...items, ...messages, ...subagents]) observe(row.updatedAt);
  const lastProgressAt = Number.isFinite(latestMs)
    ? DateTime.formatIso(DateTime.makeUnsafe(latestMs))
    : null;

  if (subagents.some((subagent) => isOrchestrationV2WorkActive(subagent.status))) {
    return { kind: "children", lastProgressAt };
  }
  const activeTurn = latestProviderTurnForAttempt(turns, run.activeAttemptId);
  const turnEnded =
    activeTurn !== undefined && activeTurn.status !== "pending" && activeTurn.status !== "running";
  if (run.status === "waiting" || turnEnded) return { kind: "finishing", lastProgressAt };
  if (
    items.some(
      (item) => EXTERNAL_TOOL_ITEM_TYPES.has(item.type) && isOrchestrationV2WorkActive(item.status),
    )
  ) {
    return { kind: "tools", lastProgressAt };
  }

  const activeAttempt = attempts.find((attempt) => attempt.id === run.activeAttemptId);
  const providerThreadId = activeAttempt?.providerThreadId ?? run.providerThreadId;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === providerThreadId,
  );
  const session = projection.providerSessions.find(
    (candidate) =>
      candidate.id === providerThread?.providerSessionId &&
      candidate.providerInstanceId === run.providerInstanceId,
  );
  if (session?.status === "stopped" || session?.status === "error") {
    const error = session.lastError?.trim();
    return {
      kind: "may_be_stalled",
      detail:
        error !== undefined && error.length > 0
          ? `Provider unavailable: ${error}`
          : session.status === "error"
            ? "Provider session errored"
            : "Provider session stopped",
      lastProgressAt,
    };
  }
  return { kind: "working", lastProgressAt };
}

export interface ThreadActivityReasonPresentation {
  readonly label: string;
  readonly stalled: boolean;
  readonly lastProgressAt: string | null;
}

const ACTIVITY_REASON_LABELS = {
  approval: "Waiting for approval",
  input: "Waiting for your input",
  queued: "Queued",
  starting: "Starting provider",
  working: "Model is working",
  tools: "Running a tool",
  children: "Waiting on subagents",
  finishing: "Finalizing turn",
} as const;

export function presentThreadActivityReason(
  reason: ThreadActivityReason | null,
): ThreadActivityReasonPresentation | null {
  if (reason === null) return null;
  if (reason.kind === "may_be_stalled") {
    return {
      label: `May be stalled: ${reason.detail}`,
      stalled: true,
      lastProgressAt: reason.lastProgressAt,
    };
  }
  return {
    label: ACTIVITY_REASON_LABELS[reason.kind],
    stalled: false,
    lastProgressAt: "lastProgressAt" in reason ? reason.lastProgressAt : null,
  };
}

type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly plural: string }
> = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  background_task: { order: 3, singular: "background task", plural: "background tasks" },
};

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  readonly label: string;
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly waiting: boolean;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function presentPendingBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks
    .map((task): PendingBackgroundWorkItem => {
      const description = task.description?.trim();
      const label =
        task.kind === "subagent" && description !== undefined
          ? formatSubagentDisplayTitle(description).trim()
          : description;
      return {
        taskId: task.taskId,
        kind: task.kind,
        label:
          label === undefined || label.length === 0
            ? BACKGROUND_WORK_KINDS[task.kind].singular
            : label,
        childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
      };
    })
    // `map` returned a new array; Hermes has no `toSorted`.
    .sort(
      (left, right) =>
        BACKGROUND_WORK_KINDS[left.kind].order - BACKGROUND_WORK_KINDS[right.kind].order,
    );
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const noun = BACKGROUND_WORK_KINDS[only.kind].singular;
    const named = only.label !== noun;
    const title = waiting
      ? named
        ? `${only.kind === "monitor" ? "" : `Waiting on ${noun} `}${only.label}`
        : `Waiting on a ${noun}`
      : named
        ? `Running: ${only.label}`
        : `Running a ${noun}`;
    return { title, items, waiting };
  }
  const counts = new Map<BackgroundWorkKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = Array.from(counts, ([kind, count]) => {
    const { singular, plural } = BACKGROUND_WORK_KINDS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  return { title: `${waiting ? "Waiting on" : "Running"} ${joinWithAnd(groups)}`, items, waiting };
}

export interface ProviderGoalPresentation {
  readonly title: string;
  readonly objective: string;
  readonly usage: string | null;
  readonly canResume: boolean;
}

const PROVIDER_GOAL_TITLES: Record<OrchestrationV2ProviderGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function presentProviderGoal(
  goal: OrchestrationV2ProviderGoal,
  working: boolean,
): ProviderGoalPresentation {
  const usage: Array<string> = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget == null
        ? `${formatGoalTokens(goal.tokensUsed)} tokens`
        : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`,
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  if (goal.checks !== undefined && goal.checks > 0) {
    usage.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  }
  return {
    title: goal.status === "active" && !working ? "Goal set" : PROVIDER_GOAL_TITLES[goal.status],
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): ThreadId | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
    case "system":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
