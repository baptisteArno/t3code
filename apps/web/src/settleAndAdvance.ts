import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

type SettleAndAdvance = (threadRef: ScopedThreadRef) => void;

let registeredSettleAndAdvance: SettleAndAdvance | null = null;

export function registerSettleAndAdvance(handler: SettleAndAdvance): () => void {
  registeredSettleAndAdvance = handler;
  return () => {
    if (registeredSettleAndAdvance === handler) registeredSettleAndAdvance = null;
  };
}

/** False means no sidebar is mounted; settle in place. */
export function settleAndAdvance(threadRef: ScopedThreadRef): boolean {
  if (!registeredSettleAndAdvance) return false;
  registeredSettleAndAdvance(threadRef);
  return true;
}

type NextThreadAfterSend = (sentRef: ScopedThreadRef) => ScopedThreadRef | null | undefined;

let registeredNextThreadAfterSend: NextThreadAfterSend | null = null;

export function registerNextThreadAfterSend(handler: NextThreadAfterSend): () => void {
  registeredNextThreadAfterSend = handler;
  return () => {
    if (registeredNextThreadAfterSend === handler) registeredNextThreadAfterSend = null;
  };
}

/** Null opens a new thread; undefined keeps the user where they are. */
export function nextThreadAfterSend(sentRef: ScopedThreadRef): ScopedThreadRef | null | undefined {
  return registeredNextThreadAfterSend?.(sentRef);
}

export function nextThreadAfterSendEnabled(): boolean {
  return registeredNextThreadAfterSend !== null;
}

const draftOrigins = new Map<string, ScopedThreadRef>();

/** Sending a draft opened over a thread returns to that thread. */
export function rememberDraftOrigin(draftRef: ScopedThreadRef, originRef: ScopedThreadRef): void {
  if (registeredNextThreadAfterSend) draftOrigins.set(scopedThreadKey(draftRef), originRef);
}

export function takeDraftOrigin(draftRef: ScopedThreadRef): ScopedThreadRef | null {
  const key = scopedThreadKey(draftRef);
  const origin = draftOrigins.get(key) ?? null;
  draftOrigins.delete(key);
  return origin;
}
