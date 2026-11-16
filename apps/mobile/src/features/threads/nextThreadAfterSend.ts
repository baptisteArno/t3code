import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadAsksUserBesides } from "@t3tools/client-runtime/state/thread-requests";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { createContext, use, useEffect } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { isStillQueued, resolveNextThreadAfterSend } from "./threadListV2";

type QueuedThread = Pick<EnvironmentThreadShell, "environmentId" | "id">;

type QueueSource = (leavingThreadKey: string) => QueuedThread | null;

const queueSources = new Set<QueueSource>();

/** Offers a mounted thread list's queue to the next send while the setting is on. */
export function useNextThreadAfterSendSource(input: {
  readonly enabled: boolean;
  readonly nextThreadQueue: ReadonlyArray<QueuedThread>;
  readonly loadedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const { enabled, nextThreadQueue, loadedEnvironmentIds } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this list's queue in the module-level next-thread-after-send registry
  useEffect(() => {
    if (!enabled) return;
    const source: QueueSource = (leavingThreadKey) => {
      const now = new Date().toISOString();
      const queuedThreadKeys = appAtomRegistry.get(queuedThreadKeysAtom);
      return resolveNextThreadAfterSend({
        nextThreadQueue,
        leavingThreadKey,
        loadedEnvironmentIds,
        isQueued: (thread) =>
          isStillQueued(
            appAtomRegistry.get(
              environmentThreadShells.threadShellAtom(
                scopeThreadRef(thread.environmentId, thread.id),
              ),
            ),
            { now, queuedThreadKeys },
          ),
      });
    };
    queueSources.add(source);
    return () => {
      queueSources.delete(source);
    };
  }, [enabled, nextThreadQueue, loadedEnvironmentIds]);
}

/**
 * Opens the first queued thread after a send, or a new thread in the sent thread's project when the
 * queue is empty. Returns false, leaving the user where they are, when no list offers its queue.
 */
export function useAdvanceAfterSend() {
  const selectDetail = useSelectWorkspaceDetail();
  return (sent: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }): boolean => {
    const source = [...queueSources].at(-1);
    if (source === undefined) return false;
    const next = source(scopedThreadKey(sent.environmentId, sent.threadId));
    selectDetail({
      name: "Thread",
      params:
        next === null
          ? {
              draft: {
                requestId: uuidv4(),
                environmentId: String(sent.environmentId),
                projectId: String(sent.projectId),
              },
            }
          : { environmentId: String(next.environmentId), threadId: String(next.id) },
    });
    return true;
  };
}

/** The open thread screen's scope, aborted once it shows another thread or hides. */
export const ThreadScreenScopeContext = createContext<(() => AbortSignal) | null>(null);

const shownThreadScopes = new Map<string, AbortSignal>();

/**
 * Marks a thread as on screen, for parks started outside its screen such as from its header,
 * until the returned cleanup runs.
 */
export function markThreadShown(threadKey: string): () => void {
  const shown = new AbortController();
  shownThreadScopes.set(threadKey, shown.signal);
  return () => {
    shown.abort();
    if (shownThreadScopes.get(threadKey) === shown.signal) shownThreadScopes.delete(threadKey);
  };
}

type ParkedThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "lineage">;

/**
 * With Next thread after sending on, settling or snoozing the thread on screen opens the next
 * thread, like a send, once the park succeeds and if the user is still on it.
 */
export function useAdvancingParkActions<Thread extends ParkedThread>(actions: {
  readonly settleThread: (thread: Thread) => Promise<boolean>;
  readonly snoozeThread: (thread: Thread, snoozedUntil: string) => Promise<boolean>;
}) {
  const advanceAfterSend = useAdvanceAfterSend();
  const park = async (thread: Thread, run: () => Promise<boolean>) => {
    const scope = shownThreadScopes.get(scopedThreadKey(thread.environmentId, thread.id));
    const parked = await run();
    if (
      parked &&
      scope !== undefined &&
      !scope.aborted &&
      isListedThreadLineage(thread.lineage) &&
      advanceAfterSend({
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
      })
    ) {
      void KeyboardController.dismiss();
    }
    return parked;
  };
  return {
    settleThread: (thread: Thread) => park(thread, () => actions.settleThread(thread)),
    snoozeThread: (thread: Thread, snoozedUntil: string) =>
      park(thread, () => actions.snoozeThread(thread, snoozedUntil)),
  };
}

/**
 * With Next thread after sending on, answering what a thread asked opens the next thread, like a
 * send, once nothing else in it waits on the user. Begin before sending the answer, so a thread
 * the user left meanwhile stays put, then call the result once the answer succeeds.
 */
export function useAdvanceAfterAnswer(readScreenScope?: () => AbortSignal) {
  const advanceAfterSend = useAdvanceAfterSend();
  const contextScope = use(ThreadScreenScopeContext);
  const screenScope = readScreenScope ?? contextScope;
  return () => {
    const scope = screenScope?.();
    return (threadRef: ScopedThreadRef, answeredId: string) => {
      if (scope === undefined || scope.aborted) return;
      const projection = Option.getOrNull(
        appAtomRegistry.get(environmentThreadDetails.stateAtom(threadRef)).data,
      );
      if (
        projection === null ||
        !isListedThreadLineage(projection.thread.lineage) ||
        threadAsksUserBesides(projection, answeredId)
      ) {
        return;
      }
      if (
        advanceAfterSend({
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          projectId: projection.thread.projectId,
        })
      ) {
        void KeyboardController.dismiss();
      }
    };
  };
}
