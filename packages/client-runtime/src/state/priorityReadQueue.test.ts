import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import { makePriorityReadQueue } from "./priorityReadQueue.ts";

const harness = Effect.gen(function* () {
  const queue = makePriorityReadQueue(1);
  const started = yield* Queue.unbounded<string>();
  const gates = new Map<string, Deferred.Deferred<void>>();
  const read = (key: string) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      gates.set(key, gate);
      return yield* Effect.forkChild(
        queue.run(key, Queue.offer(started, key).pipe(Effect.andThen(Deferred.await(gate)))),
        { startImmediately: true },
      );
    });
  const finish = (key: string) => Deferred.succeed(gates.get(key)!, undefined);
  return { queue, started, read, finish };
});

describe("makePriorityReadQueue", () => {
  it.effect("starts a prioritized read before background reads that queued first", () =>
    Effect.gen(function* () {
      const { queue, started, read, finish } = yield* harness;
      yield* read("running");
      expect(yield* Queue.take(started)).toBe("running");
      yield* read("background-1");
      yield* read("waiting-file");
      // A file not queued yet enters at the front once its read arrives.
      queue.prioritize("later-file");
      yield* read("background-2");
      yield* read("later-file");
      queue.prioritize("waiting-file");

      yield* finish("running");
      expect(yield* Queue.take(started)).toBe("waiting-file");
      yield* finish("waiting-file");
      expect(yield* Queue.take(started)).toBe("later-file");
      yield* finish("later-file");
      expect(yield* Queue.take(started)).toBe("background-1");
    }),
  );

  it.effect("frees the slot of an interrupted read and drops an interrupted waiter", () =>
    Effect.gen(function* () {
      const { started, read } = yield* harness;
      const running = yield* read("running");
      expect(yield* Queue.take(started)).toBe("running");
      const abandoned = yield* read("abandoned");
      yield* read("next");

      yield* Fiber.interrupt(abandoned);
      yield* Fiber.interrupt(running);
      expect(yield* Queue.take(started)).toBe("next");
    }),
  );
});
