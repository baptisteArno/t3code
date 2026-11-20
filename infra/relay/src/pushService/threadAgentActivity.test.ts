import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { threadNeedsYouNow } from "@t3tools/client-runtime/state/thread-inbox";
import * as DateTime from "effect/DateTime";

import { EnvironmentShell, environmentAgentActivity } from "./threadAgentActivity.ts";

const environmentId = EnvironmentId.make("env-home");
const projectId = ProjectId.make("project");
const parentId = ThreadId.make("parent");
const childId = ThreadId.make("child");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const providerInstanceId = ProviderInstanceId.make("claude");

const shell_ = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id,
  projectId,
  title: id,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at("2026-11-20T10:00:00.000Z"),
  updatedAt: at("2026-11-20T10:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const activityFor = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  environmentAgentActivity({
    environmentId,
    projects: new Map([[projectId, { title: "t3code" }]]),
    threads: new Map(threads.map((thread) => [thread.id, thread])),
  });

describe("environmentAgentActivity", () => {
  it("lists only top-level threads and lifts a waiting subagent's request onto its parent", () => {
    const child = shell_(childId, {
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
      activityRunStatus: "running",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: "command",
        createdAt: at("2026-11-20T10:01:00.000Z"),
      },
      updatedAt: at("2026-11-20T10:01:00.000Z"),
    });
    const activity = activityFor([shell_(parentId), child]);
    expect([...activity.keys()]).toEqual([parentId]);
    expect(activity.get(parentId)).toMatchObject({
      state: { phase: "waiting_for_approval" },
      subagentRequestId: "request-1",
    });
  });

  it("keeps a completion quiet while its thread is snoozed", () => {
    const completed = {
      status: "completed",
      latestRunCompletedAt: at("2026-11-20T10:05:00.000Z"),
    } as const;
    expect(activityFor([shell_(parentId, completed)]).get(parentId)?.state?.phase).toBe(
      "completed",
    );
    const snoozed = shell_(parentId, {
      ...completed,
      snoozedAt: at("2026-11-20T10:00:00.000Z"),
      snoozedUntil: at("2026-11-20T18:00:00.000Z"),
    });
    expect(activityFor([snoozed]).get(parentId)?.state).toBeNull();
  });

  it("hands a completion's thread to the needs-you filter", () => {
    const answered = (completedAt: string) =>
      activityFor([
        shell_(parentId, {
          status: "completed",
          latestRunId: RunId.make("run-1"),
          latestRunRequestedAt: at("2026-11-20T10:00:00.000Z"),
          latestRunCompletedAt: at(completedAt),
          latestUserAuthoredMessageAt: at("2026-11-20T10:00:00.000Z"),
        }),
      ]).get(parentId)?.completedThread ?? null;
    const quick = answered("2026-11-20T10:03:00.000Z");
    const slow = answered("2026-11-20T10:30:00.000Z");
    expect(quick !== null && threadNeedsYouNow(quick, 5)).toBe(true);
    expect(slow !== null && threadNeedsYouNow(slow, 5)).toBe(false);
    expect(activityFor([shell_(parentId)]).get(parentId)?.completedThread).toBeNull();
  });
});

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "t3code",
  workspaceRoot: "/workspace/t3code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

const snapshot = (threads: ReadonlyArray<OrchestrationV2ThreadShell>, enrichment = false) => ({
  kind: "snapshot" as const,
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [project],
    threads,
    archivedThreads: [],
  },
  ...(enrichment ? { resolvedRepositoryIdentityRoots: [project.workspaceRoot] } : {}),
});

describe("EnvironmentShell", () => {
  it("keeps its threads through a project metadata refresh", () => {
    const shell = new EnvironmentShell(environmentId);
    expect(shell.apply(snapshot([shell_(parentId)]))?.activity.get(parentId)?.state?.phase).toBe(
      "running",
    );
    expect(shell.apply(snapshot([], true))).toBeNull();
    expect(
      shell
        .apply({
          kind: "thread.updated",
          sequence: 1,
          location: "active",
          thread: shell_(parentId),
        })
        ?.activity.get(parentId)?.state?.phase,
    ).toBe("running");
  });

  it("clears the wait a subagent leaves when it moves to another parent", () => {
    const otherParentId = ThreadId.make("other-parent");
    const waitingChild = (parent: ThreadId) =>
      shell_(childId, {
        lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent: "subagent" },
        activityRunStatus: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "command",
          createdAt: at("2026-11-20T10:01:00.000Z"),
        },
      });
    const shell = new EnvironmentShell(environmentId);
    shell.apply(snapshot([shell_(parentId), shell_(otherParentId), waitingChild(parentId)]));
    const change = shell.apply({
      kind: "thread.updated",
      sequence: 1,
      location: "active",
      thread: waitingChild(otherParentId),
    });
    expect(change?.activity.get(otherParentId)?.state?.phase).toBe("waiting_for_approval");
    expect(change?.activity.get(parentId)?.state?.phase).toBe("running");
  });
});
