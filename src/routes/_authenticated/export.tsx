import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CONDITIONS, STATUSES } from "@/lib/vehicle-options";
import {
  type ExportVehicle,
  buildAndDownloadZip,
  loadVehiclePhotos,
  todayStamp,
} from "@/lib/export-photos";
import { CustomExportModal } from "@/components/CustomExportModal";

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

type Dealership = { id: string; name: string };

function ExportPage() {
  const { profile } = useAuth();
  const isOwner = profile?.role === "owner";
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [selectedDealershipId, setSelectedDealershipId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [conditionFilter, setConditionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customOpen, setCustomOpen] = useState(false);
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null);

  useEffect(() => {
    if (isOwner) {
      void (async () => {
        const { data } = await supabase.from("dealerships").select("id, name").order("name");
        setDealerships((data as Dealership[]) || []);
        if (data && data.length > 0 && !selectedDealershipId) setSelectedDealershipId(data[0].id);
      })();
    } else if (profile?.dealership_id) {
      setSelectedDealershipId(profile.dealership_id);
    }
  }, [isOwner, profile?.dealership_id]);

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
          .select("vehicle_id, image_url, shot_type, created_at, sort_order, is_main")
          .in("vehicle_id", ids);
        type PRow = {
          vehicle_id: string;
          image_url: string;
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
        for (const v of list) {
          v.thumbnail_url = byVehicle.get(v.id)?.image_url ?? null;
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
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Export</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Download photos in bulk as a ZIP archive.
          </p>
        </div>
        {isOwner && (
          <select
            value={selectedDealershipId || ""}
            onChange={(e) => setSelectedDealershipId(e.target.value || null)}
            className="form-input w-full sm:w-auto"
          >
            {dealerships.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <input
          placeholder="Search make or model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input"
        />
        <select
          value={yearFilter}
          onChange={(e) => setYearFilter(e.target.value)}
          className="form-input"
        >
          <option value="">All years</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select
          value={conditionFilter}
          onChange={(e) => setConditionFilter(e.target.value)}
          className="form-input"
        >
          <option value="">All conditions</option>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="form-input"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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
        <p className="text-sm text-muted-foreground text-center py-16">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-16 rounded-xl border border-dashed border-border">
          No vehicles match.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card overflow-hidden">
          {filtered.map((v) => (
            <li key={v.id} className="flex items-center gap-3 p-3 hover:bg-secondary/40">
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
              <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                {v.photo_count || 0} photo{v.photo_count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {progress && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-96 rounded-xl border border-border bg-card p-4 shadow-2xl z-40">
          <p className="text-xs mb-2">
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
