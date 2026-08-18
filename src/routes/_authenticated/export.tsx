import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { CONDITIONS, STATUSES } from "@/lib/vehicle-options";
import {
  type ExportVehicle,
  buildAndDownloadZip,
  loadVehiclePhotos,
  todayStamp,
} from "@/lib/export-photos";
import { CustomExportModal } from "@/components/CustomExportModal";
import { PageHeader, ProductSelect, StatusBadge } from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveAuthorizedMediaUrls } from "@/lib/private-media";

export const Route = createFileRoute("/_authenticated/export")({
  head: () => ({ meta: [{ title: "Export — DealerShot" }] }),
  component: ExportPage,
});

type Vehicle = ExportVehicle & {
  condition: string | null;
  status: string | null;
  thumbnail_url?: string | null;
  photo_count?: number;
};

function ExportPage() {
  const { selectedDealershipId } = useAccessibleDealerships();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [conditionFilter, setConditionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customOpen, setCustomOpen] = useState(false);
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null);

  useEffect(() => {
    if (!selectedDealershipId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelected(new Set());
    void (async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("id, year, make, model, vin, stock_number, condition, status")
        .eq("dealership_id", selectedDealershipId)
        .order("created_at", { ascending: false });
      const list = (data as Vehicle[]) || [];
      const ids = list.map((v) => v.id);
      if (ids.length > 0) {
        const { data: photoRows } = await supabase
          .from("photos")
          .select("vehicle_id, media_asset_id, shot_type, created_at, sort_order, is_main")
          .in("vehicle_id", ids);
        type PRow = {
          vehicle_id: string;
          media_asset_id: string;
          shot_type: string | null;
          created_at: string;
          sort_order: number;
          is_main: boolean;
        };
        const rank = (r: PRow) => (r.is_main ? 1 : r.shot_type === "Front" ? 2 : 3);
        const byVehicle = new Map<string, PRow>();
        const counts = new Map<string, number>();
        for (const row of (photoRows as PRow[]) || []) {
          counts.set(row.vehicle_id, (counts.get(row.vehicle_id) || 0) + 1);
          const cur = byVehicle.get(row.vehicle_id);
          if (!cur || rank(row) < rank(cur)) byVehicle.set(row.vehicle_id, row);
        }
        const thumbnails = await resolveAuthorizedMediaUrls(
          [...byVehicle.values()].map((row) => row.media_asset_id),
          "thumbnail",
        );
        for (const v of list) {
          const mediaAssetId = byVehicle.get(v.id)?.media_asset_id;
          v.thumbnail_url = mediaAssetId ? (thumbnails.get(mediaAssetId) ?? null) : null;
          v.photo_count = counts.get(v.id) || 0;
        }
      }
      setVehicles(list);
      setLoading(false);
    })();
  }, [selectedDealershipId]);

  const years = useMemo(() => {
    const set = new Set<number>();
    vehicles.forEach((v) => v.year && set.add(v.year));
    return Array.from(set).sort((a, b) => b - a);
  }, [vehicles]);

  const filtered = vehicles.filter((v) => {
    const q = search.toLowerCase().trim();
    if (q && !`${v.make} ${v.model}`.toLowerCase().includes(q)) return false;
    if (yearFilter && String(v.year) !== yearFilter) return false;
    if (conditionFilter && v.condition !== conditionFilter) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    return true;
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const selectAllFiltered = () => setSelected(new Set(filtered.map((v) => v.id)));
  const clearSelection = () => setSelected(new Set());

  const selectedVehicles = vehicles.filter((v) => selected.has(v.id));
  const totalPhotos = selectedVehicles.reduce((s, v) => s + (v.photo_count || 0), 0);

  const handleQuickExport = async () => {
    if (selectedVehicles.length === 0) return;
    const showProgress = totalPhotos > 10;
    setProgress({ cur: 0, total: totalPhotos });
    try {
      const exports = await Promise.all(
        selectedVehicles.map(async (v) => {
          const { photos } = await loadVehiclePhotos(v.id);
          return { vehicle: v, photos };
        }),
      );
      const single = exports.length === 1;
      const zipName = single
        ? `${(exports[0].vehicle.stock_number || exports[0].vehicle.vin || "vehicle").toUpperCase()}_photos.zip`
        : `dealershot_export_${todayStamp()}.zip`;
      await buildAndDownloadZip(
        exports,
        zipName,
        showProgress ? (c, t) => setProgress({ cur: c, total: t }) : undefined,
      );
    } finally {
      setProgress(null);
    }
  };

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Delivery"
        title="Photo exports"
        description="Select retail-ready vehicles and package their ordered photo sets into a ZIP archive."
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <input
          placeholder="Search make or model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input"
        />
        <ProductSelect
          value={yearFilter}
          onValueChange={setYearFilter}
          ariaLabel="Year"
          emptyLabel="All years"
          options={years.map((year) => ({ value: String(year), label: String(year) }))}
        />
        <ProductSelect
          value={conditionFilter}
          onValueChange={setConditionFilter}
          ariaLabel="Condition"
          emptyLabel="All conditions"
          options={CONDITIONS.map((condition) => ({ value: condition, label: condition }))}
        />
        <ProductSelect
          value={statusFilter}
          onValueChange={setStatusFilter}
          ariaLabel="Status"
          emptyLabel="All statuses"
          options={STATUSES.map((status) => ({ value: status, label: status }))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
        <button onClick={selectAllFiltered} className="text-primary hover:underline">
          Select All Filtered
        </button>
        <button onClick={clearSelection} className="text-muted-foreground hover:text-foreground">
          Clear Selection
        </button>
        <span className="text-muted-foreground ml-auto">
          {selected.size} vehicle{selected.size === 1 ? "" : "s"} selected · {totalPhotos} total
          photos
        </span>
      </div>

      {loading ? (
        <div className="ds-surface overflow-hidden" aria-busy="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              className="flex items-center gap-3 border-b border-border p-3 last:border-0"
              key={index}
            >
              <Skeleton className="size-5" />
              <Skeleton className="h-12 w-16" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="motion-empty text-sm text-muted-foreground text-center py-16 rounded-xl border border-dashed border-border">
          No vehicles match.
        </p>
      ) : (
        <ul className="ds-surface divide-y divide-border overflow-hidden">
          {filtered.map((v) => (
            <li key={v.id} className="motion-row flex items-center gap-3 p-3 hover:bg-secondary/40">
              <input
                type="checkbox"
                checked={selected.has(v.id)}
                onChange={() => toggle(v.id)}
                className="h-4 w-4"
              />
              <div className="h-12 w-16 rounded bg-background overflow-hidden flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                {v.thumbnail_url ? (
                  <img src={v.thumbnail_url} alt="" className="h-full w-full object-contain" />
                ) : (
                  "No photo"
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {v.year} {v.make} {v.model}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {v.stock_number || v.vin || "—"}
                </p>
              </div>
              <StatusBadge tone={(v.photo_count || 0) > 0 ? "success" : "warning"}>
                {v.photo_count || 0} photo{v.photo_count === 1 ? "" : "s"}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <div
          className="motion-content fixed bottom-4 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-96 rounded-xl border border-border bg-card p-4 shadow-2xl z-40"
          role="status"
          aria-live="polite"
        >
          <p className="text-xs mb-2">
            Preparing {progress.cur} of {progress.total} photos…
          </p>
          <div className="h-1.5 bg-secondary rounded overflow-hidden">
            <div
              className="motion-progress-bar h-full w-full origin-left bg-primary"
              style={{ transform: `scaleX(${progress.cur / Math.max(progress.total, 1)})` }}
            />
          </div>
        </div>
      )}

      <div className="sticky bottom-0 mt-6 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-background/95 backdrop-blur border-t border-border flex flex-col sm:flex-row gap-2 sm:justify-end">
        <button
          onClick={() => setCustomOpen(true)}
          disabled={selected.size === 0 || !!progress}
          className="rounded-md border border-border bg-secondary px-4 py-2 min-h-[44px] text-sm hover:bg-secondary/80 disabled:opacity-50"
        >
          Custom Export…
        </button>
        <button
          onClick={() => void handleQuickExport()}
          disabled={selected.size === 0 || !!progress}
          className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {progress ? "Preparing…" : "Quick Export"}
        </button>
      </div>

      {customOpen && (
        <CustomExportModal vehicles={selectedVehicles} onClose={() => setCustomOpen(false)} />
      )}
    </main>
  );
}
