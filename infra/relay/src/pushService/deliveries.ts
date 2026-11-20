import { threadNeedsYouNow } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
  RelayApnsEnvironment,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

import { statusForPhase } from "../agentActivity/agentActivityAggregate.ts";
import {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  alertForTerminalAggregate,
  rowPhasesChanged,
  shouldAlertForActivity,
} from "../agentActivity/agentActivityAlerts.ts";
import {
  isExpiredAgentActivityState,
  notificationForActivity,
} from "../agentActivity/agentActivityPayloads.ts";
import type {
  ApnsLiveActivityAlert,
  ApnsNotificationPayload,
} from "../agentActivity/apnsDeliveryJobs.ts";
import type { NeedsYouThread } from "./threadAgentActivity.ts";

// The delivery choice below follows ApnsDeliveries.ts (chooseDelivery, sendForTarget and the
// alert gate in sendLiveActivity), whose helpers are private to its database rows. Keep both in
// step when upstream changes either.
const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;

export const PushDevice = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  bundleId: Schema.NullOr(Schema.String),
  apsEnvironment: RelayApnsEnvironment,
  pushToken: Schema.NullOr(Schema.String),
  preferences: RelayAgentAwarenessPreferences,
  liveActivity: Schema.Struct({
    token: Schema.NullOr(Schema.String),
    armedAt: Schema.NullOr(Schema.Number),
    lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
    lastDeliveryAt: Schema.NullOr(Schema.Number),
  }),
});
export type PushDevice = typeof PushDevice.Type;

export type ChosenDelivery =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: ApnsLiveActivityAlert | null;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert: ApnsLiveActivityAlert | null;
    }
  | {
      readonly kind: "push_notification";
      readonly token: string;
      readonly notification: ApnsNotificationPayload;
    };

interface DeliveryInput {
  readonly device: PushDevice;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly state?: RelayAgentActivityState | null;
  readonly nowMs: number;
  readonly replay?: boolean;
  /** False until every environment has reported, when an empty aggregate proves nothing. */
  readonly everyEnvironmentReported: boolean;
  /** The user works in a desktop app, which shows the change: cards update without ringing. */
  readonly desktopActive: boolean;
  readonly completedThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => NeedsYouThread | null;
}

type ActivityRow = Pick<RelayAgentActivityState, "environmentId" | "threadId" | "phase">;

