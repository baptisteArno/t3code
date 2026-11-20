import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import {
  AgentActivityLedger,
  PUBLISH_CONFIRM_MS,
  type Publication,
} from "./AgentActivityLedger.ts";
import type { ThreadAgentActivity } from "./threadAgentActivity.ts";

const environmentId = EnvironmentId.make("env-mac");
const threadId = ThreadId.make("thread-1");

const state = (
  phase: RelayAgentActivityState["phase"],
  updatedAt = "2026-11-20T10:00:00.000Z",
): RelayAgentActivityState => ({
  environmentId,
  threadId,
  projectTitle: "t3code",
  threadTitle: "Fix the build",
  phase,
  headline: phase,
  modelTitle: "Opus",
  updatedAt,
  deepLink: `/threads/${environmentId}/${threadId}`,
});

const activity = (
  value: RelayAgentActivityState | null,
  extra: Partial<ThreadAgentActivity> = {},
): ThreadAgentActivity => ({
  state: value,
  subagentRequestId: null,
  unsettledCompletion: null,
  completedThread: null,
  ...extra,
});

function ledgerWith(baseline: ThreadAgentActivity) {
  const ledger = new AgentActivityLedger();
  const first = ledger.update({
    environmentId,
    activity: new Map([[threadId, baseline]]),
    replace: true,
    nowMs: 0,
  });
  expect(first.publications).toEqual([]);
  const update = (next: ThreadAgentActivity | null, nowMs: number) =>
    ledger.update({ environmentId, activity: new Map([[threadId, next]]), replace: false, nowMs });
  return { ledger, update };
}

const phases = (result: { readonly publications: ReadonlyArray<Publication> }) =>
  result.publications.map((publication) => publication.state?.phase ?? null);

describe("AgentActivityLedger", () => {
  it("keeps the first snapshot as a silent baseline and publishes later moves at once", () => {
    const { ledger, update } = ledgerWith(activity(state("running")));
    expect(ledger.states().map((row) => row.phase)).toEqual(["running"]);
    expect(phases(update(activity(state("waiting_for_approval")), 1_000))).toEqual([
      "waiting_for_approval",
    ]);
  });

  it("ignores updates that only move the timestamp", () => {
    const { update } = ledgerWith(activity(state("running")));
    expect(phases(update(activity(state("running", "2026-11-20T10:05:00.000Z")), 1_000))).toEqual(
      [],
    );
  });

  it("publishes a new subagent request even when the parent reads the same", () => {
    const { update } = ledgerWith(
      activity(state("waiting_for_approval"), { subagentRequestId: "request-1" }),
    );
    expect(
      phases(
        update(activity(state("waiting_for_approval"), { subagentRequestId: "request-2" }), 1),
      ),
    ).toEqual(["waiting_for_approval"]);
  });

  it("holds a completion until it is confirmed", () => {
    const { ledger, update } = ledgerWith(activity(state("running")));
    const held = update(activity(state("completed")), 1_000);
    expect(phases(held)).toEqual([]);
    expect(held.nextDeadline).toBe(1_000 + PUBLISH_CONFIRM_MS);
    expect(phases(ledger.confirm(1_000 + PUBLISH_CONFIRM_MS))).toEqual(["completed"]);
  });

  it("drops a completion its continuation replaces during the hold", () => {
    const { ledger, update } = ledgerWith(activity(state("running")));
    update(activity(state("completed")), 1_000);
    expect(phases(update(activity(state("running", "2026-11-20T10:00:02.000Z")), 2_000))).toEqual(
      [],
    );
    expect(phases(ledger.confirm(1_000 + PUBLISH_CONFIRM_MS))).toEqual([]);
    expect(ledger.states().map((row) => row.phase)).toEqual(["running"]);
  });

  it("still alerts a completion the user settles during the hold, then clears it", () => {
    const { ledger, update } = ledgerWith(activity(state("running")));
    update(activity(state("completed")), 1_000);
    update(activity(null, { unsettledCompletion: state("completed") }), 2_000);
    const confirmed = ledger.confirm(1_000 + PUBLISH_CONFIRM_MS);
    expect(phases(confirmed)).toEqual(["completed"]);
    expect(phases(ledger.confirm(confirmed.nextDeadline ?? Number.NaN))).toEqual([null]);
    expect(ledger.states()).toEqual([]);
  });

  it("alerts a first completion the user settles during its hold", () => {
    const { ledger, update } = ledgerWith(activity(null));
    update(activity(state("completed")), 1_000);
    update(activity(null, { unsettledCompletion: state("completed") }), 2_000);
    expect(phases(ledger.confirm(1_000 + PUBLISH_CONFIRM_MS))).toEqual(["completed"]);
  });

  it("lists rows newest first, as the relay feeds its aggregate", () => {
    const { ledger } = ledgerWith(activity(state("running", "2026-11-20T10:00:00.000Z")));
    const newer = {
      ...state("running", "2026-11-20T11:00:00.000Z"),
      threadId: ThreadId.make("t2"),
    };
    ledger.update({
      environmentId,
      activity: new Map([[newer.threadId, activity(newer)]]),
      replace: false,
      nowMs: 1,
    });
    expect(ledger.states().map((row) => row.threadId)).toEqual(["t2", threadId]);
  });

  it("clears a thread removed while its environment was disconnected", () => {
    const { ledger, update } = ledgerWith(activity(state("running")));
    update(null, 1);
    ledger.suspend(environmentId);
    ledger.update({ environmentId, activity: new Map(), replace: true, nowMs: 2 });
    expect(phases(ledger.confirm(2 + PUBLISH_CONFIRM_MS))).toEqual([null]);
    expect(ledger.states()).toEqual([]);
  });

  it("clears a thread the next snapshot no longer lists, after the hold", () => {
    const { ledger } = ledgerWith(activity(state("running")));
    const replaced = ledger.update({ environmentId, activity: new Map(), replace: true, nowMs: 1 });
    expect(phases(replaced)).toEqual([]);
    expect(phases(ledger.confirm(1 + PUBLISH_CONFIRM_MS))).toEqual([null]);
  });
});
