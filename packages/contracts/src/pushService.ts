import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";

import {
  RelayAgentActivitySnapshotResponse,
  RelayDeviceRegistrationRequest,
  RelayDeviceUnregistrationParams,
  RelayLiveActivityRegistrationRequest,
  RelayOkResponse,
} from "./relay.ts";

// A self-hosted push service serves the relay's mobile routes for an app built under another
// Apple team, whose pushes T3's APNs key cannot sign.
export class PushServiceAppAuth extends HttpApiMiddleware.Service<PushServiceAppAuth>()(
  "PushServiceAppAuth",
  {
    error: HttpApiError.Unauthorized,
    security: { appBearer: HttpApiSecurity.http({ scheme: "bearer" }) },
  },
) {}

export const PushServiceApi = HttpApi.make("pushService").add(
  HttpApiGroup.make("mobile")
    .add(
      HttpApiEndpoint.post("registerDevice", "/v1/mobile/devices", {
        payload: RelayDeviceRegistrationRequest,
        success: RelayOkResponse,
      }),
      HttpApiEndpoint.post("registerLiveActivity", "/v1/mobile/live-activities", {
        payload: RelayLiveActivityRegistrationRequest,
        success: RelayOkResponse,
      }),
      HttpApiEndpoint.get("getAgentActivitySnapshot", "/v1/mobile/agent-activity", {
        success: RelayAgentActivitySnapshotResponse,
      }),
      HttpApiEndpoint.delete("unregisterDevice", "/v1/mobile/devices/:deviceId", {
        params: RelayDeviceUnregistrationParams,
        success: RelayOkResponse,
      }),
    )
    .middleware(PushServiceAppAuth),
);
