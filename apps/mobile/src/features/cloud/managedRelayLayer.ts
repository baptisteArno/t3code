import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import * as PushService from "@t3tools/client-runtime/relay/push-service";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (
  relayUrl: string,
  pushService: PushService.PushServiceConfig | null = null,
) => {
  const relay = ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  });
  return (
    pushService ? PushService.layerMobileRoutes(pushService).pipe(Layer.provide(relay)) : relay
  ).pipe(Layer.provideMerge(layerRelayDpopSigner));
};
