import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { DEFAULT_INBOX_QUICK_REPLY_MINUTES } from "@t3tools/contracts/settings";

import type { Preferences } from "../../persistence/mobile-preferences";
import { supportsAgentAwarenessPush } from "./capabilities";

// Development builds use sandbox APNs; distribution builds use production APNs.
export function resolveApsEnvironment(appVariant: unknown): "sandbox" | "production" {
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeRelayDeviceRegistrationRequest(
  input: {
    readonly deviceId: string;
    readonly label: string;
    readonly appVersion?: string;
    readonly bundleId?: string;
    readonly apsEnvironment?: "sandbox" | "production";
    readonly pushToken?: string;
    readonly pushToStartToken?: string;
    readonly notificationsEnabled: boolean;
    readonly preferences: Preferences;
  } & (
    | { readonly platform?: "ios"; readonly iosMajorVersion: number }
    | {
        readonly platform: "android";
        readonly androidApiLevel: number;
        readonly notificationPermissionGranted: boolean;
      }
  ),
): RelayDeviceRegistrationRequest {
  const pushAvailable = supportsAgentAwarenessPush();
  // Only the fork's push service, which serves iOS, tells a quick reply from any completion.
  const onlyWhenNeeded =
    input.platform !== "android" && input.preferences.notifyOnlyWhenNeeded === true;
  const liveActivitiesEnabled =
    pushAvailable &&
    input.preferences.liveActivitiesEnabled !== false &&
    (input.platform !== "android" ||
      (input.notificationPermissionGranted && Boolean(input.pushToken)));
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: input.platform ?? "ios",
    ...(input.platform === "android"
      ? { androidApiLevel: input.androidApiLevel }
      : { iosMajorVersion: input.iosMajorVersion }),
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    ...(input.pushToStartToken ? { pushToStartToken: input.pushToStartToken } : {}),
    preferences: {
      liveActivitiesEnabled,
      notificationsEnabled: pushAvailable && input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: !onlyWhenNeeded,
      notifyOnFailure: !onlyWhenNeeded,
      ...(onlyWhenNeeded
        ? {
            needsYouQuickReplyMinutes:
              input.preferences.inboxQuickReplyMinutes ?? DEFAULT_INBOX_QUICK_REPLY_MINUTES,
          }
        : {}),
    },
  };
}
