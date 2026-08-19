import {
  classifyBackgroundFailure,
  type BackgroundFailureCategory,
} from "./background-removal-diagnostics.ts";

export type BackgroundJob = {
  job_id: string;
  job_type: string;
  payload: Record<string, unknown>;
  dealership_id: string | null;
  attempt: number;
  max_attempts: number;
  trace_id: string;
  lease_expires_at: string;
};

export type JobHandler = (job: BackgroundJob) => Promise<Record<string, unknown> | void>;

export type QueueAdapter = {
  claim(workerId: string, leaseSeconds: number): Promise<BackgroundJob | null>;
  heartbeat(workerId: string, jobId: string, leaseSeconds: number): Promise<boolean>;
  complete(workerId: string, jobId: string, result: Record<string, unknown>): Promise<boolean>;
  fail(
    workerId: string,
    jobId: string,
    errorCode: string,
    retryable: boolean,
    context?: {
      category: BackgroundFailureCategory;
      diagnostics: Record<string, unknown>;
    },
  ): Promise<string>;
};

export type WorkerLogger = (entry: Record<string, unknown>) => void;

export async function processBackgroundJob(
  adapter: QueueAdapter,
  handlers: Readonly<Record<string, JobHandler>>,
  workerId: string,
  job: BackgroundJob,
  leaseSeconds: number,
  log: WorkerLogger,
) {
  const handler = handlers[job.job_type];
  if (!handler) {
    const status = await adapter.fail(workerId, job.job_id, "unknown_job_type", false);
    log({
      level: "error",
      event: "job.rejected",
      job_id: job.job_id,
      job_type: job.job_type,
      dealership_id: job.dealership_id,
      trace_id: job.trace_id,
      status,
    });
    return status;
  }

  const heartbeatMs = Math.max(5_000, Math.floor((leaseSeconds * 1_000) / 3));
  const heartbeat = setInterval(() => {
    void adapter.heartbeat(workerId, job.job_id, leaseSeconds).catch(() => {
      log({
        level: "warn",
        event: "job.heartbeat_failed",
        job_id: job.job_id,
        trace_id: job.trace_id,
      });
    });
  }, heartbeatMs);

  try {
    const startedAt = Date.now();
    log({
      level: "info",
      event: "job.started",
      job_id: job.job_id,
      job_type: job.job_type,
      trace_id: job.trace_id,
      attempt: job.attempt,
    });
    const result = (await handler(job)) ?? {};
    const completed = await adapter.complete(workerId, job.job_id, result);
    if (!completed) throw new Error("job_lease_lost");
    log({
      level: "info",
      event: "job.succeeded",
      job_id: job.job_id,
      job_type: job.job_type,
      dealership_id: job.dealership_id,
      trace_id: job.trace_id,
      duration_ms: Date.now() - startedAt,
    });
    return "succeeded";
  } catch (error) {
    const failure = classifyBackgroundFailure(error);
    const status = await adapter.fail(workerId, job.job_id, failure.code, failure.retryable, {
      category: failure.category,
      diagnostics: failure.diagnostics,
    });
    log({
      level: "error",
      event: "job.failed",
      job_id: job.job_id,
      job_type: job.job_type,
      dealership_id: job.dealership_id,
      trace_id: job.trace_id,
      error_code: failure.code,
      failure_category: failure.category,
      status,
    });
    return status;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runOneJob(
  adapter: QueueAdapter,
  handlers: Readonly<Record<string, JobHandler>>,
  workerId: string,
  leaseSeconds: number,
  log: WorkerLogger,
) {
  const job = await adapter.claim(workerId, leaseSeconds);
  if (!job) return "idle";
  return processBackgroundJob(adapter, handlers, workerId, job, leaseSeconds, log);
}
