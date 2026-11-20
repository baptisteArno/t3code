import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as PushService from "./PushService.ts";
import { EnvironmentShell } from "./threadAgentActivity.ts";

export interface WatchedEnvironment {
  readonly label: string;
  readonly wsUrl: string;
  /** A session token with `orchestration:read`, from `t3 auth session issue`. */
  readonly token: Redacted.Redacted<string>;
}

const RECONNECT_DELAY = "5 seconds";

const watchOnce = Effect.fn("EnvironmentWatcher.watch")(function* (
  environment: WatchedEnvironment,
) {
  const push = yield* PushService.PushService;
  const rpc = yield* RpcClient.make(WsRpcGroup);
  const config = yield* rpc[WS_METHODS.serverGetConfig]({});
  const environmentId = config.environment.environmentId;
  yield* Effect.addFinalizer(() => push.suspend(environmentId));
  const shell = new EnvironmentShell(environmentId);
  yield* Effect.logInfo("push service watching environment", {
    label: environment.label,
    environmentId,
  });

  yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.runForEach((item) => {
      const change = shell.apply(item);
      return change === null
        ? Effect.void
        : push.ingest({ source: environment.label, environmentId, ...change });
    }),
  );
});

/** Follows one environment for the life of the service, reconnecting after every drop. */
export const watchEnvironment = (environment: WatchedEnvironment) => {
  const layerSocketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${Redacted.value(environment.token)}` },
      }) as unknown as globalThis.WebSocket,
  );
  // The server refuses a socket that does not name the protocol it speaks.
  const socketUrl = new URL(environment.wsUrl);
  socketUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(socketUrl.toString()).pipe(Layer.provide(layerSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  return watchOnce(environment).pipe(
    Effect.scoped,
    Effect.provide(layerProtocol),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("push service lost an environment; reconnecting", {
          label: environment.label,
          cause,
        }),
    ),
    Effect.andThen(Effect.sleep(RECONNECT_DELAY)),
    Effect.forever,
  );
};
