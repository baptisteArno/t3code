// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ApnsClient from "../agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../agentActivity/ApnsProviderTokens.ts";
import { PUBLISH_CONFIRM_MS } from "./AgentActivityLedger.ts";
import * as PushService from "./PushService.ts";
import type { NeedsYouThread, ThreadAgentActivity } from "./threadAgentActivity.ts";

const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const BUNDLE_ID = "com.baptistearno.t3code";
const homeServer = EnvironmentId.make("env-home");
const macbook = EnvironmentId.make("env-mac");

interface SentRequest {
  readonly url: string;
  readonly topic: string | undefined;
  readonly pushType: string | undefined;
  readonly payload: {
    readonly aps: {
      readonly alert?: { readonly title: string };
      readonly event?: string;
      readonly "content-state"?: { readonly props: string };
    };
  };
}

const state = (
  environmentId: EnvironmentId,
  title: string,
  phase: RelayAgentActivityState["phase"],
): RelayAgentActivityState => ({
  environmentId,
  threadId: ThreadId.make(title),
  projectTitle: "t3code",
  threadTitle: title,
  phase,
  headline: phase,
  modelTitle: "Opus",
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
  deepLink: `/threads/${environmentId}/${title}`,
});

const activityOf = (
  states: ReadonlyArray<RelayAgentActivityState>,
  completedThread: (state: RelayAgentActivityState) => NeedsYouThread | null = () => null,
) =>
  new Map<ThreadId, ThreadAgentActivity>(
    states.map((value) => [
      value.threadId,
      {
        state: value,
        subagentRequestId: null,
        unsettledCompletion: null,
        completedThread: completedThread(value),
      },
    ]),
  );

/** A completed run that answered `minutes` after the user's message. */
const answeredAfter =
  (minutes: Record<string, number>) =>
  (value: RelayAgentActivityState): NeedsYouThread | null => {
    const after = minutes[value.threadTitle];
    if (value.phase !== "completed" || after === undefined) return null;
    return {
      id: value.threadId,
      environmentId: value.environmentId,
      createdAt: "2026-11-20T10:00:00.000Z",
      unsettledAt: null,
      latestRun: {
        runId: RunId.make(`run-${value.threadTitle}`),
        status: "completed",
        requestedAt: "2026-11-20T10:00:00.000Z",
        startedAt: "2026-11-20T10:00:00.000Z",
        completedAt: DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse("2026-11-20T10:00:00.000Z") + after * 60_000),
        ),
        assistantMessageId: null,
      },
      latestUserAuthoredMessageAt: "2026-11-20T10:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      interactionMode: "default",
      hasActionableProposedPlan: false,
    };
  };

const device = (pushToken: string): RelayDeviceRegistrationRequest => ({
  deviceId: "iphone",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 26,
  bundleId: BUNDLE_ID,
  apsEnvironment: "production",
  pushToken,
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
});

