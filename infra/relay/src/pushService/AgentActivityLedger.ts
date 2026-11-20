import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import type { NeedsYouThread, ThreadAgentActivity } from "./threadAgentActivity.ts";

// Same window as the server's relay publisher: a run can end moments before its
// continuation starts, and a removed card may only be a transient gap.
export const PUBLISH_CONFIRM_MS = 5_000;

export interface Publication {
  readonly state: RelayAgentActivityState | null;
}

interface Hold {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly deadline: number;
  heldCompletion: boolean;
}

const NOTHING_PUBLISHED = "null";

function identityOf(activity: ThreadAgentActivity | undefined): string {
  if (!activity?.state) return NOTHING_PUBLISHED;
  const { updatedAt: _updatedAt, ...meaningful } = activity.state;
  // A subagent's next request reads the same as its last one, but it is a new wait.
  return JSON.stringify([meaningful, activity.subagentRequestId]);
}

const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  JSON.stringify([environmentId, threadId]);

/**
 * The relay's rows for one user, fed from every watched environment: what each thread last
 * published, with the server publisher's deduplication and completion confirmation.
 */
export class AgentActivityLedger {
  private readonly rows = new Map<string, RelayAgentActivityState>();
  private readonly published = new Map<string, string>();
  private readonly holds = new Map<string, Hold>();
  private readonly latest = new Map<EnvironmentId, Map<ThreadId, ThreadAgentActivity>>();

  /** Newest first, as the relay lists a user's rows before the aggregate keeps five. */
  states(): ReadonlyArray<RelayAgentActivityState> {
    return [...this.rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  completedThread(environmentId: EnvironmentId, threadId: ThreadId): NeedsYouThread | null {
    return this.latest.get(environmentId)?.get(threadId)?.completedThread ?? null;
  }

  /** A lost connection voids its pending confirmations; the reconnect snapshot opens new ones. */
  suspend(environmentId: EnvironmentId): void {
    for (const [key, hold] of this.holds) {
      if (hold.environmentId === environmentId) this.holds.delete(key);
    }
  }

  /**
   * Records an environment's threads. The first snapshot of an environment is a baseline that
   * publishes nothing; later ones, and deltas, publish what changed.
   */
  update(input: {
    readonly environmentId: EnvironmentId;
    readonly activity: ReadonlyMap<ThreadId, ThreadAgentActivity | null>;
    readonly replace: boolean;
    readonly nowMs: number;
  }): {
    readonly baseline: boolean;
    readonly publications: ReadonlyArray<Publication>;
    readonly nextDeadline: number | null;
  } {
    const current = this.latest.get(input.environmentId);
    if (current === undefined) {
      const baseline = new Map<ThreadId, ThreadAgentActivity>();
      for (const [threadId, activity] of input.activity) {
        if (activity === null) continue;
        baseline.set(threadId, activity);
        if (activity.state === null) continue;
        const key = keyOf(input.environmentId, threadId);
        this.rows.set(key, activity.state);
        this.published.set(key, identityOf(activity));
      }
      this.latest.set(input.environmentId, baseline);
      return { baseline: true, publications: [], nextDeadline: null };
    }
    const touched = new Set<ThreadId>(input.activity.keys());
    if (input.replace) {
      for (const threadId of current.keys()) touched.add(threadId);
      // A thread removed while disconnected is gone from both maps but may still have a row.
      for (const row of this.rows.values()) {
        if (row.environmentId === input.environmentId) touched.add(row.threadId);
      }
      current.clear();
    }
    for (const [threadId, activity] of input.activity) {
      if (activity === null) current.delete(threadId);
      else current.set(threadId, activity);
    }
    return { baseline: false, ...this.evaluate(input.environmentId, touched, input.nowMs) };
  }

  confirm(nowMs: number) {
    const publications: Publication[] = [];
    let nextDeadline: number | null = null;
    for (const environmentId of this.latest.keys()) {
      const due = new Set<ThreadId>();
      for (const hold of this.holds.values()) {
        if (hold.environmentId === environmentId && hold.deadline <= nowMs) due.add(hold.threadId);
      }
      const result = this.evaluate(environmentId, due, nowMs);
      publications.push(...result.publications);
      nextDeadline = earliest(nextDeadline, result.nextDeadline);
    }
    for (const hold of this.holds.values()) nextDeadline = earliest(nextDeadline, hold.deadline);
    return { publications, nextDeadline };
  }

  private evaluate(environmentId: EnvironmentId, threadIds: ReadonlySet<ThreadId>, nowMs: number) {
    const current = this.latest.get(environmentId);
    const publications: Publication[] = [];
    let nextDeadline: number | null = null;
    for (const threadId of threadIds) {
      const key = keyOf(environmentId, threadId);
      const activity = current?.get(threadId);
      const state = activity?.state ?? null;
      const identity = identityOf(activity);
      const heldCompletion = state === null && this.holds.get(key)?.heldCompletion === true;
      // A completion settled during its hold still has to alert, even with nothing published.
      if ((this.published.get(key) ?? NOTHING_PUBLISHED) === identity && !heldCompletion) {
        this.holds.delete(key);
        continue;
      }
      if (state === null || state.phase === "completed") {
        const hold = this.holds.get(key);
        if (hold === undefined) {
          const deadline = nowMs + PUBLISH_CONFIRM_MS;
          this.holds.set(key, {
            environmentId,
            threadId,
            deadline,
            heldCompletion: state !== null,
          });
          nextDeadline = earliest(nextDeadline, deadline);
          continue;
        }
        if (state !== null) hold.heldCompletion = true;
        if (nowMs < hold.deadline) {
          nextDeadline = earliest(nextDeadline, hold.deadline);
          continue;
        }
        // Settled during the hold, not resumed: alert the completion, then clear the card later.
        if (state === null && hold.heldCompletion && activity?.unsettledCompletion) {
          const completion = { ...activity, state: activity.unsettledCompletion };
          publications.push(this.publish(key, completion.state, identityOf(completion)));
          const deadline = nowMs + PUBLISH_CONFIRM_MS;
          this.holds.set(key, { environmentId, threadId, deadline, heldCompletion: false });
          nextDeadline = earliest(nextDeadline, deadline);
          continue;
        }
      }
      this.holds.delete(key);
      publications.push(this.publish(key, state, identity));
    }
    return { publications, nextDeadline };
  }

  private publish(key: string, state: RelayAgentActivityState | null, identity: string) {
    if (state === null) {
      this.rows.delete(key);
      this.published.delete(key);
    } else {
      this.rows.set(key, state);
      this.published.set(key, identity);
    }
    return { state };
  }
}

function earliest(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return current === null ? next : Math.min(current, next);
}
