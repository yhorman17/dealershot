import { useEffect, useMemo, useState } from "react";
import {
  type ExportPhoto,
  type ExportVehicle,
  buildAndDownloadZip,
  downloadSinglePhoto,
  fileBaseForVehicle,
  filenameFor,
  loadVehiclePhotos,
  uniqueName,
} from "@/lib/export-photos";

type Props = {
  vehicle: ExportVehicle;
  onClose: () => void;
};

export function VehicleExportModal({ vehicle, onClose }: Props) {
  const [photos, setPhotos] = useState<ExportPhoto[]>([]);
  const [documents, setDocuments] = useState<ExportPhoto[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<number>>(new Set());
  const [includeDocs, setIncludeDocs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const { photos, documents } = await loadVehiclePhotos(vehicle.id);
      setPhotos(photos);
      setDocuments(documents);
      setSelected(new Set(photos.map((_, i) => i)));
      setLoading(false);
    })();
  }, [vehicle.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !progress && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, progress]);

  const previewNames = useMemo(() => {
    const taken = new Set<string>();
    const photoNames = photos.map((p, i) => uniqueName(taken, filenameFor(p, vehicle, i)));
    const docNames = documents.map((d, i) => uniqueName(taken, filenameFor(d, vehicle, i)));
    return { photoNames, docNames };
  }, [photos, documents, vehicle]);

  const togglePhoto = (i: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  };
  const toggleDoc = (i: number) => {
    setSelectedDocs((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  };

  const allSelected = selected.size === photos.length && (!includeDocs || selectedDocs.size === documents.length);
  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      setSelectedDocs(new Set());
    } else {
      setSelected(new Set(photos.map((_, i) => i)));
      if (includeDocs) setSelectedDocs(new Set(documents.map((_, i) => i)));
    }
  };

  useEffect(() => {
    if (includeDocs && selectedDocs.size === 0 && documents.length > 0) {
      setSelectedDocs(new Set(documents.map((_, i) => i)));
    }
  }, [includeDocs, documents, selectedDocs.size]);

  const chosen = useMemo(() => {
    const pp = photos.filter((_, i) => selected.has(i));
    const dd = includeDocs ? documents.filter((_, i) => selectedDocs.has(i)) : [];
    return [...pp, ...dd];
  }, [photos, documents, selected, selectedDocs, includeDocs]);

  const totalCount = chosen.length;
  const isSingle = totalCount === 1;
  const downloadLabel = progress
    ? `Preparing ${progress.cur} of ${progress.total}…`
    : isSingle
      ? "Download Photo"
      : `Download ${totalCount} as ZIP`;

  const handleDownload = async () => {
    if (totalCount === 0) return;
    if (isSingle) {
      setProgress({ cur: 0, total: 1 });
      try {
        await downloadSinglePhoto(chosen[0], vehicle);
      } finally {
        setProgress(null);
        onClose();
      }
      return;
    }
    const zipName = `${fileBaseForVehicle(vehicle)}_photos.zip`;
    const showProgress = totalCount > 10;
    setProgress({ cur: 0, total: totalCount });
    try {
      await buildAndDownloadZip(
        [{ vehicle, photos: chosen }],
        zipName,
        showProgress ? (c, t) => setProgress({ cur: c, total: t }) : undefined,
      );
    } finally {
      setProgress(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-card text-card-foreground w-full sm:max-w-2xl sm:rounded-xl border border-border flex flex-col max-h-screen sm:max-h-[90vh]">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold truncate">Export Photos</h2>
            <p className="text-xs text-muted-foreground truncate">
              {vehicle.year} {vehicle.make} {vehicle.model}
              {vehicle.stock_number ? ` · ${vehicle.stock_number}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={!!progress}
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading photos…</p>
          ) : photos.length === 0 && documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No photos for this vehicle.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <button
                  onClick={toggleAll}
                  className="text-xs text-primary hover:underline"
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeDocs}
                    onChange={(e) => setIncludeDocs(e.target.checked)}
                    disabled={documents.length === 0}
                  />
                  Include attached documents ({documents.length})
                </label>
              </div>

              <ul className="space-y-2">
                {photos.map((p, i) => (
                  <li
                    key={`p${i}`}
                    className="flex items-center gap-3 rounded-md border border-border p-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => togglePhoto(i)}
                      className="h-4 w-4"
                    />
                    <img
                      src={p.image_url}
                      alt=""
                      className="h-12 w-16 object-contain rounded bg-background"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{p.shot_type || "Untitled"}</p>
                      <p className="text-[11px] text-muted-foreground truncate font-mono">
                        {previewNames.photoNames[i]}
                      </p>
                    </div>
                  </li>
                ))}
                {includeDocs &&
                  documents.map((d, i) => (
                    <li
                      key={`d${i}`}
                      className="flex items-center gap-3 rounded-md border border-border p-2 bg-secondary/30"
                    >
                      <input
                        type="checkbox"
                        checked={selectedDocs.has(i)}
                        onChange={() => toggleDoc(i)}
                        className="h-4 w-4"
                      />
                      <img
                        src={d.image_url}
                        alt=""
                        className="h-12 w-16 object-contain rounded bg-background"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{d.doc_name || "Document"}</p>
                        <p className="text-[11px] text-muted-foreground truncate font-mono">
                          {previewNames.docNames[i]}
                        </p>
                      </div>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>

        {progress && progress.total > 10 && (
          <div className="px-4 sm:px-5 pb-2">
            <div className="h-1.5 bg-secondary rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(progress.cur / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="p-4 sm:p-5 border-t border-border flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            onClick={onClose}
            disabled={!!progress}
            className="rounded-md border border-border bg-secondary px-4 py-2 min-h-[44px] text-sm hover:bg-secondary/80"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleDownload()}
            disabled={totalCount === 0 || !!progress}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {downloadLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
