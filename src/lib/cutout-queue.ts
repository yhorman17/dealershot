import { removeBackground } from "@imgly/background-removal";
import { supabase } from "@/integrations/supabase/client";

// Exterior shot types eligible for automatic background removal.
const EXTERIOR_SHOT_NAMES = [
  "front",
  "rear",
  "driver side",
  "passenger side",
  "front 3/4",
  "rear 3/4",
];

export function isExteriorShot(shotType: string | null | undefined): boolean {
  if (!shotType) return false;
  return EXTERIOR_SHOT_NAMES.includes(shotType.trim().toLowerCase());
}

type Job = {
  photoId: string;
  imageUrl: string;
  onDone: (result: { ok: true; newUrl: string } | { ok: false; error: string }) => void;
};

const queue: Job[] = [];
const inflight = new Set<string>();
const MAX_CONCURRENCY = 2;
type Listener = (ids: Set<string>) => void;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l(new Set(inflight));
}

export function subscribeProcessing(l: Listener): () => void {
  listeners.add(l);
  l(new Set(inflight));
  return () => {
    listeners.delete(l);
  };
}

function storagePathFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const marker = "/vehicle-photos/";
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    return u.pathname.slice(idx + marker.length);
  } catch {
    return null;
  }
}

async function runJob(job: Job) {
  inflight.add(job.photoId);
  notify();
  try {
    const blob = await removeBackground(job.imageUrl, { model: "small", debug: true });
    const pngBlob = blob.type === "image/png" ? blob : new Blob([await blob.arrayBuffer()], { type: "image/png" });

    // Upload cutout to new path
    const oldPath = storagePathFromUrl(job.imageUrl);
    const folder = oldPath ? oldPath.split("/").slice(0, -1).join("/") : "";
    const newPath = `${folder ? folder + "/" : ""}${crypto.randomUUID()}.png`;
    const { error: upErr } = await supabase.storage
      .from("vehicle-photos")
      .upload(newPath, pngBlob, { contentType: "image/png", upsert: false });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from("vehicle-photos").getPublicUrl(newPath);
    const newUrl = pub.publicUrl;

    const { error: updErr } = await supabase
      .from("photos")
      .update({ image_url: newUrl, is_cutout: true, cutout_status: "done" })
      .eq("id", job.photoId);
    if (updErr) throw updErr;

    // Delete old original
    if (oldPath && oldPath !== newPath) {
      try {
        await supabase.storage.from("vehicle-photos").remove([oldPath]);
      } catch {
        /* non-fatal */
      }
    }

    job.onDone({ ok: true, newUrl });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cutout] failed for photo", job.photoId, e);
    try {
      await supabase
        .from("photos")
        .update({ cutout_status: "failed" })
        .eq("id", job.photoId);
    } catch { /* ignore */ }
    job.onDone({ ok: false, error: e instanceof Error ? e.message : "Cutout failed" });
  } finally {
    inflight.delete(job.photoId);
    notify();
    pump();
  }
}

function pump() {
  while (inflight.size < MAX_CONCURRENCY && queue.length > 0) {
    const next = queue.shift()!;
    void runJob(next);
  }
}

export function enqueueCutout(
  photoId: string,
  imageUrl: string,
  onDone: (result: { ok: true; newUrl: string } | { ok: false; error: string }) => void,
) {
  if (inflight.has(photoId) || queue.some((j) => j.photoId === photoId)) return;
  // Mark as pending in DB (fire-and-forget)
  void supabase.from("photos").update({ cutout_status: "pending" }).eq("id", photoId);
  queue.push({ photoId, imageUrl, onDone });
  pump();
}

export function isProcessing(photoId: string): boolean {
  return inflight.has(photoId) || queue.some((j) => j.photoId === photoId);
}
