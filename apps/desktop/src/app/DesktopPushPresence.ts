import { PushServiceApi } from "@t3tools/contracts/pushService";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// The push service forgets a report after 90 s, so one lost report leaves alerts silent.
const REPORT_INTERVAL = Duration.seconds(30);
// Reading an agent's answer can leave the keyboard alone for minutes.
const IDLE_LIMIT_SECONDS = 5 * 60;

const PushServiceConfig = Schema.Struct({
  url: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
const AppPackageMetadata = Schema.Struct({
  t3codePushService: Schema.optional(PushServiceConfig),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

/** The fork's build names the push service in the app's package.json; the env overrides it. */
const readConfig = Effect.gen(function* () {
  const fromEnv = yield* Config.all({
    url: Config.String("T3CODE_PUSH_SERVICE_URL"),
    token: Config.String("T3CODE_PUSH_SERVICE_TOKEN"),
  }).pipe(Config.option);
  if (Option.isSome(fromEnv)) return fromEnv;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(
    environment.path.join(environment.appRoot, "package.json"),
  );
  const metadata = yield* decodeAppPackageMetadata(raw);
  return Option.fromNullishOr(metadata.t3codePushService);
}).pipe(Effect.orElseSucceed(() => Option.none<typeof PushServiceConfig.Type>()));

/**
 * Tells the home server's push service while the user works in this app, so the phone stays
 * quiet about threads the user already sees here. Active means a window has focus and the
 * screen is unlocked with recent input.
 */
const run = Effect.gen(function* () {
  const config = yield* readConfig;
  if (Option.isNone(config)) return;
  const app = yield* ElectronApp.ElectronApp;
  // Idle state and focus need a ready app.
  yield* app.whenReady;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const client = yield* HttpApiClient.make(PushServiceApi, {
    baseUrl: config.value.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(config.value.token)),
  });
  const clientId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const reportedActive = yield* Ref.make(false);

  const report = (active: boolean) =>
    client.presence.reportPresence({ payload: { clientId, active } }).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.catchCause((cause) => Effect.logDebug("push service presence report failed", cause)),
    );
  const check = Effect.gen(function* () {
    const idleState = yield* powerMonitor.getSystemIdleState(IDLE_LIMIT_SECONDS);
    const active = Electron.BrowserWindow.getFocusedWindow() !== null && idleState === "active";
    // An inactive app reports once, when it stops being active.
    if (!active && !(yield* Ref.get(reportedActive))) return;
    yield* Ref.set(reportedActive, active);
    yield* report(active);
  });

  const checks = yield* Queue.sliding<void>(1);
  const requestCheck = () => {
    Queue.offerUnsafe(checks, undefined);
  };
  yield* app.on("browser-window-focus", requestCheck);
  yield* app.on("browser-window-blur", requestCheck);
  yield* powerMonitor.onSimpleEvent("lock-screen", requestCheck);
  yield* powerMonitor.onSimpleEvent("suspend", requestCheck);
  yield* Effect.addFinalizer(() =>
    Ref.get(reportedActive).pipe(
      Effect.flatMap((active) => (active ? report(false) : Effect.void)),
    ),
  );
  yield* Effect.forkScoped(
    Effect.forever(Effect.sleep(REPORT_INTERVAL).pipe(Effect.andThen(Effect.sync(requestCheck)))),
  );
  requestCheck();
  return yield* Effect.forever(Queue.take(checks).pipe(Effect.andThen(check)));
});

export const layer = Layer.effectDiscard(
  Effect.forkScoped(
    run.pipe(
      Effect.catchCause((cause) => Effect.logWarning("push service presence stopped", cause)),
    ),
  ),
);
