import test from "node:test";
import assert from "node:assert/strict";
import { createUploadQueue } from "../src/lib/upload-queue.ts";

test("upload queue bounds concurrency and drains", async () => {
  let active = 0;
  let peak = 0;
  const queue = createUploadQueue<number>(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
  });
  for (let index = 0; index < 40; index += 1) queue.add(index, String(index));
  await queue.waitForIdle();
  assert.equal(peak, 2);
  assert.equal(queue.getSnapshot().filter((item) => item.state === "uploaded").length, 40);
  assert.equal(
    queue.getSnapshot().filter((item) => item.payload !== null).length,
    0,
    "uploaded payloads are released instead of retaining full-resolution files",
  );
});

test("failed uploads remain retryable and completion can detect them", async () => {
  let shouldFail = true;
  const queue = createUploadQueue<string>(async () => {
    if (shouldFail) throw new Error("network unavailable");
  });
  queue.add("photo", "fixture");
  await queue.waitForIdle();
  assert.equal(queue.getSnapshot()[0]?.state, "failed");
  assert.equal(queue.getSnapshot()[0]?.payload, "photo", "failed payload remains available");
  shouldFail = false;
  queue.retryFailed();
  await queue.waitForIdle();
  assert.equal(queue.getSnapshot()[0]?.state, "uploaded");
});
