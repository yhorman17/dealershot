export type UploadState = "queued" | "uploading" | "uploaded" | "failed";

export type UploadEntry<T> = {
  id: string;
  payload: T | null;
  state: UploadState;
  attempts: number;
  error: string | null;
};

type Listener<T> = (entries: UploadEntry<T>[]) => void;

export function createUploadQueue<T>(
  upload: (payload: T) => Promise<void>,
  { concurrency = 2 }: { concurrency?: number } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Upload concurrency must be between 1 and 4.");
  }

  let entries: UploadEntry<T>[] = [];
  let active = 0;
  const listeners = new Set<Listener<T>>();
  const waiters = new Set<() => void>();

  const snapshot = () => entries.map((entry) => ({ ...entry }));
  const notify = () => {
    const value = snapshot();
    listeners.forEach((listener) => listener(value));
    if (active === 0 && !entries.some((entry) => entry.state === "queued")) {
      waiters.forEach((resolve) => resolve());
      waiters.clear();
    }
  };

  const pump = () => {
    while (active < concurrency) {
      const next = entries.find((entry) => entry.state === "queued");
      if (!next) break;
      next.state = "uploading";
      next.attempts += 1;
      next.error = null;
      active += 1;
      notify();
      const payload = next.payload;
      if (payload === null) {
        next.state = "failed";
        next.error = "The local upload payload is no longer available.";
        active -= 1;
        notify();
        continue;
      }
      void upload(payload)
        .then(() => {
          next.state = "uploaded";
          // Full-resolution Files can be tens of megabytes. Once durable upload
          // succeeds, release the browser's last queue reference immediately.
          next.payload = null;
        })
        .catch((error: unknown) => {
          next.state = "failed";
          next.error = error instanceof Error ? error.message : "Upload failed";
        })
        .finally(() => {
          active -= 1;
          notify();
          pump();
        });
    }
  };

  return {
    add(payload: T, id: string = crypto.randomUUID()) {
      entries = [...entries, { id, payload, state: "queued", attempts: 0, error: null }];
      notify();
      pump();
      return id;
    },
    retry(id: string) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry?.state !== "failed") return;
      entry.state = "queued";
      notify();
      pump();
    },
    retryFailed() {
      entries.forEach((entry) => {
        if (entry.state === "failed") entry.state = "queued";
      });
      notify();
      pump();
    },
    remove(id: string) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry?.state === "uploading") return false;
      entries = entries.filter((candidate) => candidate.id !== id);
      notify();
      return true;
    },
    subscribe(listener: Listener<T>) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: snapshot,
    async waitForIdle() {
      if (active === 0 && !entries.some((entry) => entry.state === "queued")) return;
      await new Promise<void>((resolve) => waiters.add(resolve));
    },
  };
}
