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
import {
  parseReadinessReasons,
  readinessLabel,
  type ReadinessStatus,
} from "@/lib/retail-readiness";

type InventorySearch = {
  q?: string;
  readiness?: string;
  media?: string;
  price?: string;
};

export const Route = createFileRoute("/_authenticated/inventory")({
  validateSearch: (search: Record<string, unknown>): InventorySearch => ({
    q: typeof search.q === "string" ? search.q : undefined,
    readiness: typeof search.readiness === "string" ? search.readiness : undefined,
    media: typeof search.media === "string" ? search.media : undefined,
    price: typeof search.price === "string" ? search.price : undefined,
  }),
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
  inventory_arrival_date: string | null;
  inventory_type: "new" | "used" | "certified" | null;
  retail_readiness_status: ReadinessStatus;
  publication_state: string;
  assigned_photographer_id: string | null;
  thumbnail_url?: string | null;
  photo_count: number;
  video_count: number;
  readiness_reasons: ReturnType<typeof parseReadinessReasons>;
  photographer_name?: string | null;
};

function InventoryPage() {
  const initialSearch = Route.useSearch();
  const { dealerships, selectedDealershipId, setSelectedDealershipId, canSwitchDealerships } =
    useAccessibleDealerships();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(initialSearch.q ?? "");
  const [yearFilter, setYearFilter] = useState("");
  const [conditionFilter, setConditionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [readinessFilter, setReadinessFilter] = useState(initialSearch.readiness ?? "");
  const [mediaFilter, setMediaFilter] = useState(initialSearch.media ?? "");
  const [priceFilter, setPriceFilter] = useState(initialSearch.price ?? "");
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
      const [{ data, error: loadError }, { data: readinessRows }] = await Promise.all([
        supabase
          .from("vehicles")
          .select(
            "id, dealership_id, year, make, model, trim, price, odometer, condition, status, exterior_color, stock_number, vin, inventory_arrival_date, inventory_type, retail_readiness_status, publication_state, assigned_photographer_id",
          )
          .eq("dealership_id", selectedDealershipId)
          .order("created_at", { ascending: false }),
        supabase
          .from("vehicle_readiness")
          .select("vehicle_id, reasons, photo_count, video_count")
          .eq("dealership_id", selectedDealershipId),
      ]);
      if (loadError) {
        setError("Inventory could not be loaded. Check your connection and try again.");
        setLoading(false);
        return;
      }
      const readinessMap = new Map(
        (
          (readinessRows as Array<{
            vehicle_id: string;
            reasons: unknown;
            photo_count: number;
            video_count: number;
          }>) ?? []
        ).map((row) => [row.vehicle_id, row]),
      );
      const list = (
        (data as Omit<Vehicle, "photo_count" | "video_count" | "readiness_reasons">[]) || []
      ).map((vehicle) => {
        const readiness = readinessMap.get(vehicle.id);
        return {
          ...vehicle,
          photo_count: readiness?.photo_count ?? 0,
          video_count: readiness?.video_count ?? 0,
          readiness_reasons: parseReadinessReasons(readiness?.reasons),
        };
      });
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
      const photographerIds = [
        ...new Set(
          list.flatMap((vehicle) =>
            vehicle.assigned_photographer_id ? [vehicle.assigned_photographer_id] : [],
          ),
        ),
      ];
      if (photographerIds.length > 0) {
        const { data: photographers } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", photographerIds);
        const photographerMap = new Map(
          (
            (photographers as Array<{ id: string; full_name: string | null; email: string }>) ?? []
          ).map((person) => [person.id, person.full_name || person.email]),
        );
        for (const vehicle of list) {
          vehicle.photographer_name = vehicle.assigned_photographer_id
            ? (photographerMap.get(vehicle.assigned_photographer_id) ?? null)
            : null;
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
    if (readinessFilter && v.retail_readiness_status !== readinessFilter) return false;
    if (mediaFilter === "no_photos" && v.photo_count !== 0) return false;
    if (
      mediaFilter === "short_shoot" &&
      !v.readiness_reasons.some((reason) =>
        ["media.minimum_photos", "media.required_shot"].includes(reason.key),
      )
    )
      return false;
    if (priceFilter === "missing" && v.price !== null) return false;
    return true;
  });

  const visibleVehicles = [...filtered].sort((a, b) => {
    if (sort === "price-high") return (b.price ?? 0) - (a.price ?? 0);
    if (sort === "price-low") return (a.price ?? 0) - (b.price ?? 0);
    if (sort === "year") return (b.year ?? 0) - (a.year ?? 0);
    if (sort === "age")
      return (a.inventory_arrival_date ?? "9999").localeCompare(b.inventory_arrival_date ?? "9999");
    return 0;
  });
  const hasFilters = Boolean(
    search ||
    yearFilter ||
    conditionFilter ||
    statusFilter ||
    readinessFilter ||
    mediaFilter ||
    priceFilter,
  );
  const clearFilters = () => {
    setSearch("");
    setYearFilter("");
    setConditionFilter("");
    setStatusFilter("");
    setReadinessFilter("");
    setMediaFilter("");
    setPriceFilter("");
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
            <Select
              value={readinessFilter || "all"}
              onValueChange={(value) => setReadinessFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All readiness</SelectItem>
                <SelectItem value="retail_ready">Retail Ready</SelectItem>
                <SelectItem value="needs_attention">Needs Attention</SelectItem>
                <SelectItem value="blocked">Blocked</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="awaiting_review">Awaiting Review</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={mediaFilter || "all"}
              onValueChange={(value) => setMediaFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All media</SelectItem>
                <SelectItem value="no_photos">No Photos</SelectItem>
                <SelectItem value="short_shoot">Short Shoot</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={priceFilter || "all"}
              onValueChange={(value) => setPriceFilter(value === "all" ? "" : value)}
            >
              <SelectTrigger className="h-11 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All prices</SelectItem>
                <SelectItem value="missing">Missing price</SelectItem>
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
                <SelectItem value="age">Oldest inventory</SelectItem>
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
        <>
          <div className="motion-content hidden overflow-x-auto rounded-lg border border-border bg-card xl:block">
            <table className="w-full min-w-[1100px] text-left text-xs">
              <thead className="sticky top-16 z-10 bg-secondary text-muted-foreground">
                <tr>
                  {[
                    "Vehicle",
                    "Stock / VIN",
                    "Mileage",
                    "Price",
                    "Age",
                    "Media",
                    "Readiness",
                    "Photographer",
                  ].map((label) => (
                    <th key={label} className="px-3 py-3 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleVehicles.map((vehicle) => (
                  <tr key={vehicle.id} className="border-t border-border hover:bg-secondary/55">
                    <td className="p-2">
                      <Link
                        to="/vehicles/$id"
                        params={{ id: vehicle.id }}
                        className="flex min-h-12 items-center gap-3 rounded-md p-1 font-semibold hover:text-primary"
                      >
                        <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
                          {vehicle.thumbnail_url ? (
                            <img
                              src={vehicle.thumbnail_url}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <CarFront className="size-5 text-muted-foreground" />
                          )}
                        </span>
                        <span>
                          <span className="block">
                            {vehicle.year} {vehicle.make} {vehicle.model}
                          </span>
                          <span className="block font-normal text-muted-foreground">
                            {vehicle.trim || vehicle.inventory_type || "—"}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <span className="block font-medium">{vehicle.stock_number || "—"}</span>
                      <span className="block text-muted-foreground">{vehicle.vin || "—"}</span>
                    </td>
                    <td className="px-3 py-3 tabular-nums">{formatMiles(vehicle.odometer)}</td>
                    <td className="px-3 py-3 font-semibold tabular-nums">
                      {formatPrice(vehicle.price)}
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      {inventoryAge(vehicle.inventory_arrival_date)}
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-semibold tabular-nums">{vehicle.photo_count}</span>{" "}
                      photos
                      {vehicle.video_count > 0 && (
                        <span className="block text-muted-foreground">
                          {vehicle.video_count} video
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge tone={readinessTone(vehicle.retail_readiness_status)}>
                        {readinessLabel(vehicle.retail_readiness_status)}
                      </StatusBadge>
                      {vehicle.readiness_reasons[0] && (
                        <span className="mt-1 block max-w-48 truncate text-muted-foreground">
                          {vehicle.readiness_reasons[0].label}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">{vehicle.photographer_name || "Unassigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="motion-content grid gap-4 sm:grid-cols-2 xl:hidden">
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
                    <StatusBadge tone={readinessTone(v.retail_readiness_status)}>
                      {readinessLabel(v.retail_readiness_status)}
                    </StatusBadge>
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
                    <div>
                      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Media
                      </span>
                      <span className="mt-0.5 block font-medium text-foreground">
                        {v.photo_count} photos
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Age
                      </span>
                      <span className="mt-0.5 block font-medium text-foreground">
                        {inventoryAge(v.inventory_arrival_date)}
                      </span>
                    </div>
                  </div>
                  {v.readiness_reasons[0] && (
                    <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                      Needs: {v.readiness_reasons[0].label}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function readinessTone(status: ReadinessStatus): "success" | "warning" | "danger" | "info" {
  if (status === "retail_ready") return "success";
  if (status === "blocked") return "danger";
  if (status === "processing" || status === "awaiting_review") return "info";
  return "warning";
}

function inventoryAge(value: string | null): string {
  if (!value) return "—";
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(`${value}T00:00:00`).getTime()) / 86_400_000),
  );
  return `${days}d`;
}
