import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { CONDITIONS, STATUSES, formatPrice, formatMiles } from "@/lib/vehicle-options";
import { Camera, CarFront, Plus, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  StatusBadge,
} from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";

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
  vin: string | null;
  thumbnail_url?: string | null;
};

function InventoryPage() {
  const { dealerships, selectedDealershipId, setSelectedDealershipId, canSwitchDealerships } =
    useAccessibleDealerships();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [conditionFilter, setConditionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!selectedDealershipId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      const { data, error: loadError } = await supabase
        .from("vehicles")
        .select(
          "id, dealership_id, year, make, model, trim, price, odometer, condition, status, exterior_color, stock_number, vin",
        )
        .eq("dealership_id", selectedDealershipId)
        .order("created_at", { ascending: false });
      if (loadError) {
        setError("Inventory could not be loaded. Check your connection and try again.");
        setLoading(false);
        return;
      }
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
  }, [selectedDealershipId, reloadKey]);

  const years = useMemo(() => {
    const set = new Set<number>();
    vehicles.forEach((v) => v.year && set.add(v.year));
    return Array.from(set).sort((a, b) => b - a);
  }, [vehicles]);

  const filtered = vehicles.filter((v) => {
    const q = search.toLowerCase().trim();
    if (
      q &&
      !`${v.year} ${v.make} ${v.model} ${v.trim} ${v.stock_number} ${v.vin}`
        .toLowerCase()
        .includes(q)
    )
      return false;
    if (yearFilter && String(v.year) !== yearFilter) return false;
    if (conditionFilter && v.condition !== conditionFilter) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    return true;
  });

  const visibleVehicles = [...filtered].sort((a, b) => {
    if (sort === "price-high") return (b.price ?? 0) - (a.price ?? 0);
    if (sort === "price-low") return (a.price ?? 0) - (b.price ?? 0);
    if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
    return 0;
  });
  const hasFilters = Boolean(search || yearFilter || conditionFilter || statusFilter);
  const clearFilters = () => {
    setSearch("");
    setYearFilter("");
    setConditionFilter("");
    setStatusFilter("");
  };

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Vehicle operations"
        title="Inventory"
        description="Find vehicles quickly, review retail readiness, and move directly into the photo workspace."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/bulk-photos">
                <Camera aria-hidden className="size-4" /> Bulk Photos
              </Link>
            </Button>
            <Button asChild>
              <Link to="/vehicles/new" search={{ dealership: selectedDealershipId ?? undefined }}>
                <Plus aria-hidden className="size-4" />
                Add vehicle
              </Link>
            </Button>
          </div>
        }
      />

      <section className="ds-surface mb-5 p-3 sm:p-4" aria-label="Inventory filters">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <SearchInput
            aria-label="Search inventory"
            placeholder="Search year, make, model, stock or VIN"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1"
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:flex">
            {canSwitchDealerships && (
              <Select
                value={selectedDealershipId || ""}
                onValueChange={(value) => setSelectedDealershipId(value || null)}
              >
                <SelectTrigger className="h-11 min-w-44 bg-card">
                  <SelectValue placeholder="Select dealership" />
                </SelectTrigger>
                <SelectContent>
                  {dealerships.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={yearFilter || "all"}
              onValueChange={(value) => setYearFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All years</SelectItem>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={conditionFilter || "all"}
              onValueChange={(value) => setConditionFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All conditions</SelectItem>
                {CONDITIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter || "all"}
              onValueChange={(value) => setStatusFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-11 bg-card">
                <SlidersHorizontal aria-hidden className="size-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="year">Year: newest</SelectItem>
                <SelectItem value="price-high">Price: high to low</SelectItem>
                <SelectItem value="price-low">Price: low to high</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
          <span aria-live="polite">
            <strong className="font-semibold text-foreground">{filtered.length}</strong> of{" "}
            {vehicles.length} vehicles
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex min-h-8 items-center gap-1.5 font-medium text-primary hover:text-primary/80"
            >
              <X aria-hidden className="size-3.5" />
              Clear filters
            </button>
          )}
        </div>
      </section>

      {loading ? (
        <div
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          aria-busy="true"
          aria-label="Loading inventory"
        >
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="ds-surface overflow-hidden" key={index}>
              <Skeleton className="aspect-[16/10] w-full rounded-none" />
              <div className="space-y-3 p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-6 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorState description={error} onRetry={() => setReloadKey((value) => value + 1)} />
      ) : filtered.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<CarFront className="size-5" />}
            title={
              hasFilters
                ? "No vehicles match those filters"
                : "Your inventory is ready for its first vehicle"
            }
            description={
              hasFilters
                ? "Try a broader search or clear one of the active filters."
                : "Add a vehicle to begin building its details, guided photo set, and export package."
            }
            action={
              hasFilters ? (
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button asChild>
                  <Link
                    to="/vehicles/new"
                    search={{ dealership: selectedDealershipId ?? undefined }}
                  >
                    <Plus className="size-4" />
                    Add first vehicle
                  </Link>
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="motion-content grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visibleVehicles.map((v) => (
            <Link
              key={v.id}
              to="/vehicles/$id"
              params={{ id: v.id }}
              className="motion-card group ds-surface overflow-hidden hover:border-primary/45 hover:shadow-[0_10px_30px_-22px_oklch(0.25_0.03_252)]"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-secondary text-muted-foreground">
                {v.thumbnail_url ? (
                  <img
                    src={v.thumbnail_url}
                    alt={`${v.year} ${v.make} ${v.model}`}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-240 group-hover:scale-[1.015]"
                  />
                ) : (
                  <div className="ds-grid-lines flex h-full flex-col items-center justify-center gap-2">
                    <CarFront aria-hidden className="size-7 opacity-45" />
                    <span className="text-xs font-medium">Photo set not started</span>
                  </div>
                )}
                <div className="absolute left-3 top-3">
                  <StatusBadge tone={statusTone(v.status)}>{v.status || "Unspecified"}</StatusBadge>
                </div>
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 text-[15px] font-semibold leading-5 tracking-[-0.015em] text-card-foreground">
                    {v.year} {v.make} {v.model}
                  </h3>
                  <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-card-foreground">
                    {formatPrice(v.price)}
                  </span>
                </div>
                {v.trim && <p className="text-xs text-muted-foreground mt-0.5">{v.trim}</p>}
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
                  <div>
                    <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Mileage
                    </span>
                    <span className="mt-0.5 block font-medium text-foreground">
                      {formatMiles(v.odometer)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Stock
                    </span>
                    <span className="mt-0.5 block truncate font-medium text-foreground">
                      {v.stock_number || "—"}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

function statusTone(status: string | null): "success" | "warning" | "neutral" | "info" {
  const value = status?.toLowerCase() ?? "";
  if (value === "available" || value === "ready") return "success";
  if (value.includes("pending") || value.includes("photo")) return "warning";
  if (value === "sold") return "info";
  return "neutral";
}