/** Runs against a push service whose APNs answers every request with `status`. */
const withPushService = <A, E>(
  status: number,
  body: (
    requests: Array<SentRequest>,
    stateFile: string,
  ) => Effect.Effect<A, E, PushService.PushService | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateFile = `${yield* fs.makeTempDirectoryScoped()}/state.json`;
    const requests: Array<SentRequest> = [];
    const apnsHttp = HttpClient.make((request) =>
      Effect.sync(() => {
        const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
        requests.push({
          url: request.url,
          topic: request.headers["apns-topic"],
          pushType: request.headers["apns-push-type"],
          payload: JSON.parse(new TextDecoder().decode(bytes)),
        });
        const reason = status === 410 ? JSON.stringify({ reason: "Unregistered" }) : "";
        return HttpClientResponse.fromWeb(request, new Response(reason, { status }));
      }),
    );
    const layer = PushService.layer.pipe(
      Layer.provide(
        Layer.succeed(PushService.PushServiceSettings, {
          stateFile,
          environmentCount: 2,
          apns: {
            teamId: "YJ5SMWX927",
            keyId: "KEY1234567",
            privateKey: Redacted.make(privateKey),
            bundleId: BUNDLE_ID,
          },
        }),
      ),
      Layer.provide(ApnsClient.layer),
      Layer.provide([ApnsProviderTokens.layer, Layer.succeed(HttpClient.HttpClient, apnsHttp)]),
    );
    return yield* body(requests, stateFile).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("PushService", () => {
  it.effect("notifies a device without a Live Activity under its own bundle", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerDevice(device("push-token"));
        const running = state(homeServer, "Fix the build", "running");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([running]),
          replace: true,
        });
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([{ ...running, phase: "waiting_for_approval" }]),
          replace: false,
        });
        expect(requests).toEqual([
          expect.objectContaining({
            url: "https://api.push.apple.com/3/device/push-token",
            topic: BUNDLE_ID,
            pushType: "alert",
            payload: expect.objectContaining({
              aps: expect.objectContaining({
                alert: { title: "Fix the build", body: "Approval: t3code" },
              }),
            }),
          }),
        ]);
      }),
    ),
  );

  it.effect("keeps one Live Activity across environments and alerts a confirmed completion", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerDevice(device("push-token"));
        const onHome = state(homeServer, "Home task", "running");
        const onMac = state(macbook, "Mac task", "running");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([onHome]),
          replace: true,
        });
        yield* push.ingest({
          source: "macbook",
          environmentId: macbook,
          activity: activityOf([onMac]),
          replace: true,
        });
        yield* push.registerLiveActivity({
          deviceId: "iphone",
          activityPushToken: "activity-token",
        });
        const replay = requests.at(-1);
        expect(replay?.topic).toBe(`${BUNDLE_ID}.push-type.liveactivity`);
        expect(replay?.payload.aps.alert).toBeUndefined();
        expect(JSON.parse(replay?.payload.aps["content-state"]?.props ?? "{}")).toMatchObject({
          activeCount: 2,
        });

        yield* push.ingest({
          source: "macbook",
          environmentId: macbook,
          activity: activityOf([{ ...onMac, phase: "completed" }]),
          replace: false,
        });
        const beforeConfirmation = requests.length;
        yield* TestClock.adjust(PUBLISH_CONFIRM_MS);
        expect(requests.slice(beforeConfirmation)).toEqual([
          expect.objectContaining({
            pushType: "liveactivity",
            payload: expect.objectContaining({
              aps: expect.objectContaining({
                event: "update",
                alert: expect.objectContaining({ title: "Mac task", body: "Done: t3code" }),
              }),
            }),
          }),
        ]);
      }),
    ),
  );

  it.effect("keeps a registered token when a later registration omits it", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerDevice(device("push-token"));
        const { pushToken: _omitted, ...withoutToken } = device("unused");
        yield* push.registerDevice(withoutToken);
        const running = state(homeServer, "Fix the build", "running");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([running]),
          replace: true,
        });
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([{ ...running, phase: "waiting_for_input" }]),
          replace: false,
        });
        expect(requests.map((request) => request.url)).toEqual([
          "https://api.push.apple.com/3/device/push-token",
        ]);
      }),
    ),
  );

  it.effect("ends no card on an empty aggregate until every environment has reported", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerLiveActivity({
          deviceId: "iphone",
          activityPushToken: "activity-token",
        });
        yield* TestClock.adjust("16 minutes");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([]),
          replace: true,
        });
        yield* push.endIdleLiveActivities;
        expect(requests).toEqual([]);
        const onMac = state(macbook, "Mac task", "running");
        yield* push.ingest({
          source: "macbook",
          environmentId: macbook,
          activity: activityOf([onMac]),
          replace: true,
        });
        expect(requests).toEqual([
          expect.objectContaining({
            url: "https://api.push.apple.com/3/device/activity-token",
            payload: expect.objectContaining({
              aps: expect.objectContaining({ event: "update" }),
            }),
          }),
        ]);
      }),
    ),
  );

  it.effect("ends the card once two entries for one environment have both reported", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerLiveActivity({
          deviceId: "iphone",
          activityPushToken: "activity-token",
        });
        yield* TestClock.adjust("16 minutes");
        const empty = { environmentId: homeServer, activity: activityOf([]), replace: true };
        yield* push.ingest({ source: "home server", ...empty });
        yield* push.ingest({ source: "home server over Tailscale", ...empty });
        yield* push.endIdleLiveActivities;
        expect(requests.map((request) => request.payload.aps.event)).toContain("end");
      }),
    ),
  );

  it.effect("updates the card without an alert when notifications are off", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        const quiet = device("push-token");
        yield* push.registerDevice({
          ...quiet,
          preferences: { ...quiet.preferences, notificationsEnabled: false },
        });
        const running = state(homeServer, "Fix the build", "running");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([running]),
          replace: true,
        });
        yield* push.ingest({
          source: "macbook",
          environmentId: macbook,
          activity: activityOf([]),
          replace: true,
        });
        yield* push.registerLiveActivity({
          deviceId: "iphone",
          activityPushToken: "activity-token",
        });
        const sentBefore = requests.length;
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([{ ...running, phase: "waiting_for_approval" }]),
          replace: false,
        });
        expect(requests.slice(sentBefore)).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              aps: expect.not.objectContaining({ alert: expect.anything() }),
            }),
          }),
        ]);
        expect(requests.at(-1)?.payload.aps.event).toBe("update");
        expect(requests.every((request) => request.pushType === "liveactivity")).toBe(true);
      }),
    ),
  );

  it.effect("alerts a device that wants only threads needing it for quick replies alone", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        const needsYou = (deviceId: string, pushToken: string) => {
          const base = device(pushToken);
          return push.registerDevice({
            ...base,
            deviceId,
            preferences: {
              ...base.preferences,
              notifyOnCompletion: false,
              notifyOnFailure: false,
              needsYouQuickReplyMinutes: 5,
            },
          });
        };
        yield* needsYou("iphone", "iphone-token");
        yield* needsYou("ipad", "ipad-token");
        const quick = state(homeServer, "Quick", "running");
        const slow = state(homeServer, "Slow", "running");
        const replies = answeredAfter({ Quick: 1, Slow: 20 });
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([quick, slow]),
          replace: true,
        });
        yield* push.ingest({
          source: "macbook",
          environmentId: macbook,
          activity: activityOf([]),
          replace: true,
        });
        yield* push.registerLiveActivity({ deviceId: "ipad", activityPushToken: "ipad-activity" });
        const sentBefore = requests.length;
        for (const finished of [slow, quick]) {
          yield* push.ingest({
            source: "home server",
            environmentId: homeServer,
            activity: activityOf([{ ...finished, phase: "completed" }], replies),
            replace: false,
          });
          yield* TestClock.adjust(PUBLISH_CONFIRM_MS);
        }
        const alerts = requests
          .slice(sentBefore)
          .filter((request) => request.payload.aps.alert !== undefined)
          .map((request) => [request.url.split("/").at(-1), request.payload.aps.alert?.title]);
        expect(alerts).toEqual([
          ["iphone-token", "Quick"],
          ["ipad-activity", "Quick"],
        ]);
      }),
    ),
  );

  it.effect("rings nothing while a desktop app is in use, and again once it stops reporting", () =>
    withPushService(200, (requests) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerDevice(device("push-token"));
        const running = state(homeServer, "Fix the build", "running");
        const ingest = (phase: RelayAgentActivityState["phase"]) =>
          push.ingest({
            source: "home server",
            environmentId: homeServer,
            activity: activityOf([{ ...running, phase }]),
            replace: false,
          });
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([running]),
          replace: true,
        });
        yield* push.reportPresence({ clientId: "macbook", active: true });
        yield* ingest("waiting_for_approval");
        yield* ingest("running");
        expect(requests).toEqual([]);

        yield* TestClock.adjust(PushService.PRESENCE_TTL_MS);
        yield* ingest("waiting_for_input");
        expect(requests.map((request) => request.payload.aps.alert?.title)).toEqual([
          "Fix the build",
        ]);
      }),
    ),
  );

  it.effect("forgets a token APNs no longer accepts", () =>
    withPushService(410, (requests, stateFile) =>
      Effect.gen(function* () {
        const push = yield* PushService.PushService;
        yield* push.registerDevice(device("stale-token"));
        const running = state(homeServer, "Fix the build", "running");
        yield* push.ingest({
          source: "home server",
          environmentId: homeServer,
          activity: activityOf([running]),
          replace: true,
        });
        const waiting = (phase: RelayAgentActivityState["phase"]) =>
          push.ingest({
            source: "home server",
            environmentId: homeServer,
            activity: activityOf([{ ...running, phase }]),
            replace: false,
          });
        yield* waiting("waiting_for_approval");
        yield* waiting("running");
        yield* waiting("waiting_for_input");
        expect(requests).toHaveLength(1);
        const saved = yield* (yield* FileSystem.FileSystem).readFileString(stateFile);
        expect(JSON.parse(saved).devices[0].pushToken).toBeNull();
      }),
    ),
  );
});
