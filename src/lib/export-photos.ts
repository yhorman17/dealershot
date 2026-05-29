import JSZip from "jszip";
import { supabase } from "@/integrations/supabase/client";

export type ExportPhoto = {
  image_url: string;
  shot_type: string | null;
  is_document?: boolean;
  doc_name?: string | null;
};

export type ExportVehicle = {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  stock_number: string | null;
  vin: string | null;
};

export function sanitizeSegment(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function fileBaseForVehicle(v: ExportVehicle): string {
  const stock = (v.stock_number || "").trim();
  if (stock) return sanitizeSegment(stock).toUpperCase();
  const vin = (v.vin || "").trim();
  if (vin) return sanitizeSegment(vin).toUpperCase();
  return "vehicle";
}

export function folderForVehicle(v: ExportVehicle): string {
  const parts = [fileBaseForVehicle(v), v.year, v.make, v.model]
    .filter((p) => p != null && String(p).length > 0)
    .map((p) => sanitizeSegment(String(p)));
  return parts.join("_");
}

export function filenameFor(photo: ExportPhoto, vehicle: ExportVehicle, idx: number): string {
  const base = fileBaseForVehicle(vehicle);
  const shot = photo.is_document
    ? sanitizeSegment(photo.doc_name || `document_${idx + 1}`)
    : sanitizeSegment(photo.shot_type || `photo_${idx + 1}`);
  return `${base}_${shot}.jpg`;
}

export function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : "";
  let i = 2;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  const n = `${stem}_${i}${ext}`;
  taken.add(n);
  return n;
}

async function fetchAsJpegBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: "cors" });
  const blob = await res.blob();
  if (blob.type === "image/jpeg" || blob.type === "image/jpg") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/jpeg",
      0.92,
    );
  });
}

export type ProgressCallback = (current: number, total: number) => void;

export type VehicleExport = {
  vehicle: ExportVehicle;
  photos: ExportPhoto[];
};

export async function buildAndDownloadZip(
  exports: VehicleExport[],
  zipName: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const zip = new JSZip();
  const multi = exports.length > 1;
  const totalPhotos = exports.reduce((s, e) => s + e.photos.length, 0);
  let done = 0;

  for (const ex of exports) {
    const folderName = multi ? folderForVehicle(ex.vehicle) : null;
    const folder = folderName ? zip.folder(folderName)! : zip;
    const taken = new Set<string>();
    for (let i = 0; i < ex.photos.length; i++) {
      const photo = ex.photos[i];
      const name = uniqueName(taken, filenameFor(photo, ex.vehicle, i));
      try {
        const blob = await fetchAsJpegBlob(photo.image_url);
        folder.file(name, blob);
      } catch (e) {
        console.error("Failed to fetch photo for export", photo.image_url, e);
      }
      done++;
      onProgress?.(done, totalPhotos);
    }
  }

  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => {
      if (onProgress && totalPhotos > 0) {
        const synthetic = Math.min(
          totalPhotos,
          Math.round(totalPhotos * (meta.percent / 100)),
        );
        onProgress(Math.max(done, synthetic), totalPhotos);
      }
    },
  );

  triggerDownload(blob, zipName);
}

export async function downloadSinglePhoto(
  photo: ExportPhoto,
  vehicle: ExportVehicle,
): Promise<void> {
  const blob = await fetchAsJpegBlob(photo.image_url);
  triggerDownload(blob, filenameFor(photo, vehicle, 0));
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

export function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function loadVehiclePhotos(vehicleId: string): Promise<{
  photos: ExportPhoto[];
  documents: ExportPhoto[];
}> {
  const [{ data: photos }, { data: docs }] = await Promise.all([
    supabase
      .from("photos")
      .select("image_url, shot_type, sort_order, created_at, is_main")
      .eq("vehicle_id", vehicleId),
    supabase
      .from("vehicle_documents")
      .select("sort_order, is_main, created_at, document:documents(name, image_url)")
      .eq("vehicle_id", vehicleId),
  ]);
  const sortFn = (a: { sort_order: number; created_at: string }, b: { sort_order: number; created_at: string }) =>
    a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.created_at.localeCompare(b.created_at);
  const photoList: ExportPhoto[] = ((photos as { image_url: string; shot_type: string | null; sort_order: number; created_at: string; is_main: boolean }[]) || [])
    .sort(sortFn)
    .map((p) => ({ image_url: p.image_url, shot_type: p.shot_type }));
  const docList: ExportPhoto[] = (((docs as unknown) as { sort_order: number; created_at: string; is_main: boolean; document: { name: string; image_url: string } | null }[]) || [])
    .filter((d) => d.document?.image_url)
    .sort(sortFn)
    .map((d) => ({
      image_url: d.document!.image_url,
      shot_type: null,
      is_document: true,
      doc_name: d.document!.name,
    }));
  return { photos: photoList, documents: docList };
}
