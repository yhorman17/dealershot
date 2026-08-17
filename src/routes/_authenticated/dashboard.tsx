import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { OwnerDashboard } from "@/components/OwnerDashboard";
import { formatPrice } from "@/lib/vehicle-options";
import { ArrowRight, Camera, CarFront, CircleGauge, Clock3, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  MetricCard,
  PageHeader,
  ProductSelect,
  SectionHeader,
  StatusBadge,
} from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — DealerShot" }] }),
  component: DashboardPage,
});

type RecentVehicle = {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  price: number | null;
  created_at: string;
  thumbnail_url?: string | null;
};

function DashboardPage() {
  const { user, profile } = useAuth();

  if (profile?.role === "owner") {
    return <OwnerDashboard />;
  }

  return <StaffDashboard userEmail={user?.email ?? null} profile={profile} />;
}

function StaffDashboard({
  userEmail,
  profile,
}: {
  userEmail: string | null;
  profile: { full_name: string | null; role: string; dealership_id: string | null } | null;
}) {
  const {
    dealerships,
    selectedDealershipId: dealershipId,
    setSelectedDealershipId,
    canSwitchDealerships,
  } = useAccessibleDealerships();
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [needsPhotosCount, setNeedsPhotosCount] = useState(0);
  const [needsPhotosIds, setNeedsPhotosIds] = useState<string[]>([]);
  const [retailReadyCount, setRetailReadyCount] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [missingPriceCount, setMissingPriceCount] = useState(0);
  const [recent, setRecent] = useState<RecentVehicle[]>([]);

  useEffect(() => {
    if (!dealershipId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const [{ data: vehicles }, { data: readinessRows }] = await Promise.all([
        supabase
          .from("vehicles")
          .select("id, year, make, model, trim, price, created_at")
          .eq("dealership_id", dealershipId)
          .order("created_at", { ascending: false }),
        supabase
          .from("vehicle_readiness")
          .select("vehicle_id, status, reasons")
          .eq("dealership_id", dealershipId),
      ]);
      const list = (vehicles as RecentVehicle[]) || [];
      setTotalCount(list.length);
      setMissingPriceCount(list.filter((vehicle) => vehicle.price === null).length);
      const readiness =
        (readinessRows as Array<{ vehicle_id: string; status: string; reasons: unknown }>) ?? [];
      setRetailReadyCount(readiness.filter((item) => item.status === "retail_ready").length);
      setBlockedCount(readiness.filter((item) => item.status === "blocked").length);
      setProcessingCount(
        readiness.filter((item) => ["processing", "awaiting_review"].includes(item.status)).length,
      );

      const ids = list.map((v) => v.id);
      const photosByVehicle = new Map<
        string,
        {
          image_url: string;
          is_main: boolean;
          shot_type: string | null;
          sort_order: number;
          created_at: string;
        }[]
      >();
      if (ids.length > 0) {
        const { data: photoRows } = await supabase
          .from("photos")
          .select("vehicle_id, image_url, is_main, shot_type, sort_order, created_at")
          .in("vehicle_id", ids);
        for (const row of (photoRows as {
          vehicle_id: string;
          image_url: string;
          is_main: boolean;
          shot_type: string | null;
          sort_order: number;
          created_at: string;
        }[]) || []) {
          const arr = photosByVehicle.get(row.vehicle_id) || [];
          arr.push(row);
          photosByVehicle.set(row.vehicle_id, arr);
        }
      }

      const needsIds = readiness
        .filter(
          (item) =>
            Array.isArray(item.reasons) &&
            item.reasons.some(
              (reason) =>
                reason &&
                typeof reason === "object" &&
                ["media.minimum_photos", "media.required_shot"].includes(
                  String((reason as Record<string, unknown>).key),
                ),
            ),
        )
        .map((item) => item.vehicle_id);
      for (const v of list) {
        const photos = photosByVehicle.get(v.id) || [];
        const hasMain = photos.some((p) => p.is_main);
        const hasFront = photos.some((p) => (p.shot_type || "").toLowerCase() === "front");
        if (readiness.length === 0 && (photos.length === 0 || (!hasMain && !hasFront))) {
          needsIds.push(v.id);
        }
        // Attach thumbnail (main > front > first)
        const main = photos.find((p) => p.is_main);
        const front = photos.find((p) => (p.shot_type || "").toLowerCase() === "front");
        const first = [...photos].sort((a, b) =>
          a.sort_order !== b.sort_order
            ? a.sort_order - b.sort_order
            : a.created_at.localeCompare(b.created_at),
        )[0];
        v.thumbnail_url = main?.image_url ?? front?.image_url ?? first?.image_url ?? null;
      }
      setNeedsPhotosCount(needsIds.length);
      setNeedsPhotosIds(needsIds);
      setRecent(list.slice(0, 6));
      setLoading(false);
    })();
  }, [dealershipId]);

  const displayName = profile?.full_name || userEmail || "there";
  const roleLabel = profile?.role
    ? profile.role.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Daily operations"
        title={`Good to see you, ${displayName}`}
        description="Track inventory readiness and jump back into the vehicles that need attention."
        actions={
          <>
            {canSwitchDealerships && (
              <ProductSelect
                value={dealershipId ?? ""}
                onValueChange={(value) => setSelectedDealershipId(value || null)}
                ariaLabel="Dealership"
                placeholder="Select dealership"
                options={dealerships.map((dealership) => ({
                  value: dealership.id,
                  label: dealership.name,
                }))}
              />
            )}
            <Button variant="outline" asChild>
              <Link to="/inventory">View inventory</Link>
            </Button>
            <Button asChild>
              <Link to="/vehicles/new" search={{ dealership: dealershipId ?? undefined }}>
                <Plus aria-hidden className="size-4" />
                Add vehicle
              </Link>
            </Button>
          </>
        }
      >
        <div className="mt-3">
          <StatusBadge tone="info">{roleLabel}</StatusBadge>
        </div>
      </PageHeader>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Link to="/inventory" search={{}} className="rounded-lg focus-visible:outline-none">
          <MetricCard
            label="Total vehicles"
            value={loading ? <Skeleton className="h-9 w-14" /> : totalCount}
            detail="Active dealership inventory"
            icon={<CarFront className="size-4" />}
          />
        </Link>
        <Link
          to="/inventory"
          search={{ readiness: "retail_ready" }}
          className="rounded-lg focus-visible:outline-none"
        >
          <MetricCard
            label="Retail Ready"
            value={loading ? <Skeleton className="h-9 w-14" /> : retailReadyCount}
            detail="All configured work complete"
            icon={<CircleGauge className="size-4" />}
          />
        </Link>
        <Link
          to="/inventory"
          search={{ media: "short_shoot" }}
          className="rounded-lg focus-visible:outline-none"
        >
          <MetricCard
            label="Short Shoot"
            value={loading ? <Skeleton className="h-9 w-14" /> : needsPhotosCount}
            detail="Missing required media"
            icon={<Camera className="size-4" />}
            tone={needsPhotosCount > 0 ? "attention" : "default"}
          />
        </Link>
        <Link
          to="/inventory"
          search={{ readiness: "blocked" }}
          className="rounded-lg focus-visible:outline-none"
        >
          <MetricCard
            label="Blocked"
            value={loading ? <Skeleton className="h-9 w-14" /> : blockedCount}
            detail="Requires corrective action"
            icon={<CircleGauge className="size-4" />}
            tone={blockedCount > 0 ? "attention" : "default"}
          />
        </Link>
        <Link
          to="/inventory"
          search={{ readiness: "processing" }}
          className="rounded-lg focus-visible:outline-none"
        >
          <MetricCard
            label="Processing / review"
            value={loading ? <Skeleton className="h-9 w-14" /> : processingCount}
            detail="Media work in flight"
            icon={<Clock3 className="size-4" />}
          />
        </Link>
        <Link
          to="/inventory"
          search={{ price: "missing" }}
          className="rounded-lg focus-visible:outline-none"
        >
          <MetricCard
            label="Missing Price"
            value={loading ? <Skeleton className="h-9 w-14" /> : missingPriceCount}
            detail="Visible latest arrivals"
            icon={<CircleGauge className="size-4" />}
          />
        </Link>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="ds-surface overflow-hidden">
          <SectionHeader
            title="Recent vehicles"
            description="Newest inventory arrivals"
            action={
              <Link
                to="/inventory"
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80"
              >
                View all <ArrowRight className="size-3.5" />
              </Link>
            }
          />
          {loading ? (
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div className="bg-card p-3" key={index}>
                  <Skeleton className="aspect-[16/10] w-full" />
                  <Skeleton className="mt-3 h-4 w-3/4" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              title="No vehicles in this dealership"
              description="Add the first vehicle to start its guided photo set and retail-ready workflow."
              action={
                <Button asChild>
                  <Link to="/vehicles/new" search={{ dealership: dealershipId ?? undefined }}>
                    <Plus className="size-4" />
                    Add first vehicle
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="motion-content grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((v) => (
                <Link
                  key={v.id}
                  to="/vehicles/$id"
                  params={{ id: v.id }}
                  className="motion-card group overflow-hidden bg-card p-3 hover:bg-secondary/35"
                >
                  <div className="aspect-[16/10] overflow-hidden rounded-md bg-secondary text-muted-foreground">
                    {v.thumbnail_url ? (
                      <img
                        src={v.thumbnail_url}
                        alt={`${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""}`.trim()}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="ds-grid-lines flex h-full items-center justify-center">
                        <Camera className="size-6 opacity-40" />
                      </div>
                    )}
                  </div>
                  <div className="pt-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-card-foreground truncate">
                        {v.year} {v.make} {v.model}
                      </h3>
                      <span className="text-xs font-semibold text-primary whitespace-nowrap">
                        {formatPrice(v.price)}
                      </span>
                    </div>
                    {v.trim && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{v.trim}</p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="ds-surface h-fit overflow-hidden">
          <SectionHeader title="Attention queue" description="What to handle next" />
          <div className="p-4">
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : needsPhotosIds.length > 0 ? (
              <>
                <div className="rounded-md border border-warning/35 bg-warning/10 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Camera className="size-4 text-warning-foreground" />
                    Complete lead photos
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {needsPhotosCount} vehicle{needsPhotosCount === 1 ? "" : "s"} need a main or
                    front exterior shot.
                  </p>
                </div>
                <Button asChild variant="outline" className="mt-3 w-full">
                  <Link to="/inventory">
                    Open inventory <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </>
            ) : (
              <div className="py-5 text-center">
                <div className="mx-auto grid size-10 place-items-center rounded-full bg-success/10 text-success">
                  <Camera className="size-4" />
                </div>
                <p className="mt-3 text-sm font-semibold">Lead photos covered</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  No vehicles currently need a lead photo.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
