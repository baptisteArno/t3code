import type { ThreadId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

// Agents write the images they show to `/tmp`, browser artifacts and worktrees,
// which reboots and storage cleanup empty while the thread still shows them.
const COPIED_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const THREAD_IMAGE_COPY_MAX_BYTES = 25 * 1024 * 1024;

export const threadImagesFolderName = (threadId: ThreadId) =>
  Base64Url.encode(new TextEncoder().encode(threadId));

export const threadIdFromImagesFolderName = (name: string): string | null => {
  const decoded = Base64Url.decodeString(name);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

/** Keyed on the path the message wrote, which is all a lookup has once the file is gone. */
const copyPath = Effect.fn("ThreadImageCopies.copyPath")(function* (
  threadId: ThreadId,
  requestedPath: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const key = Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(requestedPath)),
  );
  return path.join(
    config.threadImagesDir,
    threadImagesFolderName(threadId),
    key,
    path.basename(requestedPath),
  );
});

/** Copies an image a thread displays, or refreshes the copy after the file changed. Never fails. */
export const keepThreadImage = Effect.fn("ThreadImageCopies.keep")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly requestedPath: string;
    readonly filePath: string;
  }) {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!COPIED_IMAGE_EXTENSIONS.has(path.extname(input.filePath).toLowerCase())) return;
    if (isWithinRoot(path, input.filePath, config.threadImagesDir)) return;
    const source = yield* fs.stat(input.filePath);
    if (source.type !== "File" || Number(source.size) > THREAD_IMAGE_COPY_MAX_BYTES) return;
    const target = yield* copyPath(input.threadId, input.requestedPath);
    const sourceModified = Option.getOrNull(source.mtime);
    const existing = yield* fs.stat(target).pipe(Effect.option);
    if (
      Option.isSome(existing) &&
      existing.value.size === source.size &&
      sourceModified !== null &&
      Option.getOrNull(existing.value.mtime)?.getTime() === sourceModified.getTime()
    ) {
      return;
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const temporary = `${target}.${SecureRandom.uuidV4Unsafe()}.partial`;
    yield* Effect.gen(function* () {
      yield* fs.copyFile(input.filePath, temporary);
      if (sourceModified !== null) yield* fs.utimes(temporary, sourceModified, sourceModified);
      yield* fs.rename(temporary, target);
    }).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)));
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to keep a copy of a thread image.", {
          threadId: input.threadId,
          cause,
        }),
      ),
    ),
);

/** The copy of an image the thread displayed before its file went away. */
export const findThreadImageCopy = Effect.fn("ThreadImageCopies.find")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestedPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* copyPath(input.threadId, input.requestedPath);
  return (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) ? target : null;
});
