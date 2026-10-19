import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadWorking,
  resolveThreadActivityStatus,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("resolveThreadActivityStatus", () => {
  const runtime = (status: "idle" | "queued" | "starting" | "running" | "waiting" | "failed") => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const base = { ...thread("a", false), pendingBackgroundTasks: [] };

  it("keeps a retained idle provider thread ready and out of the Working shelf", () => {
    const imported = { ...base, runtime: runtime("idle") };
    expect(resolveThreadActivityStatus(imported)).toBe("ready");
    expect(isThreadWorking(imported)).toBe(false);
    expect(
      isThreadWorking({ ...imported, pendingBackgroundTasks: [{ taskId: "c", kind: "command" }] }),
    ).toBe(false);

    const held = {
      ...imported,
      pendingBackgroundTasks: [{ taskId: "s", kind: "subagent" as const }],
    };
    expect(resolveThreadActivityStatus(held)).toBe("waiting");
    expect(isThreadWorking(held)).toBe(true);
  });

  it("distinguishes run phases and puts owner requests first", () => {
    expect(resolveThreadActivityStatus({ ...base, runtime: runtime("starting") })).toBe("starting");
    expect(resolveThreadActivityStatus({ ...base, runtime: runtime("queued") })).toBe("queued");
    expect(resolveThreadActivityStatus({ ...base, runtime: runtime("running") })).toBe("working");
    expect(resolveThreadActivityStatus({ ...base, runtime: runtime("waiting") })).toBe("finishing");
    expect(
      resolveThreadActivityStatus({
        ...base,
        runtime: { ...runtime("failed"), lastErrorClass: "usage_limit" as const },
      }),
    ).toBe("limited");
    expect(
      resolveThreadActivityStatus({
        ...base,
        runtime: runtime("running"),
        hasPendingApprovals: true,
      }),
    ).toBe("approval");
    expect(
      resolveThreadActivityStatus({
        ...base,
        runtime: runtime("running"),
        pendingSubagentRequest: "user_input",
      }),
    ).toBe("input");
  });
});
