// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer needs node:http.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PushServiceApi } from "@t3tools/contracts/pushService";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ApnsClient from "../src/agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../src/agentActivity/ApnsProviderTokens.ts";
import { watchEnvironment } from "../src/pushService/EnvironmentWatcher.ts";
import * as PushServiceHttp from "../src/pushService/http.ts";
import * as PushService from "../src/pushService/PushService.ts";

const PushServiceConfigFile = Schema.Struct({
  listen: Schema.Struct({ host: Schema.String, port: Schema.Int }),
  appTokenFile: Schema.String,
  stateFile: Schema.String,
  apns: Schema.Struct({
    teamId: Schema.String,
    keyId: Schema.String,
    keyFile: Schema.String,
    bundleId: Schema.String,
  }),
  environments: Schema.Array(
    Schema.Struct({ label: Schema.String, wsUrl: Schema.String, tokenFile: Schema.String }),
  ),
});
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PushServiceConfigFile));

class PushServiceConfigError extends Schema.TaggedError<PushServiceConfigError>()(
  "PushServiceConfigError",
  {
    operation: Schema.Literals(["read", "create-directory"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.operation === "read"
      ? `Could not read ${this.path}`
      : `Could not create the directory of ${this.path}`;
  }
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readFile = (file: string) =>
    fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          (cause) => new PushServiceConfigError({ operation: "read", path: file, cause }),
        ),
      );
  const readSecret = (file: string) =>
    Effect.map(readFile(file), (value) => Redacted.make(value.trim()));

  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : process.argv[configIndex + 1];
  if (!configPath) {
    return yield* Effect.logError("Usage: node scripts/push-service.ts --config <config.json>");
  }
  const config = yield* readFile(configPath).pipe(Effect.flatMap(decodeConfig));
  const labels = config.environments.map((environment) => environment.label);
  if (new Set(labels).size !== labels.length) {
    // Each label counts once toward "every environment reported".
    return yield* Effect.logError("Each environment in the config needs its own label");
  }
  yield* fs.makeDirectory(path.dirname(config.stateFile), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PushServiceConfigError({
          operation: "create-directory",
          path: config.stateFile,
          cause,
        }),
    ),
  );
  const environments = yield* Effect.forEach(config.environments, (environment) =>
    Effect.map(readSecret(environment.tokenFile), (token) => ({ ...environment, token })),
  );

  const layerPush = PushService.layer.pipe(
    Layer.provide(
      Layer.succeed(PushService.PushServiceSettings, {
        stateFile: config.stateFile,
        environmentCount: config.environments.length,
        apns: {
          teamId: config.apns.teamId,
          keyId: config.apns.keyId,
          bundleId: config.apns.bundleId,
          privateKey: yield* readSecret(config.apns.keyFile),
        },
      }),
    ),
    Layer.provide(ApnsClient.layer),
    Layer.provide([ApnsProviderTokens.layer, FetchHttpClient.layer]),
  );
  const layerHttp = HttpRouter.serve(
    HttpApiBuilder.layer(PushServiceApi).pipe(
      Layer.provide(
        PushServiceHttp.layerMobileApi.pipe(Layer.provide(PushServiceHttp.layerAppAuth)),
      ),
    ),
  ).pipe(
    Layer.provide(
      Layer.succeed(PushServiceHttp.PushServiceAppToken, yield* readSecret(config.appTokenFile)),
    ),
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, config.listen)),
  );
  const layerWork = Layer.effectDiscard(
    Effect.gen(function* () {
      const push = yield* PushService.PushService;
      for (const environment of environments) {
        yield* Effect.forkScoped(watchEnvironment(environment));
      }
      yield* Effect.forkScoped(
        push.endIdleLiveActivities.pipe(Effect.repeat(Schedule.spaced("1 minute"))),
      );
    }),
  );

  return yield* Layer.launch(Layer.mergeAll(layerHttp, layerWork).pipe(Layer.provide(layerPush)));
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
