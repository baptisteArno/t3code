import {
  type DeviceError,
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceServiceState,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * `targetArgs` are the flags the command still needs; a bound launcher needs none. `owner` links
 * the parent thread whose device a subagent shares.
 */
export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  host?:
    | { readonly kind: "eas" }
    | { readonly kind: "simlock"; readonly installDirectory?: string },
  owner?: string,
): string {
  const executable = shellWord(command);
  const target = targetArgs.map(shellWord).join(" ");
  const run = (args: string) => [executable, args, target].filter(Boolean).join(" ");
  // Without a deviceId, device_close closes every device the thread has open.
  const closing = `device_close with hostId ${device.hostId} and deviceId ${device.id}`;
  const release = (what: string) =>
    owner === undefined
      ? `call ${closing} and shutdown: true when you are done.`
      : `it stays open in ${owner}: when you are done, call ${closing} and no shutdown, since shutting it down ends ${what} for that thread too.`;
  const platformNotes =
    host?.kind === "simlock"
      ? [
          device.physical
            ? `This is a real device leased from a Simlock pool (alpha in T3 Code). It is not wiped when the lease ends: Simlock removes apps that were not on it when it was enrolled (on an iPhone, not App Store or TestFlight apps) and leaves all other data, including keychain items, so ${release("the lease")}`
            : `This device is leased from a Simlock pool (alpha in T3 Code). The lease returns it to the pool, wiped, when it ends, so ${release("the lease")} It starts with no apps installed.`,
          host.installDirectory
            ? `agent-device accepts install for this lease only when run from ${host.installDirectory}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : host?.kind === "eas"
        ? `This is an Expo Simulators session in the cloud. It bills the Expo account per minute until it stops, so ${release("the session")} It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine.`
        : device.platform === "ios"
          ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
          : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    target === ""
      ? `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`
      : `Drive it with ${executable}. Use this exact path; login shells may reset PATH. Always pass ${target}.`,
    // Screenshots and input need the session agent-device's open starts, and an iOS snapshot also
    // needs its app. device_open does not run open itself: on iOS that can start a minutes-long
    // XCTest runner build.
    "Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.",
    `  ${run("open <bundle-or-package-id> --relaunch")}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run("open <bundle-or-package-id> <deep-link-url>")}`,
    `  ${run("snapshot -i")}  # accessibility tree with @eN refs`,
    `  ${run("press @e3 --settle")}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run("alert accept")}`,
    `  ${run("settings appearance dark")}  # also text-size, permission grant <name>`,
    `  ${run("screenshot /tmp/shot.png")}  # ${device.platform === "ios" ? "iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, " : ""}or call device_screenshot to look`,
    `  ${run("record start --scope device /tmp/run.mp4")}  # then record stop`,
    `  ${run("install <app> <path-to-.app-or-.apk>")}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    "Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.",
    "Each device_open returns its own command; opening another device does not retarget this one.",
    ...(target === ""
      ? [
          "The command is removed when the device closes or T3 Code restarts. If it is missing, call device_open again.",
        ]
      : []),
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireThreadMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason:
          "Agent device access is turned off for this environment. Ask the user to turn on the Device hub and Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.",
      }),
  ),
);

const slicePrefix = (text: string, max: number) =>
  text.slice(0, splitsSurrogatePair(text, max) ? max - 1 : max);

export const resolveHostId = Effect.fn("handlers.resolveHostId")(function* (
  hosts: ReadonlyArray<DeviceHostSummary>,
  hostId: string | undefined,
): Effect.fn.Return<DeviceHostId | undefined, DeviceToolUnavailableError> {
  if (!hostId) return undefined;
  const exact = hosts.find((host) => host.id === hostId);
  if (exact) return exact.id;
  const labelMatches = hosts.filter((host) => host.label.toLowerCase() === hostId.toLowerCase());
  if (labelMatches.length === 1) return labelMatches[0]!.id;
  const candidates = labelMatches.length > 1 ? labelMatches : hosts;
  const listed = [
    ...candidates.slice(0, 10).map((host) => `${slicePrefix(host.label, 64)} (${host.id})`),
    ...(candidates.length > 10 ? [`${candidates.length - 10} more`] : []),
  ].join(", ");
  const selector = slicePrefix(hostId, 128);
  return yield* new DeviceToolUnavailableError({
    reason:
      labelMatches.length > 1
        ? `Several device hosts are named ${selector}; pass one id: ${listed}.`
        : `No device host ${selector}. Known hosts: ${listed || "none"}.`,
  });
});

const hostName = (host: { readonly id: DeviceHostId; readonly label?: string | undefined }) =>
  host.label === undefined ? `hostId ${host.id}` : `'${host.label}' (hostId ${host.id})`;

const mapLocateErrors = <A, R>(
  effect: Effect.Effect<
    A,
    DeviceService.DeviceHostAmbiguousError | DeviceService.DeviceOnOtherHostError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      DeviceHostAmbiguousError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is on more than one host: ${error.hosts.map(hostName).join(", ")}. Pass hostId.`,
          }),
        ),
      DeviceOnOtherHostError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is not on ${hostName(error.host)}. It is on ${error.hosts.map(hostName).join(", ")}; pass that hostId.`,
          }),
        ),
    }),
  );

const failedHosts = <H extends { readonly id: DeviceHostId }>(
  state: { readonly hostStatuses: DeviceServiceState["hostStatuses"] },
  hosts: ReadonlyArray<H>,
) =>
  hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    return status?.status === "failed" && status.detail ? [{ host, detail: status.detail }] : [];
  });

export interface DeviceHolder {
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  readonly threadId: ThreadId;
  readonly threadLink: string;
}

const MAX_LINEAGE_DEPTH = 8;

/** Each thread's subagent parents, nearest first, read from the shells of `threadIds` and above. */
const subagentAncestors = Effect.fn("handlers.subagentAncestors")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const parentOf = (threadId: ThreadId) => {
    const lineage = shells.get(threadId)?.lineage;
    return lineage?.relationshipToParent === "subagent" ? lineage.parentThreadId : null;
  };
  let pending = [...new Set(threadIds)];
  for (let depth = 0; pending.length > 0 && depth < MAX_LINEAGE_DEPTH; depth++) {
    const found = yield* Effect.forEach(pending, threads.getThreadShell, { concurrency: 4 });
    for (const shell of found) if (shell !== null) shells.set(shell.id, shell);
    pending = [
      ...new Set(
        pending.flatMap((threadId) => {
          const parent = parentOf(threadId);
          return parent === null || shells.has(parent) ? [] : [parent];
        }),
      ),
    ];
  }
  const ancestors = (threadId: ThreadId) => {
    const found: Array<ThreadId> = [];
    for (let parent = parentOf(threadId); parent !== null && !found.includes(parent);) {
      found.push(parent);
      parent = parentOf(parent);
    }
    return found;
  };
  return { shells, ancestors };
});

/**
 * The devices other threads have open or are booting, which this thread must leave alone, and its
 * subagent parents, nearest first, whose devices it may share.
 */
const deviceClaims = Effect.fn("handlers.deviceClaims")(function* (
  state: Pick<DeviceServiceState, "hosts" | "sessions" | "bootingDevices">,
  scope: McpInvocationContext.McpThreadInvocationScope,
) {
  const self = scope.thread.threadId;
  // Booting an Expo or Simlock catalog entry starts a new device, so it claims nothing.
  const allocating = new Set(
    state.hosts
      .filter((host) => host.kind === "eas" || host.kind === "simlock")
      .map((host) => host.id),
  );
  const claims = [
    ...state.sessions,
    ...(state.bootingDevices ?? [])
      .filter((device) => !allocating.has(device.hostId))
      .map((device) => ({ ...device, deviceId: device.id })),
  ]
    .filter((claim) => claim.threadId !== self)
    .filter(
      (claim, index, all) =>
        all.findIndex(
          (other) =>
            other.threadId === claim.threadId &&
            other.hostId === claim.hostId &&
            other.deviceId === claim.deviceId,
        ) === index,
    );
  if (claims.length === 0) return { holders: [], parents: [], linkOf: (_: ThreadId) => "" };
  const lineage = yield* subagentAncestors([self, ...claims.map((claim) => claim.threadId)]).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Device holders' threads could not be read", { cause }).pipe(
        Effect.as({ shells: new Map(), ancestors: (_: ThreadId): ReadonlyArray<ThreadId> => [] }),
      ),
    ),
  );
  const parents = lineage.ancestors(self);
  const holders = claims
    .filter((claim) => !parents.includes(claim.threadId))
    .map((claim): DeviceHolder => ({
      hostId: claim.hostId,
      deviceId: claim.deviceId,
      threadId: claim.threadId,
      threadLink: McpInvocationContext.threadLinkFor(
        scope,
        claim.threadId,
        lineage.shells.get(claim.threadId)?.title,
      ),
    }));
  const linkOf = (threadId: ThreadId) =>
    McpInvocationContext.threadLinkFor(scope, threadId, lineage.shells.get(threadId)?.title);
  return { holders, parents, linkOf };
});

const holdersOf = (holders: ReadonlyArray<DeviceHolder>, device: DeviceSummary) =>
  holders.filter((holder) => holder.hostId === device.hostId && holder.deviceId === device.id);

const threadsHolding = (holders: ReadonlyArray<DeviceHolder>, device: DeviceSummary) =>
  holdersOf(holders, device)
    .map((holder) => holder.threadLink)
    .join(" and ");

const DO_NOT_TAKE_OVER =
  "Never reuse or close another thread's device or its agent-device session.";

const deviceLabel = (device: DeviceSummary) => `${device.name} (${device.id})`;

const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly hostStatuses: DeviceServiceState["hostStatuses"];
    readonly devices: ReadonlyArray<DeviceSummary>;
    readonly sessions: ReadonlyArray<{
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
    }>;
  },
  holders: ReadonlyArray<DeviceHolder>,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError, DeviceService.DeviceService> {
  const openHere = (device: DeviceSummary) =>
    state.sessions.some(
      (session) => session.hostId === device.hostId && session.deviceId === device.id,
    );
  const isFree = (device: DeviceSummary) =>
    openHere(device) || holdersOf(holders, device).length === 0;
  if (input.deviceId !== undefined) {
    const { deviceId, hostId } = input;
    const devices = yield* DeviceService.DeviceService;
    const located = yield* devices.locateDevice({ deviceId, hostId }).pipe(mapLocateErrors);
    if (Option.isSome(located)) {
      const device = located.value;
      if (isFree(device)) return device;
      const free = state.devices
        .filter(
          (candidate) =>
            candidate.hostId === device.hostId &&
            candidate.platform === device.platform &&
            isFree(candidate),
        )
        .toSorted((a, b) => Number(b.booted) - Number(a.booted));
      const host = state.hosts.find((candidate) => candidate.id === device.hostId) ?? {
        id: device.hostId,
      };
      return yield* new DeviceToolUnavailableError({
        reason: [
          `${deviceLabel(device)} is open in ${threadsHolding(holders, device)}, and a device stays with the thread that opened it.`,
          DO_NOT_TAKE_OVER,
          free.length === 0
            ? `No other ${device.platform} device on ${hostName(host)} is free: tell the user which thread holds this one.`
            : `Free ${device.platform} devices on ${hostName(host)}: ${free
                .slice(0, 5)
                .map(deviceLabel)
                .join(
                  ", ",
                )}. Open one of them, or ask the user to close ${device.name} in that thread.`,
        ].join(" "),
      });
    }
    const target =
      hostId === undefined
        ? undefined
        : (state.hosts.find((host) => host.id === hostId) ?? { id: hostId });
    const failures = failedHosts(state, target === undefined ? state.hosts : [target]).map(
      ({ host, detail }) => `${hostName(host)} failed to start: ${detail}`,
    );
    return yield* new DeviceToolUnavailableError({
      reason: [
        `No device ${deviceId} on ${target === undefined ? "any host" : hostName(target)}.`,
        ...failures,
        "Call device_list for current ids.",
      ].join(" "),
    });
  }
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  const candidates = state.devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    const [failure] = failedHosts(state, [{ id: hostId }]);
    return yield* new DeviceToolUnavailableError({
      reason:
        failure !== undefined
          ? failure.detail
          : input.platform === undefined
            ? "No simulators or emulators were found. Call device_list to see why."
            : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const free = candidates.filter(isFree);
  if (free.length === 0) {
    return yield* new DeviceToolUnavailableError({
      reason: `Every ${[...new Set(candidates.map((device) => device.platform))].join(" or ")} device on host ${hostId} is open in another thread: ${candidates
        .map((device) => `${deviceLabel(device)} in ${threadsHolding(holders, device)}`)
        .join("; ")}. ${DO_NOT_TAKE_OVER} Tell the user which threads hold them.`,
    });
  }
  if (input.platform === undefined && new Set(free.map((device) => device.platform)).size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  return free.find(openHere) ?? free.find((device) => device.booted) ?? free[0]!;
});

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = yield* resolveHostId(state.hosts, input?.hostId);
      const open = state.sessions
        .filter(
          (session) =>
            session.threadId === scope.thread.threadId &&
            (hostId === undefined || session.hostId === hostId),
        )
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      // A device this thread has open stays its own, even when a subagent shares it.
      const inOtherThreads = (yield* deviceClaims(state, scope)).holders.filter(
        (holder) =>
          (!hostId || holder.hostId === hostId) &&
          !open.some((own) => own.hostId === holder.hostId && own.deviceId === holder.deviceId),
      );
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
        inOtherThreads,
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const self = scope.thread.threadId;
      // Two threads can pick the same free device at once, and an emulator's id can change as
      // another thread boots it: pick again once with the newer listing.
      for (let attempt = 1; ; attempt++) {
        const state = yield* devices.list;
        if (state.hostStatus === "disabled") {
          return yield* new DeviceToolUnavailableError({
            reason:
              "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
          });
        }
        const hostId = yield* resolveHostId(state.hosts, input.hostId);
        const claims = yield* deviceClaims(state, scope);
        const target = yield* pickDevice(
          { ...state, sessions: state.sessions.filter((session) => session.threadId === self) },
          claims.holders,
          { ...input, hostId },
        );
        // Resolve consent and agent connectivity before booting or registering a session.
        if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
          return yield* new DeviceToolUnavailableError({
            reason:
              "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
          });
        }
        const opening = yield* devices
          .openUnheld(
            {
              threadId: self,
              hostId: target.hostId,
              deviceId: target.id,
              platform: target.platform,
            },
            { workspaceRoot: yield* threadWorkspaceRoot(self) },
            claims.parents,
          )
          .pipe(
            Effect.asSome,
            Effect.catchTags({
              DeviceHeldError: () =>
                attempt < 2
                  ? Effect.succeedNone
                  : Effect.fail(
                      new DeviceToolUnavailableError({
                        reason: `${deviceLabel(target)} was just opened in another thread. ${DO_NOT_TAKE_OVER} Call device_list to see which, and device_open a free device.`,
                      }),
                    ),
              DeviceNotFoundError: (error) =>
                attempt < 2 && input.deviceId === undefined
                  ? Effect.succeedNone
                  : Effect.fail(error),
            }),
          );
        if (Option.isNone(opening)) continue;
        const session = opening.value;
        const after = yield* devices.state;
        const device =
          after.devices.find(
            (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
          ) ?? target;
        // agent-device lets one session drive a device, so a subagent drives its parent's.
        const parent = claims.parents.findLast((threadId) =>
          after.sessions.some(
            (other) =>
              other.threadId === threadId &&
              other.hostId === session.hostId &&
              other.deviceId === session.deviceId,
          ),
        );
        // Target the opened device: an Expo device and its agent-device daemon
        // exist only once its session runs, and Android ids change on boot.
        const opened = {
          threadId: parent ?? self,
          hostId: session.hostId,
          deviceId: session.deviceId,
        };
        const agent = yield* devices.agentTarget(opened);
        const hostKind = after.hosts.find((host) => host.id === device.hostId)?.kind;
        const targetArgs = [
          ...(agent.agentDeviceId === null
            ? []
            : agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId })),
          ...agent.args,
        ];
        const launcher = yield* devices.agentLauncher({ ...opened, targetArgs });
        if (Option.isNone(launcher)) {
          return yield* new DeviceToolUnavailableError({
            reason:
              "The device was closed while device_open was preparing it. Call device_open again only if you still need it.",
          });
        }
        const command = launcher.value;
        return {
          device,
          agentDevice: { command, targetArgs, session: agent.session },
          quickStart: agentDeviceQuickStart(
            device,
            [],
            command,
            hostKind === "simlock"
              ? {
                  kind: "simlock",
                  ...(agent.installDirectory ? { installDirectory: agent.installDirectory } : {}),
                }
              : hostKind === "eas"
                ? { kind: "eas" }
                : undefined,
            parent === undefined ? undefined : claims.linkOf(parent),
          ),
        };
      }
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const threadId = scope.thread.threadId;
      const hostId =
        input.hostId === undefined
          ? undefined
          : yield* resolveHostId((yield* devices.state).hosts, input.hostId);
      const target =
        input.deviceId === undefined
          ? (yield* devices.sessionsForThread(threadId)).findLast(
              (session) => hostId === undefined || session.hostId === hostId,
            )
          : Option.getOrUndefined(
              yield* devices
                .locateSession({ threadId, deviceId: input.deviceId, hostId })
                .pipe(mapLocateErrors),
            );
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason:
            input.deviceId === undefined
              ? "No device is open in this thread. Call device_open first."
              : `Device ${input.deviceId} is not open in this thread. Call device_open first.`,
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const deviceId = input.deviceId;
      const inputHostId =
        input.hostId === undefined
          ? undefined
          : yield* resolveHostId((yield* devices.state).hosts, input.hostId);
      const open =
        deviceId === undefined
          ? Option.none()
          : yield* devices
              .locateSession({ threadId: scope.thread.threadId, deviceId, hostId: inputHostId })
              .pipe(mapLocateErrors);
      const hostId = Option.isSome(open) ? open.value.hostId : inputHostId;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(hostId === undefined ? {} : { hostId }),
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
