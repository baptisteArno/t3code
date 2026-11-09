import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadAsksUserBesides } from "@t3tools/client-runtime/state/thread-requests";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { nextThreadAfterSend, takeDraftOrigin, waitForInboxReturn } from "../settleAndAdvance";
import { readThreadShell } from "../state/entities";
import { environmentThreadDetails } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { createNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens `next`, or a new thread in `projectRef` when it is null. False when nothing opened.
 * `sentRef` is null after a settle or snooze, so that thread can open again once it returns to the
 * inbox.
 */
export function useOpenThreadAfterSend() {
  const router = useRouter();
  return async (
    next: ScopedThreadRef | null,
    sentRef: ScopedThreadRef | null,
    projectRef: ScopedProjectRef,
  ): Promise<boolean> => {
    if (next !== null) {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(next),
      });
      return true;
    }
    const opened = await createNewThreadHandler(router)(projectRef);
    if (opened === null) return false;
    const openedRef = scopeThreadRef(projectRef.environmentId, opened.threadId);
    // This draft opened by itself, so sending it goes to the top of the inbox.
    takeDraftOrigin(openedRef);
    waitForInboxReturn({ draftRef: openedRef, sentRef });
    return true;
  };
}

/**
 * With Next thread after sending on, answering what a thread asked opens the next thread, like a
 * send, once nothing else in it waits on the user. Call it after the answer succeeds.
 */
export function useAdvanceAfterAnswer() {
  const openThreadAfterSend = useOpenThreadAfterSend();
  return (threadRef: ScopedThreadRef, answeredId: string) => {
    const projection = Option.getOrNull(
      appAtomRegistry.get(environmentThreadDetails.stateAtom(threadRef)).data,
    );
    const shell = readThreadShell(threadRef);
    if (projection === null || shell === null || threadAsksUserBesides(projection, answeredId)) {
      return;
    }
    const next = nextThreadAfterSend(threadRef);
    if (next === undefined) return;
    void openThreadAfterSend(
      next,
      threadRef,
      scopeProjectRef(threadRef.environmentId, shell.projectId),
    );
  };
}
