import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "../src/integrations/supabase/types";
import { runOneJob, type BackgroundJob, type QueueAdapter } from "./runtime";
import { createMediaJobHandlers, ensurePrivateMediaBucket } from "./media";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required worker environment variable: ${name}`);
  return value;
}

function positiveIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function log(entry: Record<string, unknown>) {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), component: "background-worker", ...entry })}\n`,
  );
}

const supabase = createClient<Database>(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const leaseSeconds = positiveIntegerEnv("WORKER_LEASE_SECONDS", 60, 15, 900);
const pollIntervalMs = positiveIntegerEnv("WORKER_POLL_INTERVAL_MS", 2_000, 250, 60_000);
const metricsIntervalMs = positiveIntegerEnv(
  "WORKER_METRICS_INTERVAL_MS",
  60_000,
  5_000,
  3_600_000,
);

const queue: QueueAdapter = {
  async claim(id, lease) {
    const { data, error } = await supabase.rpc("worker_claim_background_job", {
      _worker_id: id,
      _lease_seconds: lease,
    });
    if (error) throw new Error(error.message);
    return (data as BackgroundJob | null) ?? null;
  },
  async heartbeat(id, jobId, lease) {
    const { data, error } = await supabase.rpc("worker_heartbeat_background_job", {
      _worker_id: id,
      _job_id: jobId,
      _lease_seconds: lease,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  async complete(id, jobId, result) {
    const { data, error } = await supabase.rpc("worker_complete_background_job", {
      _worker_id: id,
      _job_id: jobId,
      _safe_result: result as Json,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
  async fail(id, jobId, errorCode, retryable, context) {
    const { data, error } = await supabase.rpc(
      "worker_fail_background_job_diagnostic" as never,
      {
        _worker_id: id,
        _job_id: jobId,
        _safe_error_code: errorCode,
        _retryable: retryable,
        _failure_category: context?.category ?? null,
        _safe_diagnostics: context?.diagnostics ?? {},
      } as never,
    );
    if (error) throw new Error(error.message);
    return data;
  },
};

const handlers = {
  "system.noop": async (job: BackgroundJob) => ({ acknowledged: true, trace_id: job.trace_id }),
  ...createMediaJobHandlers(supabase),
};

let shuttingDown = false;
const stop = (signal: string) => {
  shuttingDown = true;
  log({ level: "info", event: "worker.stopping", signal });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function reportMetrics() {
  const { data, error } = await supabase.rpc("worker_get_queue_metrics");
  if (error) throw new Error(error.message);
  log({ level: "info", event: "queue.metrics", metrics: data });
}

async function main() {
  await ensurePrivateMediaBucket(supabase);
  log({ level: "info", event: "worker.started", worker_id: workerId, lease_seconds: leaseSeconds });
  let nextMetricsAt = 0;
  while (!shuttingDown) {
    try {
      const outcome = await runOneJob(queue, handlers, workerId, leaseSeconds, log);
      if (Date.now() >= nextMetricsAt) {
        await reportMetrics();
        nextMetricsAt = Date.now() + metricsIntervalMs;
      }
      if (outcome === "idle") await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      log({
        level: "error",
        event: "worker.loop_failed",
        error_code: error instanceof Error ? error.name : "unknown_error",
      });
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  log({ level: "info", event: "worker.stopped" });
}

void main().catch((error) => {
  log({
    level: "fatal",
    event: "worker.crashed",
    error_code: error instanceof Error ? error.name : "unknown_error",
  });
  process.exitCode = 1;
});
