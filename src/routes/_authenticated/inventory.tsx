import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CONDITIONS, STATUSES, formatPrice, formatMiles } from "@/lib/vehicle-options";

export const Route = createFileRoute("/_authenticated/inventory")({
  head: () => ({ meta: [{ title: "Inventory — DealerShot" }] }),
  component: InventoryPage,
});

type Vehicle = {
  id: string;
  dealership_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  price: number | null;
  odometer: number | null;
  condition: string | null;
  status: string | null;
  exterior_color: string | null;
  stock_number: string | null;
  thumbnail_url?: string | null;
};

type Dealership = { id: string; name: string };

function InventoryPage() {
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

  useEffect(() => {
    if (isOwner) {
      void (async () => {
        const { data } = await supabase.from("dealerships").select("id, name").order("name");
        setDealerships((data as Dealership[]) || []);
        if (data && data.length > 0 && !selectedDealershipId) {
          setSelectedDealershipId(data[0].id);
        }
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
    void (async () => {
      const { data } = await supabase
        .from("vehicles")
        .select(
          "id, dealership_id, year, make, model, trim, price, odometer, condition, status, exterior_color, stock_number",
        )
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
        // Priority: is_main (1) > Front (2) > anything else (3); within same rank, lower sort_order then older created_at.
        const rank = (r: PRow) => (r.is_main ? 1 : r.shot_type === "Front" ? 2 : 3);
        const byVehicle = new Map<string, PRow>();
        for (const row of (photoRows as PRow[]) || []) {
          const cur = byVehicle.get(row.vehicle_id);
          if (
            !cur ||
            rank(row) < rank(cur) ||
            (rank(row) === rank(cur) && row.sort_order < cur.sort_order) ||
            (rank(row) === rank(cur) &&
              row.sort_order === cur.sort_order &&
              row.created_at < cur.created_at)
          ) {
            byVehicle.set(row.vehicle_id, row);
          }
        }
        for (const v of list) {
          v.thumbnail_url = byVehicle.get(v.id)?.image_url ?? null;
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

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filtered.length} vehicle{filtered.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 w-full sm:w-auto">
          {isOwner && (
            <select
              value={selectedDealershipId || ""}
              onChange={(e) => setSelectedDealershipId(e.target.value || null)}
              className="form-input"
            >
              {dealerships.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <Link
            to="/vehicles/new"
            search={{ dealership: selectedDealershipId ?? undefined }}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add Vehicle
          </Link>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
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

      {loading ? (
        <div className="motion-content text-sm text-muted-foreground text-center py-16">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="motion-empty text-sm text-muted-foreground text-center py-16 rounded-xl border border-dashed border-border">
          No vehicles match your filters.
        </div>
      ) : (
        <div className="motion-content grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((v) => (
            <Link
              key={v.id}
              to="/vehicles/$id"
              params={{ id: v.id }}
              className="motion-card group rounded-xl border border-border bg-card overflow-hidden hover:border-primary/60"
            >
              <div className="aspect-[4/3] bg-secondary flex items-center justify-center text-muted-foreground text-xs overflow-hidden">
                {v.thumbnail_url ? (
                  <img
                    src={v.thumbnail_url}
                    alt={`${v.year} ${v.make} ${v.model}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  "No photo"
                )}
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium text-card-foreground text-sm">
                    {v.year} {v.make} {v.model}
                  </h3>
                  <span className="text-sm font-semibold text-primary whitespace-nowrap">
                    {formatPrice(v.price)}
                  </span>
                </div>
                {v.trim && <p className="text-xs text-muted-foreground mt-0.5">{v.trim}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-xs text-muted-foreground">
                  <span>{formatMiles(v.odometer)}</span>
                  {v.condition && <span>· {v.condition}</span>}
                </div>
                <div className="mt-3">
                  <span className="motion-status inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                    {v.status || "—"}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
