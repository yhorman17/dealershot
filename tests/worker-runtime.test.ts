import assert from "node:assert/strict";
import test from "node:test";
import { runOneJob, type BackgroundJob, type QueueAdapter } from "../worker/runtime.ts";

const job: BackgroundJob = {
  job_id: "10000000-0000-0000-0000-000000000001",
  job_type: "system.noop",
  payload: {},
  dealership_id: null,
  attempt: 1,
  max_attempts: 5,
  trace_id: "20000000-0000-0000-0000-000000000001",
  lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
};

function adapterFor(claimed: BackgroundJob | null) {
  const calls: string[] = [];
  const adapter: QueueAdapter = {
    async claim() {
      calls.push("claim");
      return claimed;
    },
    async heartbeat() {
      calls.push("heartbeat");
      return true;
    },
    async complete() {
      calls.push("complete");
      return true;
    },
    async fail(_worker, _job, code) {
      calls.push(`fail:${code}`);
      return "dead_letter";
    },
  };
  return { adapter, calls };
}

test("worker remains idle when no durable job is ready", async () => {
  const { adapter, calls } = adapterFor(null);
  assert.equal(await runOneJob(adapter, {}, "worker-1", 60, () => undefined), "idle");
  assert.deepEqual(calls, ["claim"]);
});

test("worker completes a registered job handler", async () => {
  const { adapter, calls } = adapterFor(job);
  const outcome = await runOneJob(
    adapter,
    { "system.noop": async () => ({ ok: true }) },
    "worker-1",
    60,
    () => undefined,
  );
  assert.equal(outcome, "succeeded");
  assert.deepEqual(calls, ["claim", "complete"]);
});

test("worker dead-letters an unknown job type without executing arbitrary payloads", async () => {
  const { adapter, calls } = adapterFor({ ...job, job_type: "unknown.task" });
  assert.equal(await runOneJob(adapter, {}, "worker-1", 60, () => undefined), "dead_letter");
  assert.deepEqual(calls, ["claim", "fail:unknown_job_type"]);
});

test("worker reports safe handler error codes and schedules failure", async () => {
  const { adapter, calls } = adapterFor(job);
  const outcome = await runOneJob(
    adapter,
    {
      "system.noop": async () => {
        throw new TypeError("secret details must not be logged");
      },
    },
    "worker-1",
    60,
    () => undefined,
  );
  assert.equal(outcome, "dead_letter");
  assert.deepEqual(calls, ["claim", "fail:typeerror"]);
});
