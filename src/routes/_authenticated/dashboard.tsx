import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OwnerDashboard } from "@/components/OwnerDashboard";
import { formatPrice } from "@/lib/vehicle-options";

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
  const dealershipId = profile?.dealership_id ?? null;
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [needsPhotosCount, setNeedsPhotosCount] = useState(0);
  const [needsPhotosIds, setNeedsPhotosIds] = useState<string[]>([]);
  const [recent, setRecent] = useState<RecentVehicle[]>([]);

  useEffect(() => {
    if (!dealershipId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const { data: vehicles } = await supabase
        .from("vehicles")
        .select("id, year, make, model, trim, price, created_at")
        .eq("dealership_id", dealershipId)
        .order("created_at", { ascending: false });
      const list = (vehicles as RecentVehicle[]) || [];
      setTotalCount(list.length);

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

      const needsIds: string[] = [];
      for (const v of list) {
        const photos = photosByVehicle.get(v.id) || [];
        const hasMain = photos.some((p) => p.is_main);
        const hasFront = photos.some((p) => (p.shot_type || "").toLowerCase() === "front");
        if (photos.length === 0 || (!hasMain && !hasFront)) {
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
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <p className="text-sm text-muted-foreground">Welcome back</p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground mt-1">
            {displayName}
          </h1>
          <div className="motion-status mt-2 inline-flex items-center rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            {roleLabel}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/vehicles/new"
            search={{ dealership: dealershipId ?? undefined }}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] inline-flex items-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add Vehicle
          </Link>
          <Link
            to="/inventory"
            className="rounded-md border border-border bg-secondary px-4 py-2 min-h-[44px] inline-flex items-center text-sm text-secondary-foreground hover:bg-secondary/80"
          >
            View Inventory
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Total vehicles"
          value={loading ? "—" : String(totalCount)}
          hint="In your dealership inventory"
          to="/inventory"
        />
        <StatCard
          label="Need photos"
          value={loading ? "—" : String(needsPhotosCount)}
          hint={needsPhotosCount > 0 ? "Missing main / front shot" : "All vehicles have photos"}
          to="/inventory"
          accent={needsPhotosCount > 0}
        />
        <StatCard
          label="Recently added"
          value={loading ? "—" : String(Math.min(recent.length, totalCount))}
          hint="Showing latest below"
        />
      </div>

      {/* Recent vehicles */}
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-card-foreground">Recent vehicles</h2>
          <Link to="/inventory" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </div>
        {loading ? (
          <p className="motion-content text-sm text-muted-foreground py-8 text-center">Loading…</p>
        ) : recent.length === 0 ? (
          <div className="motion-empty rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground mb-3">No vehicles yet.</p>
            <Link
              to="/vehicles/new"
              search={{ dealership: dealershipId ?? undefined }}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Add your first vehicle
            </Link>
          </div>
        ) : (
          <div className="motion-content grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {recent.map((v) => (
              <Link
                key={v.id}
                to="/vehicles/$id"
                params={{ id: v.id }}
                className="motion-card group rounded-lg border border-border bg-background overflow-hidden hover:border-primary/60"
              >
                <div className="aspect-[4/3] bg-secondary flex items-center justify-center text-muted-foreground text-xs overflow-hidden">
                  {v.thumbnail_url ? (
                    <img
                      src={v.thumbnail_url}
                      alt={`${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""}`.trim()}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    "No photo"
                  )}
                </div>
                <div className="p-3">
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

      {/* Needs photos quick-list */}
      {!loading && needsPhotosIds.length > 0 && (
        <section className="motion-content mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-card-foreground">
                Vehicles missing photos
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                {needsPhotosCount} vehicle{needsPhotosCount === 1 ? "" : "s"} need a main or front
                exterior shot.
              </p>
            </div>
            <Link
              to="/inventory"
              className="rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary/80"
            >
              Open inventory
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  hint,
  to,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  to?: string;
  accent?: boolean;
}) {
  const inner = (
    <div
      className={`motion-card rounded-xl border bg-card p-6 h-full ${
        accent
          ? "border-amber-500/40 hover:border-amber-500/70"
          : "border-border hover:border-primary/60"
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-2 text-3xl font-semibold ${accent ? "text-amber-400" : "text-card-foreground"}`}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
    </div>
  );
  if (to) {
    return (
      <Link to={to} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
