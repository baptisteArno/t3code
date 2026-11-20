import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PushServicePresenceReport } from "@t3tools/contracts/pushService";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentActivitySnapshotResponse,
  RelayApnsEnvironment,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "../agentActivity/agentActivityAggregate.ts";
import { isTerminalPhase } from "../agentActivity/agentActivityPayloads.ts";
import * as ApnsClient from "../agentActivity/ApnsClient.ts";
import { AgentActivityLedger, type Publication } from "./AgentActivityLedger.ts";
import {
  applyDeliveryOutcome,
  chooseDeliveries,
  PushDevice,
  type ChosenDelivery,
  type DeliveryOutcome,
} from "./deliveries.ts";
import type { ThreadAgentActivity } from "./threadAgentActivity.ts";

// A desktop app reports every 30 s while active, so one lost report does not let alerts ring.
export const PRESENCE_TTL_MS = 90_000;

const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

const PushState = Schema.Struct({ devices: Schema.Array(PushDevice) });
const decodePushState = Schema.decodeUnknownEffect(Schema.fromJsonString(PushState));
const encodePushState = Schema.encodeEffect(Schema.fromJsonString(PushState));

const DEFAULT_PREFERENCES = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

function outcomeOf(result: ApnsClient.ApnsDeliveryResult): DeliveryOutcome {
  if (result.ok) return "delivered";
  const permanent =
    result.status === 410 ||
    (result.status === 400 &&
      result.reason !== undefined &&
      PERMANENT_APNS_TOKEN_REASONS.has(result.reason));
  return permanent ? "token-invalid" : "failed";
}

export class PushServiceSettings extends Context.Service<
  PushServiceSettings,
  {
    readonly stateFile: string;
    /** No card ends on an empty aggregate before every configured source has reported since start. */
    readonly environmentCount: number;
    readonly apns: {
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKey: Redacted.Redacted<string>;
      /** For a Live Activity registered before its device. */
      readonly bundleId: string;
    };
  }
>()("t3code-relay/pushService/PushService/PushServiceSettings") {}

export class PushService extends Context.Service<
  PushService,
  {
    readonly registerDevice: (payload: RelayDeviceRegistrationRequest) => Effect.Effect<void>;
    readonly registerLiveActivity: (
      payload: RelayLiveActivityRegistrationRequest,
    ) => Effect.Effect<void>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<void>;
    readonly reportPresence: (report: PushServicePresenceReport) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<RelayAgentActivitySnapshotResponse>;
    /** Records an environment's threads: all of them when `replace`, otherwise only those given. */
    readonly ingest: (input: {
      /** The configured entry that sent it; two entries may reach the same environment. */
      readonly source: string;
      readonly environmentId: EnvironmentId;
      readonly activity: ReadonlyMap<ThreadId, ThreadAgentActivity | null>;
      readonly replace: boolean;
    }) => Effect.Effect<void>;
    /** Drops an environment's pending confirmations when its connection is lost. */
    readonly suspend: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly endIdleLiveActivities: Effect.Effect<void>;
  }
>()("t3code-relay/pushService/PushService") {}

