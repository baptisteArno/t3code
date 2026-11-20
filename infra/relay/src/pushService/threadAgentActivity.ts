import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { threadNeedsYouNow } from "@t3tools/client-runtime/state/thread-inbox";
import {
  projectThreadAwarenessV2,
  subagentAwaitsUser,
  type SubagentRequestAwareness,
} from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

export type NeedsYouThread = Parameters<typeof threadNeedsYouNow>[0];

export interface ThreadAgentActivity {
  readonly state: RelayAgentActivityState | null;
  /** The subagent request behind the state's wait, when the thread isn't waiting itself. */
  readonly subagentRequestId: string | null;
  /** The completion a user settlement hides, so a completion confirmed after it still alerts. */
  readonly unsettledCompletion: RelayAgentActivityState | null;
  /** The thread behind a completion, for devices that alert only when a thread needs them. */
  readonly completedThread: NeedsYouThread | null;
}

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

// Mirrors the server's isSnoozed (ThreadSettlementService.ts), which the relay
// publisher applies to completions; it cannot be imported from apps/server.
function isSnoozed(thread: OrchestrationV2ThreadShell, nowMs: number): boolean {
  const snoozedUntilMs = millis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = millis(thread.snoozedAt);
  const request = thread.pendingRuntimeRequest;
  if (
    request !== null &&
    (request.kind !== "user_input" ||
      snoozedAtMs === null ||
      DateTime.toEpochMillis(request.createdAt) > snoozedAtMs)
  ) {
    return false;
  }
  const completedAtMs = millis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}

function snoozedCompletion(
  thread: OrchestrationV2ThreadShell,
  state: RelayAgentActivityState | null,
): boolean {
  const completedAtMs = millis(thread.latestRunCompletedAt);
  if (state?.phase !== "completed" || completedAtMs === null) return false;
  const snoozedAtMs = millis(thread.snoozedAt);
  if (snoozedAtMs !== null && completedAtMs < snoozedAtMs) return false;
  return isSnoozed(thread, completedAtMs);
}

function topLevelThreadId(
  child: OrchestrationV2ThreadShell,
  threads: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): ThreadId | null {
  const seen = new Set<ThreadId>([child.id]);
  let current: OrchestrationV2ThreadShell | undefined = child;
  while (current !== undefined && !isListedThreadLineage(current.lineage)) {
    const parentId: ThreadId | null = current.lineage.parentThreadId;
    if (parentId === null || seen.has(parentId)) return null;
    seen.add(parentId);
    current = threads.get(parentId);
  }
  return current?.id ?? null;
}

function pendingSubagentRequests(
  threads: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): Map<ThreadId, SubagentRequestAwareness> {
  const requests = new Map<ThreadId, SubagentRequestAwareness>();
  for (const child of threads.values()) {
    const request = child.pendingRuntimeRequest;
    if (child.archivedAt !== null || request === null || !subagentAwaitsUser(child)) continue;
    const parentId = topLevelThreadId(child, threads);
    if (parentId === null) continue;
    const current = requests.get(parentId);
    if (current === undefined || DateTime.isGreaterThan(child.updatedAt, current.updatedAt)) {
      requests.set(parentId, {
        requestId: request.id,
        updatedAt: child.updatedAt,
        waitsForInput: request.kind === "user_input",
      });
    }
  }
  return requests;
}

