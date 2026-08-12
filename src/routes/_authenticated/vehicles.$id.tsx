import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatMiles, formatPrice } from "@/lib/vehicle-options";
import { VehiclePhotos } from "@/components/VehiclePhotos";
import { VehicleExportModal } from "@/components/VehicleExportModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { VehicleForm, type VehicleFormValues, emptyVehicleValues } from "@/components/VehicleForm";
import { ArrowLeft, Camera, CarFront, FileOutput, Gauge, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, PageHeader, PageSkeleton, StatusBadge } from "@/components/product-ui";

export const Route = createFileRoute("/_authenticated/vehicles/$id")({
  validateSearch: (search: Record<string, unknown>): { customize?: string } => ({
    customize: typeof search.customize === "string" ? search.customize : undefined,
  }),
  head: () => ({ meta: [{ title: "Vehicle — DealerShot" }] }),
  component: VehicleDetailPage,
});

type Vehicle = Record<string, string | number | null> & { id: string };

function VehicleDetailPage() {
  const { id } = Route.useParams();
  const { customize } = Route.useSearch();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const canDelete = profile?.role === "owner" || profile?.role === "dealer_admin";
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, { data: photos }, { data: docs }] = await Promise.all([
      supabase.from("vehicles").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("photos")
        .select("image_url, shot_type, sort_order, created_at, is_main")
        .eq("vehicle_id", id),
      supabase
        .from("vehicle_documents")
        .select("sort_order, is_main, created_at, document:documents(image_url)")
        .eq("vehicle_id", id),
    ]);
    setVehicle(data as Vehicle | null);
    const photoRows =
      (photos as {
        image_url: string;
        shot_type: string | null;
        sort_order: number;
        created_at: string;
        is_main: boolean;
      }[]) || [];
    const docRows = (
      (docs as unknown as {
        sort_order: number;
        is_main: boolean;
        created_at: string;
        document: { image_url: string } | null;
      }[]) || []
    )
      .filter((d) => d.document?.image_url)
      .map((d) => ({
        image_url: d.document!.image_url,
        shot_type: null as string | null,
        sort_order: d.sort_order,
        created_at: d.created_at,
        is_main: d.is_main,
      }));
    const all = [...photoRows, ...docRows];
    const main = all.find((p) => p.is_main);
    const front = photoRows.find((p) => p.shot_type === "Front");
    const first = [...all].sort((a, b) =>
      a.sort_order !== b.sort_order
        ? a.sort_order - b.sort_order
        : a.created_at.localeCompare(b.created_at),
    )[0];
    setHeroUrl(main?.image_url ?? front?.image_url ?? first?.image_url ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async () => {
    const { error } = await supabase.from("vehicles").delete().eq("id", id);
    if (error) {
      toast.error("Vehicle could not be deleted", { description: error.message });
      return;
    }
    toast.success("Vehicle deleted");
    navigate({ to: "/inventory" });
  };

  if (loading) {
    return <PageSkeleton cards={3} rows={6} />;
  }
  if (!vehicle) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface">
          <EmptyState
            icon={<CarFront className="size-5" />}
            title="Vehicle not found"
            description="This vehicle may have been removed or you may not have access to it."
            action={
              <Button asChild variant="outline">
                <Link to="/inventory">
                  <ArrowLeft className="size-4" />
                  Back to inventory
                </Link>
              </Button>
            }
          />
        </div>
      </main>
    );
  }

  const specs: [string, string | number | null][] = [
    ["VIN", vehicle.vin],
    ["Stock #", vehicle.stock_number],
    ["Year", vehicle.year],
    ["Make", vehicle.make],
    ["Model", vehicle.model],
    ["Trim", vehicle.trim],
    ["Body", vehicle.body_class],
    ["Engine", vehicle.engine],
    ["Cylinders", vehicle.cylinders],
    ["Transmission", vehicle.transmission],
    ["Drivetrain", vehicle.drivetrain],
    ["Fuel type", vehicle.fuel_type],
    ["Exterior color", vehicle.exterior_color],
    ["Interior color", vehicle.interior_color],
    ["Odometer", vehicle.odometer ? formatMiles(Number(vehicle.odometer)) : null],
    ["Condition", vehicle.condition],
    ["Status", vehicle.status],
  ];

  return (
    <main className="ds-page-gutter">
      <Link
        to="/inventory"
        className="mb-4 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        Inventory
      </Link>
      <PageHeader
        eyebrow={vehicle.stock_number ? `Stock ${vehicle.stock_number}` : "Vehicle workspace"}
        title={`${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim()}
        description={[vehicle.trim, vehicle.vin ? `VIN ${vehicle.vin}` : null]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit details
            </Button>
            <Button onClick={() => setExportOpen(true)}>
              <FileOutput className="size-4" />
              Export photos
            </Button>
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                aria-label="Delete vehicle"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={String(vehicle.status).toLowerCase() === "available" ? "success" : "neutral"}
          >
            {vehicle.status || "Unspecified"}
          </StatusBadge>
          {vehicle.condition && <StatusBadge dot={false}>{vehicle.condition}</StatusBadge>}
        </div>
      </PageHeader>

      <section className="mb-5 grid overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <div className="relative min-h-64 bg-[color:oklch(0.22_0.025_252)] sm:min-h-96">
          {heroUrl ? (
            <img
              src={heroUrl}
              alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="ds-grid-lines flex h-full min-h-64 flex-col items-center justify-center gap-3 text-white/45 sm:min-h-96">
              <Camera className="size-8" />
              <p className="text-sm font-medium">No lead photo selected</p>
            </div>
          )}
        </div>
        <div className="flex flex-col justify-between p-5 sm:p-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Retail snapshot
            </p>
            <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-foreground">
              {formatPrice(Number(vehicle.price))}
            </p>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <Snapshot
                label="Mileage"
                value={vehicle.odometer ? formatMiles(Number(vehicle.odometer)) : "—"}
                icon={<Gauge />}
              />
              <Snapshot
                label="Exterior"
                value={String(vehicle.exterior_color || "—")}
                icon={<CarFront />}
              />
              <Snapshot label="Stock" value={String(vehicle.stock_number || "—")} />
              <Snapshot label="Drivetrain" value={String(vehicle.drivetrain || "—")} />
            </div>
          </div>
          <p className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
            Use the photo workspace below to capture, organize, process, and prepare this vehicle
            for export.
          </p>
        </div>
      </section>

      <Tabs defaultValue="photos" className="space-y-4">
        <TabsList className="h-11 w-full justify-start overflow-x-auto rounded-lg border border-border bg-card p-1 sm:w-auto">
          <TabsTrigger value="photos" className="min-h-9 gap-2">
            <Camera className="size-4" />
            Photos & processing
          </TabsTrigger>
          <TabsTrigger value="specifications" className="min-h-9 gap-2">
            <CarFront className="size-4" />
            Specifications
          </TabsTrigger>
        </TabsList>
        <TabsContent value="photos" className="motion-tab-panel mt-0">
          <VehiclePhotos vehicleId={id} initialCustomizePhotoId={customize} />
        </TabsContent>
        <TabsContent value="specifications" className="motion-tab-panel mt-0">
          <section className="ds-surface overflow-hidden">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold text-card-foreground">Vehicle specifications</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Identity, drivetrain, colors, and sales details.
              </p>
            </div>
            <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
              {specs.map(([label, value]) => (
                <div key={label} className="min-w-0 border-b border-border p-4 sm:border-r sm:p-5">
                  <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1.5 break-words text-sm font-medium text-card-foreground">
                    {value ?? "—"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </TabsContent>
      </Tabs>

      {exportOpen && (
        <VehicleExportModal
          vehicle={{
            id,
            year: vehicle.year as number | null,
            make: vehicle.make as string | null,
            model: vehicle.model as string | null,
            stock_number: vehicle.stock_number as string | null,
            vin: vehicle.vin as string | null,
          }}
          onClose={() => setExportOpen(false)}
        />
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl w-[calc(100vw-1rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Vehicle</DialogTitle>
          </DialogHeader>
          <VehicleForm
            initial={vehicleToFormValues(vehicle)}
            dealershipId={(vehicle.dealership_id as string) || ""}
            vehicleId={id}
            onSaved={() => {
              setEditOpen(false);
              void load();
            }}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this vehicle?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {vehicle.year} {vehicle.make} {vehicle.model} and its related
              workspace data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep vehicle</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete vehicle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function Snapshot({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {icon && <span className="[&>svg]:size-3">{icon}</span>}
        {label}
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

function vehicleToFormValues(v: Vehicle): VehicleFormValues {
  const s = (k: string) => {
    const val = (v as Record<string, string | number | null>)[k];
    return val == null ? "" : String(val);
  };
  return {
    ...emptyVehicleValues,
    vin: s("vin"),
    year: s("year"),
    make: s("make"),
    model: s("model"),
    trim: s("trim"),
    body_class: s("body_class"),
    engine: s("engine"),
    cylinders: s("cylinders"),
    transmission: s("transmission"),
    drivetrain: s("drivetrain"),
    fuel_type: s("fuel_type"),
    exterior_color: s("exterior_color"),
    interior_color: s("interior_color"),
    odometer: s("odometer"),
    price: s("price"),
    stock_number: s("stock_number"),
    condition: s("condition") || "Used",
    status: s("status") || "Available",
  };
}
