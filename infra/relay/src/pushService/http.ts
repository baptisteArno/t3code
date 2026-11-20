import { PushServiceApi, PushServiceAppAuth } from "@t3tools/contracts/pushService";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";

import * as PushService from "./PushService.ts";

/** The bearer secret built into the iOS app that registers with this service. */
export class PushServiceAppToken extends Context.Service<
  PushServiceAppToken,
  Redacted.Redacted<string>
>()("t3code-relay/pushService/http/PushServiceAppToken") {}

export const layerAppAuth = Layer.effect(
  PushServiceAppAuth,
  Effect.gen(function* () {
    const appToken = yield* PushServiceAppToken;
    return {
      appBearer: Effect.fn("PushService.http.appAuth")(function* (httpEffect, { credential }) {
        // Effect leaves the scheme separator in decoded HTTP credentials.
        if (Redacted.value(credential).trim() !== Redacted.value(appToken)) {
          return yield* new HttpApiError.Unauthorized({});
        }
        return yield* httpEffect;
      }),
    };
  }),
);

const ok = { ok: true };

export const layerMobileApi = HttpApiBuilder.group(
  PushServiceApi,
  "mobile",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* PushService.PushService;
    return handlers
      .handle("registerDevice", ({ payload }) => push.registerDevice(payload).pipe(Effect.as(ok)))
      .handle("registerLiveActivity", ({ payload }) =>
        push.registerLiveActivity(payload).pipe(Effect.as(ok)),
      )
      .handle("getAgentActivitySnapshot", () => push.snapshot)
      .handle("unregisterDevice", ({ params }) =>
        push.unregisterDevice(params.deviceId).pipe(Effect.as(ok)),
      );
  }),
);
