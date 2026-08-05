import { useEffect, useMemo, useState } from "react";
import {
  type ExportPhoto,
  type ExportVehicle,
  buildAndDownloadZip,
  filenameFor,
  folderForVehicle,
  loadVehiclePhotos,
  todayStamp,
  uniqueName,
} from "@/lib/export-photos";

type Props = {
  vehicles: ExportVehicle[];
  onClose: () => void;
};

type VehicleData = {
  photos: ExportPhoto[];
  documents: ExportPhoto[];
  selectedPhotos: Set<number>;
  selectedDocs: Set<number>;
  expanded: boolean;
  loaded: boolean;
};

export function CustomExportModal({ vehicles, onClose }: Props) {
  const [data, setData] = useState<Record<string, VehicleData>>({});
  const [includeDocs, setIncludeDocs] = useState(false);
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null);

  // Eagerly load all vehicle photos
  useEffect(() => {
    void (async () => {
      const next: Record<string, VehicleData> = {};
      await Promise.all(
        vehicles.map(async (v) => {
          const { photos, documents } = await loadVehiclePhotos(v.id);
          next[v.id] = {
            photos,
            documents,
            selectedPhotos: new Set(photos.map((_, i) => i)),
            selectedDocs: new Set(documents.map((_, i) => i)),
            expanded: false,
            loaded: true,
          };
        }),
      );
      setData(next);
    })();
  }, [vehicles]);

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

  const updateVehicle = (id: string, fn: (d: VehicleData) => VehicleData) => {
    setData((prev) => ({ ...prev, [id]: fn(prev[id]) }));
  };

  const totals = useMemo(() => {
    let count = 0;
    for (const v of vehicles) {
      const d = data[v.id];
      if (!d) continue;
      count += d.selectedPhotos.size;
      if (includeDocs) count += d.selectedDocs.size;
    }
    return count;
  }, [data, vehicles, includeDocs]);

  const handleDownload = async () => {
    const exports = vehicles
      .map((v) => {
        const d = data[v.id];
        if (!d) return null;
        const pp = d.photos.filter((_, i) => d.selectedPhotos.has(i));
        const dd = includeDocs ? d.documents.filter((_, i) => d.selectedDocs.has(i)) : [];
        const chosen = [...pp, ...dd];
        if (chosen.length === 0) return null;
        return { vehicle: v, photos: chosen };
      })
      .filter((x): x is { vehicle: ExportVehicle; photos: ExportPhoto[] } => x !== null);
    if (exports.length === 0) return;
    const showProgress = totals > 10;
    setProgress({ cur: 0, total: totals });
    try {
      await buildAndDownloadZip(
        exports,
        `dealershot_export_${todayStamp()}.zip`,
        showProgress ? (c, t) => setProgress({ cur: c, total: t }) : undefined,
      );
    } finally {
      setProgress(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-card text-card-foreground w-full sm:max-w-3xl sm:rounded-xl border border-border flex flex-col max-h-screen sm:max-h-[90vh]">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between gap-3">
          <h2 className="text-base sm:text-lg font-semibold">Custom Export</h2>
          <button
            onClick={onClose}
            disabled={!!progress}
            className="text-muted-foreground hover:text-foreground text-lg"
          >
            ✕
          </button>
        </div>

        <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeDocs}
              onChange={(e) => setIncludeDocs(e.target.checked)}
            />
            Include attached documents (all vehicles)
          </label>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3">
          {vehicles.map((v) => {
            const d = data[v.id];
            return (
              <div key={v.id} className="rounded-md border border-border">
                <button
                  onClick={() => updateVehicle(v.id, (x) => ({ ...x, expanded: !x.expanded }))}
                  disabled={!d}
                  className="w-full p-3 flex items-center justify-between gap-3 hover:bg-secondary/40 text-left"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {v.year} {v.make} {v.model}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {v.stock_number || v.vin || "—"} ·{" "}
                      {d
                        ? `${d.selectedPhotos.size + (includeDocs ? d.selectedDocs.size : 0)} of ${d.photos.length + (includeDocs ? d.documents.length : 0)} selected`
                        : "Loading…"}
                    </p>
                  </div>
                  <span className="text-muted-foreground">{d?.expanded ? "▾" : "▸"}</span>
                </button>
                {d?.expanded && (
                  <div className="border-t border-border p-3 space-y-2">
                    {d.photos.length === 0 && d.documents.length === 0 && (
                      <p className="text-xs text-muted-foreground">No photos.</p>
                    )}
                    {d.photos.map((p, i) => (
                      <PhotoRow
                        key={`p${i}`}
                        url={p.image_url}
                        label={p.shot_type || "Untitled"}
                        filename={filenameFor(p, v, i)}
                        checked={d.selectedPhotos.has(i)}
                        onToggle={() =>
                          updateVehicle(v.id, (x) => {
                            const n = new Set(x.selectedPhotos);
                            if (n.has(i)) n.delete(i);
                            else n.add(i);
                            return { ...x, selectedPhotos: n };
                          })
                        }
                      />
                    ))}
                    {includeDocs &&
                      d.documents.map((doc, i) => (
                        <PhotoRow
                          key={`d${i}`}
                          url={doc.image_url}
                          label={doc.doc_name || "Document"}
                          filename={filenameFor(doc, v, i)}
                          checked={d.selectedDocs.has(i)}
                          onToggle={() =>
                            updateVehicle(v.id, (x) => {
                              const n = new Set(x.selectedDocs);
                              if (n.has(i)) n.delete(i);
                              else n.add(i);
                              return { ...x, selectedDocs: n };
                            })
                          }
                        />
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {progress && progress.total > 10 && (
          <div className="px-4 sm:px-5 pb-2">
            <p className="text-xs text-muted-foreground mb-1">
              Preparing {progress.cur} of {progress.total} photos…
            </p>
            <div className="h-1.5 bg-secondary rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(progress.cur / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="p-4 sm:p-5 border-t border-border flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {totals} file{totals === 1 ? "" : "s"} across {vehicles.length} vehicle
            {vehicles.length === 1 ? "" : "s"}
          </p>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <button
              onClick={onClose}
              disabled={!!progress}
              className="rounded-md border border-border bg-secondary px-4 py-2 min-h-[44px] text-sm hover:bg-secondary/80"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDownload()}
              disabled={totals === 0 || !!progress}
              className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {progress ? "Preparing…" : "Download ZIP"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoRow({
  url,
  label,
  filename,
  checked,
  onToggle,
}: {
  url: string;
  label: string;
  filename: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded border border-border/50 p-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onToggle} className="h-4 w-4" />
      <img src={url} alt="" className="h-10 w-14 object-contain rounded bg-background" />
      <div className="min-w-0 flex-1">
        <p className="text-xs truncate">{label}</p>
        <p className="text-[11px] text-muted-foreground truncate font-mono">{filename}</p>
      </div>
    </label>
  );
}

// Used by the Export page to know folder/file naming for tooltips, etc.
export { folderForVehicle, uniqueName };