// A device that alerts only when a thread needs it turns completions off; a completion that
// proposes a plan or answers quickly still alerts, judged as the web client's filter judges it.
function alertPreferences(input: DeliveryInput) {
  const { preferences } = input.device;
  const minutes = preferences.needsYouQuickReplyMinutes;
  const silent = (row: ActivityRow): boolean => {
    if (minutes === undefined || row.phase !== "completed") return false;
    const thread = input.completedThread(row.environmentId, row.threadId);
    return thread === null || !threadNeedsYouNow(thread, minutes);
  };
  const alertable = (aggregate: RelayAgentActivityAggregateState) =>
    minutes === undefined
      ? aggregate
      : { ...aggregate, activities: aggregate.activities.filter((row) => !silent(row)) };
  return {
    preferences: minutes === undefined ? preferences : { ...preferences, notifyOnCompletion: true },
    silent,
    alertable,
  };
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: number | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) return true;
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) return false;
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) return true;
  if (aggregateNeedsAttention(input.nextAggregate)) return true;
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) return true;
  return (
    input.lastDeliveryAt === null ||
    input.nowMs - input.lastDeliveryAt >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

function notificationForState(input: DeliveryInput): ApnsNotificationPayload | null {
  const state = input.state;
  if (!input.device.pushToken || !state || isExpiredAgentActivityState(state, input.nowMs)) {
    return null;
  }
  const { preferences, silent } = alertPreferences(input);
  if (silent(state)) return null;
  if (!shouldAlertForActivity({ ...state, preferences, nowMs: input.nowMs })) return null;
  return notificationForActivity({ ...state, status: statusForPhase(state.phase) });
}

// Suppressed Live Activity updates must not fall back to alert pushes or unchanged replays would ring.
function chooseLiveActivityDelivery(
  input: DeliveryInput,
): Exclude<ChosenDelivery, { kind: "push_notification" }> | "suppressed" | null {
  const { preferences, liveActivity } = input.device;
  if (preferences.liveActivitiesEnabled === false) {
    return liveActivity.token
      ? { kind: "live_activity_end", token: liveActivity.token, aggregate: null, alert: null }
      : null;
  }
  if (!liveActivity.token) return null;
  if (input.aggregate === null) {
    if (!input.everyEnvironmentReported) return null;
    // Registration replay can precede a new thread's first publish; keep a freshly armed card.
    if (
      liveActivity.armedAt !== null &&
      input.nowMs - liveActivity.armedAt < FRESHLY_ARMED_GRACE_MS
    ) {
      return null;
    }
    return { kind: "live_activity_end", token: liveActivity.token, aggregate: null, alert: null };
  }
  const nextAggregate = input.aggregate;
  const previousAggregate = liveActivity.lastAggregate;
  const alerts = alertPreferences(input);
  if (
    !shouldUpdateLiveActivity({
      previousAggregate,
      nextAggregate,
      lastDeliveryAt: liveActivity.lastDeliveryAt,
      nowMs: input.nowMs,
    })
  ) {
    return "suppressed";
  }
  return {
    kind: "live_activity_update",
    token: liveActivity.token,
    aggregate: nextAggregate,
    alert:
      input.replay || input.desktopActive || !preferences.notificationsEnabled
        ? null
        : (alertForAttentionTransition({
            previousAggregate,
            nextAggregate: alerts.alertable(nextAggregate),
            preferences: alerts.preferences,
          }) ??
          alertForNewlyTerminal({
            previousAggregate,
            nextAggregate: alerts.alertable(nextAggregate),
            preferences: alerts.preferences,
            nowMs: input.nowMs,
            includeUnobserved: true,
          })),
  };
}

/** The APNs requests one device gets for an activity change, in send order. */
export function chooseDeliveries(input: DeliveryInput): ReadonlyArray<ChosenDelivery> {
  const liveActivity = chooseLiveActivityDelivery(input);
  if (liveActivity === "suppressed") return [];
  const notification = input.replay || input.desktopActive ? null : notificationForState(input);
  const pushToken = input.device.pushToken;
  const companion: ReadonlyArray<ChosenDelivery> =
    notification && pushToken
      ? [{ kind: "push_notification", token: pushToken, notification }]
      : [];
  if (liveActivity === null) return companion;
  if (liveActivity.kind === "live_activity_update") return [liveActivity];
  // An ending card alerts only when no companion notification will ring.
  const alerts = alertPreferences(input);
  const endingRow = liveActivity.aggregate?.activities[0];
  const alert =
    input.replay ||
    input.desktopActive ||
    companion.length > 0 ||
    !input.device.preferences.notificationsEnabled ||
    (endingRow !== undefined && alerts.silent(endingRow))
      ? null
      : alertForTerminalAggregate({
          aggregate: liveActivity.aggregate,
          preferences: alerts.preferences,
        });
  return [{ ...liveActivity, alert }, ...companion];
}

export type DeliveryOutcome = "delivered" | "token-invalid" | "failed";

export function applyDeliveryOutcome(
  device: PushDevice,
  delivery: ChosenDelivery,
  outcome: DeliveryOutcome,
  nowMs: number,
): PushDevice {
  if (delivery.kind === "push_notification") {
    return outcome === "token-invalid" && device.pushToken === delivery.token
      ? { ...device, pushToken: null }
      : device;
  }
  if (device.liveActivity.token !== delivery.token) return device;
  switch (outcome) {
    case "failed":
      return device;
    case "token-invalid":
      return {
        ...device,
        liveActivity: { ...device.liveActivity, token: null, armedAt: null },
      };
    case "delivered":
      return {
        ...device,
        liveActivity: {
          ...device.liveActivity,
          token: delivery.kind === "live_activity_end" ? null : delivery.token,
          lastAggregate: delivery.aggregate,
          lastDeliveryAt: nowMs,
        },
      };
  }
}