const make = Effect.gen(function* () {
  const settings = yield* PushServiceSettings;
  const fs = yield* FileSystem.FileSystem;
  const apns = yield* ApnsClient.ApnsClient;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const ledger = new AgentActivityLedger();
  const reportedSources = new Set<string>();
  const activeDesktops = new Map<string, number>();
  const desktopActive = (nowMs: number) => {
    for (const [clientId, expiresAt] of activeDesktops) {
      if (expiresAt > nowMs) return true;
      activeDesktops.delete(clientId);
    }
    return false;
  };

  const stored = yield* fs.readFileString(settings.stateFile).pipe(
    Effect.flatMap(decodePushState),
    Effect.catch((error) =>
      fs.exists(settings.stateFile).pipe(
        Effect.orElseSucceed(() => true),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("push service state unreadable; starting without devices", {
                error,
              })
            : Effect.void,
        ),
        Effect.as({ devices: [] }),
      ),
    ),
  );
  const devices = new Map(stored.devices.map((device) => [device.deviceId, device]));

  const write = Effect.fnUntraced(function* (saved: ReadonlyArray<PushDevice>) {
    const json = yield* encodePushState({ devices: saved });
    const temporary = `${settings.stateFile}.tmp`;
    yield* fs.writeFileString(temporary, json);
    yield* fs.rename(temporary, settings.stateFile);
  });
  const persist = Effect.suspend(() => write([...devices.values()]));
  // A failed registration write answers 500, so the app retries instead of trusting it.
  const persistRegistration = Effect.orDie(persist);

  const credentialsFor = (device: PushDevice) => ({
    teamId: settings.apns.teamId,
    keyId: settings.apns.keyId,
    privateKey: settings.apns.privateKey,
    bundleId: device.bundleId ?? settings.apns.bundleId,
    environment: device.apsEnvironment satisfies RelayApnsEnvironment,
  });

  // Untraced: every APNs call below already opens its own relay.apns.* span.
  const send = Effect.fnUntraced(
    function* (device: PushDevice, delivery: ChosenDelivery, nowMs: number) {
      const credentials = credentialsFor(device);
      const issuedAtUnixSeconds = Math.floor(nowMs / 1_000);
      const result =
        delivery.kind === "push_notification"
          ? yield* apns.sendPushNotificationRequest({
              credentials,
              issuedAtUnixSeconds,
              request: apns.makePushNotificationRequest({
                token: delivery.token,
                notification: delivery.notification,
              }),
            })
          : yield* apns.sendLiveActivityRequest({
              credentials,
              issuedAtUnixSeconds,
              request: apns.makeLiveActivityRequest({
                token: delivery.token,
                nowEpochSeconds: issuedAtUnixSeconds,
                nowIso: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
                alert: delivery.alert,
                ...(delivery.kind === "live_activity_update"
                  ? { event: "update" as const, state: delivery.aggregate }
                  : { event: "end" as const, state: delivery.aggregate }),
              }),
            });
      const outcome = outcomeOf(result);
      yield* Effect.logInfo("push service delivery", {
        deviceId: device.deviceId,
        kind: delivery.kind,
        status: result.status,
        reason: result.reason ?? null,
        phase: delivery.kind === "push_notification" ? delivery.notification.phase : null,
        alerted: delivery.kind === "push_notification" || delivery.alert !== null,
        activeCount: delivery.kind === "push_notification" ? null : delivery.aggregate?.activeCount,
      });
      return outcome;
    },
    Effect.catch((error) =>
      Effect.logError("push service delivery failed", { error }).pipe(
        Effect.as<DeliveryOutcome>("failed"),
      ),
    ),
  );

  const deliverTo = Effect.fnUntraced(function* (input: {
    readonly deviceIds: ReadonlyArray<string>;
    readonly aggregate: RelayAgentActivityAggregateState | null;
    readonly state: RelayAgentActivityState | null;
    readonly replay: boolean;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    let changed = false;
    for (const deviceId of input.deviceIds) {
      const device = devices.get(deviceId);
      if (device === undefined) continue;
      let next = device;
      for (const delivery of chooseDeliveries({
        device,
        aggregate: input.aggregate,
        state: input.state,
        nowMs,
        replay: input.replay,
        everyEnvironmentReported: reportedSources.size >= settings.environmentCount,
        desktopActive: desktopActive(nowMs),
        completedThread: (environmentId, threadId) =>
          ledger.completedThread(environmentId, threadId),
      })) {
        next = applyDeliveryOutcome(next, delivery, yield* send(next, delivery, nowMs), nowMs);
      }
      if (next !== device) {
        devices.set(deviceId, next);
        changed = true;
      }
    }
    if (changed) {
      yield* persist.pipe(
        Effect.catch((error) => Effect.logError("push service state write failed", { error })),
      );
    }
  });

  const currentAggregate = Effect.map(Clock.currentTimeMillis, (nowMs) =>
    makeAggregateState({ activeStates: ledger.states(), terminalState: null, nowMs }),
  );

  const replay = Effect.fnUntraced(function* (deviceIds: ReadonlyArray<string>) {
    yield* deliverTo({ deviceIds, aggregate: yield* currentAggregate, state: null, replay: true });
  });

  const deliverPublications = Effect.fnUntraced(function* (
    publications: ReadonlyArray<Publication>,
  ) {
    for (const publication of publications) {
      const nowMs = yield* Clock.currentTimeMillis;
      const state = publication.state;
      yield* deliverTo({
        deviceIds: [...devices.keys()],
        aggregate: makeAggregateState({
          activeStates: ledger.states(),
          terminalState: state && isTerminalPhase(state) ? state : null,
          nowMs,
        }),
        state,
        replay: false,
      });
    }
  });

  const scheduleConfirmation = (deadline: number | null): Effect.Effect<void> =>
    deadline === null
      ? Effect.void
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) => Effect.sleep(Math.max(0, deadline - nowMs))),
          Effect.andThen(
            lock.withPermit(
              Effect.gen(function* () {
                const result = ledger.confirm(yield* Clock.currentTimeMillis);
                yield* deliverPublications(result.publications);
                return result.nextDeadline;
              }),
            ),
          ),
          Effect.flatMap(scheduleConfirmation),
          Effect.forkIn(scope),
          Effect.asVoid,
        );

  return PushService.of({
    registerDevice: Effect.fn("PushService.registerDevice")(function* (payload) {
      if (payload.platform !== "ios") return;
      yield* lock.withPermit(
        Effect.gen(function* () {
          const existing = devices.get(payload.deviceId);
          devices.set(payload.deviceId, {
            deviceId: payload.deviceId,
            label: payload.label,
            // Like the relay, an omitted token or route keeps the one registered before.
            bundleId: payload.bundleId ?? existing?.bundleId ?? null,
            apsEnvironment: payload.apsEnvironment ?? existing?.apsEnvironment ?? "production",
            pushToken: payload.pushToken ?? existing?.pushToken ?? null,
            preferences: payload.preferences,
            liveActivity: existing?.liveActivity ?? {
              token: null,
              armedAt: null,
              lastAggregate: null,
              lastDeliveryAt: null,
            },
          });
          yield* persistRegistration;
          yield* replay([payload.deviceId]);
        }),
      );
    }),
    registerLiveActivity: Effect.fn("PushService.registerLiveActivity")(function* (payload) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const existing = devices.get(payload.deviceId);
          // Keeping the arming time on a refresh keeps the grace from swallowing an owed end.
          const armedAt =
            existing?.liveActivity.token === payload.activityPushToken
              ? (existing.liveActivity.armedAt ?? nowMs)
              : nowMs;
          devices.set(payload.deviceId, {
            ...(existing ?? {
              deviceId: payload.deviceId,
              label: payload.deviceId,
              bundleId: null,
              apsEnvironment: "production",
              pushToken: null,
              preferences: DEFAULT_PREFERENCES,
            }),
            liveActivity: {
              token: payload.activityPushToken,
              armedAt,
              lastAggregate: null,
              lastDeliveryAt: null,
            },
          });
          yield* persistRegistration;
          yield* replay([payload.deviceId]);
        }),
      );
    }),
    unregisterDevice: Effect.fn("PushService.unregisterDevice")(function* (deviceId) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          // Written before it is applied, so a failed write leaves the device for the retry.
          yield* Effect.orDie(
            write([...devices.values()].filter((device) => device.deviceId !== deviceId)),
          );
          devices.delete(deviceId);
        }),
      );
    }),
    reportPresence: Effect.fn("PushService.reportPresence")(function* ({ clientId, active }) {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* lock.withPermit(
        Effect.sync(() => {
          if (active) activeDesktops.set(clientId, nowMs + PRESENCE_TTL_MS);
          else activeDesktops.delete(clientId);
        }),
      );
    }),
    snapshot: Effect.map(currentAggregate, (aggregate) => ({ aggregate })).pipe(
      Effect.withSpan("PushService.snapshot"),
    ),
    ingest: Effect.fn("PushService.ingest")(function* (input) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const { source, ...update } = input;
          const firstReport = input.replace && !reportedSources.has(source);
          if (input.replace) reportedSources.add(source);
          const result = ledger.update({ ...update, nowMs: yield* Clock.currentTimeMillis });
          // A first snapshot publishes nothing but repaints cards from the previous run.
          if (firstReport) yield* replay([...devices.keys()]);
          yield* deliverPublications(result.publications);
          yield* scheduleConfirmation(result.nextDeadline);
        }),
      );
    }),
    suspend: Effect.fn("PushService.suspend")((environmentId) =>
      lock.withPermit(Effect.sync(() => ledger.suspend(environmentId))),
    ),
    // An idle card receives no more publications to clear its expired finished rows.
    endIdleLiveActivities: lock
      .withPermit(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          if (makeAggregateState({ activeStates: ledger.states(), terminalState: null, nowMs })) {
            return;
          }
          const idle = [...devices.values()].filter(({ liveActivity }) => {
            const lastAt = liveActivity.lastDeliveryAt ?? liveActivity.armedAt;
            return (
              liveActivity.token !== null &&
              lastAt !== null &&
              nowMs - lastAt > TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
            );
          });
          if (idle.length > 0) yield* replay(idle.map((device) => device.deviceId));
        }),
      )
      .pipe(Effect.withSpan("PushService.endIdleLiveActivities")),
  });
});

export const layer = Layer.effect(PushService, make);
