import { PushServiceApi } from "@t3tools/contracts/pushService";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { ManagedRelayClient, ManagedRelayRequestFailedError } from "./managedRelay.ts";

export interface PushServiceConfig {
  readonly url: string;
  readonly token: string;
}

export const layerMobileRoutes = (config: PushServiceConfig) =>
  Layer.effect(
    ManagedRelayClient,
    Effect.gen(function* () {
      const relay = yield* ManagedRelayClient;
      const client = yield* HttpApiClient.make(PushServiceApi, {
        baseUrl: config.url,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(config.token)),
      });
      return ManagedRelayClient.of({
        ...relay,
        registerDevice: Effect.fn("clientRuntime.pushService.registerDevice")(({ payload }) =>
          client.mobile.registerDevice({ payload }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedRelayRequestFailedError({
                  action: "register relay mobile device",
                  cause,
                }),
            ),
          ),
        ),
        unregisterDevice: Effect.fn("clientRuntime.pushService.unregisterDevice")(({ deviceId }) =>
          client.mobile.unregisterDevice({ params: { deviceId } }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedRelayRequestFailedError({
                  action: "unregister relay mobile device",
                  cause,
                }),
            ),
          ),
        ),
        registerLiveActivity: Effect.fn("clientRuntime.pushService.registerLiveActivity")(
          ({ payload }) =>
            client.mobile.registerLiveActivity({ payload }).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedRelayRequestFailedError({
                    action: "register relay live activity",
                    cause,
                  }),
              ),
            ),
        ),
        getAgentActivitySnapshot: Effect.fn("clientRuntime.pushService.getAgentActivitySnapshot")(
          () =>
            client.mobile.getAgentActivitySnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedRelayRequestFailedError({
                    action: "read relay agent activity snapshot",
                    cause,
                  }),
              ),
            ),
        ),
      });
    }),
  );
