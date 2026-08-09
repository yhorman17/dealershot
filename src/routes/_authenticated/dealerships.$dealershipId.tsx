import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  Building2,
  CarFront,
  FileImage,
  ImagePlus,
  MapPin,
  Phone,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  ErrorState,
  MetricCard,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from "@/components/product-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/dealerships/$dealershipId")({
  head: () => ({ meta: [{ title: "Dealership workspace — DealerShot" }] }),
  component: DealershipWorkspacePage,
});

type DealershipDetail = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  status: string;
  subscription_status: string;
  created_at: string;
};

type DealershipCounts = {
  vehicles: number;
  staff: number;
  overlays: number;
  backdrops: number;
  documents: number;
};

const emptyCounts: DealershipCounts = {
  vehicles: 0,
  staff: 0,
  overlays: 0,
  backdrops: 0,
  documents: 0,
};

function DealershipWorkspacePage() {
  const { dealershipId } = Route.useParams();
  const navigate = useNavigate();
  const { profile, loading: authLoading } = useAuth();
  const [dealership, setDealership] = useState<DealershipDetail | null>(null);
  const [counts, setCounts] = useState<DealershipCounts>(emptyCounts);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!authLoading && profile && profile.role !== "owner") {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [authLoading, navigate, profile]);

  useEffect(() => {
    if (profile?.role !== "owner") return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      const [dealershipResult, vehicles, staff, overlays, backdrops, documents] = await Promise.all(
        [
          supabase
            .from("dealerships")
            .select("id, name, address, phone, logo_url, status, subscription_status, created_at")
            .eq("id", dealershipId)
            .maybeSingle(),
          supabase
            .from("vehicles")
            .select("id", { count: "exact", head: true })
            .eq("dealership_id", dealershipId),
          supabase
            .from("profiles")
            .select("id", { count: "exact", head: true })
            .eq("dealership_id", dealershipId),
          supabase
            .from("overlay_templates")
            .select("id", { count: "exact", head: true })
            .eq("dealership_id", dealershipId),
          supabase
            .from("backdrops")
            .select("id", { count: "exact", head: true })
            .eq("dealership_id", dealershipId),
          supabase
            .from("documents")
            .select("id", { count: "exact", head: true })
            .eq("dealership_id", dealershipId),
        ],
      );

      if (cancelled) return;
      if (dealershipResult.error || !dealershipResult.data) {
        setDealership(null);
        setError(
          dealershipResult.error
            ? "This dealership could not be loaded. Check your connection and try again."
            : "This dealership no longer exists or is not available to your account.",
        );
        setLoading(false);
        return;
      }

      const countError = [vehicles, staff, overlays, backdrops, documents].find(
        (result) => result.error,
      )?.error;
      if (countError) {
        setError("Dealership activity totals could not be loaded. Try again in a moment.");
        setLoading(false);
        return;
      }

      setDealership(dealershipResult.data as DealershipDetail);
      setCounts({
        vehicles: vehicles.count ?? 0,
        staff: staff.count ?? 0,
        overlays: overlays.count ?? 0,
        backdrops: backdrops.count ?? 0,
        documents: documents.count ?? 0,
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [dealershipId, profile?.role, reloadKey]);

  if (authLoading || loading) return <DealershipWorkspaceSkeleton />;
  if (profile?.role !== "owner") return null;

  if (error || !dealership) {
    return (
      <main className="ds-page-gutter">
        <div className="mb-4">
          <Button asChild variant="ghost" className="-ml-3">
            <Link to="/dealerships">
              <ArrowLeft aria-hidden />
              Back to dealerships
            </Link>
          </Button>
        </div>
        <ErrorState
          title="Dealership unavailable"
          description={error ?? "This dealership could not be found."}
          onRetry={() => setReloadKey((value) => value + 1)}
        />
      </main>
    );
  }

  const resources = [
    {
      title: "Overlays",
      description: "Banners, corner badges, disclosures, and reusable brand graphics.",
      count: counts.overlays,
      to: "/overlays" as const,
      icon: ImagePlus,
    },
    {
      title: "Backdrops",
      description: "Approved showroom, lot, and branded photo backgrounds.",
      count: counts.backdrops,
      to: "/backdrops" as const,
      icon: Aperture,
    },
    {
      title: "Documents",
      description: "Window stickers, disclosures, and vehicle-supporting images.",
      count: counts.documents,
      to: "/documents" as const,
      icon: FileImage,
    },
  ];

  return (
    <main className="ds-page-gutter">
      <div className="mb-4">
        <Button asChild variant="ghost" className="-ml-3">
          <Link to="/dealerships">
            <ArrowLeft aria-hidden />
            Back to dealerships
          </Link>
        </Button>
      </div>

      <PageHeader
        eyebrow="Owner workspace"
        title={dealership.name}
        description="Review this tenant and manage the dealership-specific assets used throughout DealerShot."
        actions={
          <Button asChild>
            <Link to="/vehicles/new" search={{ dealership: dealership.id }}>
              Add vehicle
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        }
      />

      <section className="ds-surface mb-5 overflow-hidden">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {dealership.logo_url ? (
              <img
                src={dealership.logo_url}
                alt=""
                className="size-14 shrink-0 rounded-lg border border-border bg-secondary object-cover"
              />
            ) : (
              <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                <Building2 aria-hidden className="size-6" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold tracking-[-0.02em] text-card-foreground">
                {dealership.name}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StatusBadge tone={dealership.status === "active" ? "success" : "warning"}>
                  {dealership.status}
                </StatusBadge>
                <StatusBadge
                  tone={dealership.subscription_status === "active" ? "success" : "warning"}
                >
                  {dealership.subscription_status} subscription
                </StatusBadge>
              </div>
            </div>
          </div>
          <dl className="grid min-w-0 gap-2 text-sm sm:max-w-sm">
            <div className="flex items-start gap-2 text-muted-foreground">
              <MapPin aria-hidden className="mt-0.5 size-4 shrink-0" />
              <dd>{dealership.address || "No address added"}</dd>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Phone aria-hidden className="size-4 shrink-0" />
              <dd>{dealership.phone || "No phone added"}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        aria-label="Dealership activity"
        className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        <MetricCard
          label="Vehicles"
          value={counts.vehicles}
          icon={<CarFront className="size-4" />}
        />
        <MetricCard
          label="Staff accounts"
          value={counts.staff}
          icon={<Users className="size-4" />}
        />
        <MetricCard
          label="Overlays"
          value={counts.overlays}
          icon={<ImagePlus className="size-4" />}
        />
        <MetricCard
          label="Backdrops"
          value={counts.backdrops}
          icon={<Aperture className="size-4" />}
        />
        <MetricCard
          label="Documents"
          value={counts.documents}
          icon={<FileImage className="size-4" />}
        />
      </section>

      <section className="ds-surface overflow-hidden">
        <SectionHeader
          title="Dealership assets"
          description="Each manager below opens with this dealership already selected."
        />
        <div className="grid gap-px bg-border lg:grid-cols-3">
          {resources.map((resource) => {
            const Icon = resource.icon;
            return (
              <article key={resource.title} className="bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon aria-hidden className="size-5" />
                  </span>
                  <span className="text-2xl font-semibold tracking-[-0.04em] tabular-nums text-card-foreground">
                    {resource.count}
                  </span>
                </div>
                <h2 className="mt-4 text-sm font-semibold text-card-foreground">
                  {resource.title}
                </h2>
                <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
                  {resource.description}
                </p>
                <Button asChild variant="outline" className="mt-4 w-full justify-between">
                  <Link to={resource.to} search={{ dealership: dealership.id }}>
                    Manage {resource.title.toLowerCase()}
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function DealershipWorkspaceSkeleton() {
  return (
    <main className="ds-page-gutter" aria-busy="true">
      <Skeleton className="mb-5 h-9 w-44" />
      <div className="mb-7 space-y-3 border-b border-border pb-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-9 w-72 max-w-[75vw]" />
        <Skeleton className="h-4 w-[30rem] max-w-[90vw]" />
      </div>
      <Skeleton className="mb-5 h-28 w-full" />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </main>
  );
}
