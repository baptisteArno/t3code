import * as Effect from "effect/Effect";

/**
 * Runs at most `limit` reads at once, in arrival order. A prioritized read takes the next free
 * slot, so a file the user opens does not wait behind every background load and refresh.
 */
export function makePriorityReadQueue(limit: number) {
  let active = 0;
  const waiting: Array<{ readonly key: string; start: () => void }> = [];
  const running = new Map<string, number>();
  const prioritized = new Set<string>();
  const startNext = () => {
    while (active < limit && waiting.length > 0) {
      active++;
      waiting.shift()!.start();
    }
  };
  const run = <A, E, R>(key: string, read: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) => {
      let started = false;
      const waiter = { key, start: () => {} };
      const wait = Effect.callback<void>((resume) => {
        waiter.start = () => {
          started = true;
          running.set(key, (running.get(key) ?? 0) + 1);
          resume(Effect.void);
        };
        if (prioritized.delete(key)) waiting.unshift(waiter);
        else waiting.push(waiter);
        startNext();
      });
      return restore(wait).pipe(
        Effect.andThen(restore(read)),
        Effect.ensuring(
          Effect.sync(() => {
            const index = waiting.indexOf(waiter);
            if (index >= 0) waiting.splice(index, 1);
            if (!started) return;
            const count = running.get(key)! - 1;
            if (count === 0) running.delete(key);
            else running.set(key, count);
            active--;
            startNext();
          }),
        ),
      );
    });
  /** Moves a waiting read to the front, or marks one not queued yet to enter there. */
  const prioritize = (key: string) => {
    if (running.has(key)) return;
    const index = waiting.findIndex((waiter) => waiter.key === key);
    if (index < 0) prioritized.add(key);
    else waiting.unshift(...waiting.splice(index, 1));
  };
  return { run, prioritize };
}