/** What each listed thread of one environment shows, as the server would publish it to the relay. */
export function environmentAgentActivity(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyMap<string, Pick<OrchestrationProjectShell, "title">>;
  readonly threads: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  /** Limits the result to these threads; the others are left out, not cleared. */
  readonly only?: ReadonlySet<ThreadId>;
}): Map<ThreadId, ThreadAgentActivity> {
  const subagentRequests = pendingSubagentRequests(input.threads);
  const activity = new Map<ThreadId, ThreadAgentActivity>();
  for (const thread of input.threads.values()) {
    if (input.only !== undefined && !input.only.has(thread.id)) continue;
    if (!isListedThreadLineage(thread.lineage) || thread.archivedAt !== null) continue;
    const project = input.projects.get(thread.projectId);
    if (project === undefined) continue;
    const awareness = { environmentId: input.environmentId, project, thread };
    const subagentRequest = subagentRequests.get(thread.id) ?? null;
    const state = projectThreadAwarenessV2({
      ...awareness,
      pendingSubagentRequest: subagentRequest,
    });
    const childDrivesWait =
      subagentRequest !== null && state?.phase !== projectThreadAwarenessV2(awareness)?.phase;
    const unsettled =
      thread.settledOverride === "settled"
        ? projectThreadAwarenessV2({ ...awareness, thread: { ...thread, settledOverride: null } })
        : null;
    const published = snoozedCompletion(thread, state) ? null : state;
    const unsettledCompletion = unsettled?.phase === "completed" ? unsettled : null;
    activity.set(thread.id, {
      state: published,
      subagentRequestId: childDrivesWait ? subagentRequest.requestId : null,
      unsettledCompletion,
      completedThread:
        published?.phase === "completed" || unsettledCompletion !== null
          ? presentThreadShell(input.environmentId, thread)
          : null,
    });
  }
  return activity;
}

export interface AgentActivityChange {
  readonly activity: ReadonlyMap<ThreadId, ThreadAgentActivity | null>;
  /** True when `activity` lists every thread, so a thread it leaves out is gone. */
  readonly replace: boolean;
}

/** One environment's shell, as its stream has told it so far. */
export class EnvironmentShell {
  private readonly projects = new Map<ProjectId, OrchestrationProjectShell>();
  private readonly threads = new Map<ThreadId, OrchestrationV2ThreadShell>();

  private readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId) {
    this.environmentId = environmentId;
  }

  /** Applies one stream item; null when it cannot change any thread's agent activity. */
  apply(item: OrchestrationV2ShellStreamItem): AgentActivityChange | null {
    switch (item.kind) {
      case "snapshot":
        // A metadata refresh names the projects it enriched and carries no threads.
        if (item.resolvedRepositoryIdentityRoots !== undefined) {
          for (const project of item.snapshot.projects) this.projects.set(project.id, project);
          return null;
        }
        this.projects.clear();
        this.threads.clear();
        for (const project of item.snapshot.projects) this.projects.set(project.id, project);
        for (const thread of item.snapshot.threads) this.threads.set(thread.id, thread);
        return this.all();
      case "project.updated":
        this.projects.set(item.project.id, item.project);
        return this.all();
      case "project.removed":
        this.projects.delete(item.projectId);
        return this.all();
      case "thread.updated": {
        const previous = this.threads.get(item.thread.id);
        const formerParent = previous ? this.listedThreadOf(previous) : null;
        this.threads.set(item.thread.id, item.thread);
        // A child moved under another parent leaves its former parent's wait behind.
        return this.only([this.listedThreadOf(item.thread), formerParent]);
      }
      case "thread.removed": {
        const removed = this.threads.get(item.threadId);
        const affected = removed ? this.listedThreadOf(removed) : item.threadId;
        this.threads.delete(item.threadId);
        return this.only([affected]);
      }
      case "synchronized":
      case "snapshot-required":
        return null;
    }
  }

  private listedThreadOf(thread: OrchestrationV2ThreadShell): ThreadId | null {
    return isListedThreadLineage(thread.lineage)
      ? thread.id
      : topLevelThreadId(thread, this.threads);
  }

  private all(): AgentActivityChange {
    return {
      activity: environmentAgentActivity({
        environmentId: this.environmentId,
        projects: this.projects,
        threads: this.threads,
      }),
      replace: true,
    };
  }

  private only(threadIds: ReadonlyArray<ThreadId | null>): AgentActivityChange | null {
    const only = new Set(threadIds.filter((threadId) => threadId !== null));
    if (only.size === 0) return null;
    const computed = environmentAgentActivity({
      environmentId: this.environmentId,
      projects: this.projects,
      threads: this.threads,
      only,
    });
    return {
      activity: new Map([...only].map((threadId) => [threadId, computed.get(threadId) ?? null])),
      replace: false,
    };
  }
}
