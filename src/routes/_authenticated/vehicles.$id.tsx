import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatMiles, formatPrice } from "@/lib/vehicle-options";
import { VehiclePhotos } from "@/components/VehiclePhotos";
import { VehicleExportModal } from "@/components/VehicleExportModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { VehicleForm, type VehicleFormValues, emptyVehicleValues } from "@/components/VehicleForm";

export const Route = createFileRoute("/_authenticated/vehicles/$id")({
  head: () => ({ meta: [{ title: "Vehicle — DealerShot" }] }),
  component: VehicleDetailPage,
});

type Vehicle = Record<string, string | number | null> & { id: string };

function VehicleDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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
    const photoRows = (photos as { image_url: string; shot_type: string | null; sort_order: number; created_at: string; is_main: boolean }[]) || [];
    const docRows = ((docs as unknown as { sort_order: number; is_main: boolean; created_at: string; document: { image_url: string } | null }[]) || [])
      .filter((d) => d.document?.image_url)
      .map((d) => ({ image_url: d.document!.image_url, shot_type: null as string | null, sort_order: d.sort_order, created_at: d.created_at, is_main: d.is_main }));
    const all = [...photoRows, ...docRows];
    const main = all.find((p) => p.is_main);
    const front = photoRows.find((p) => p.shot_type === "Front");
    const first = [...all].sort((a, b) =>
      a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.created_at.localeCompare(b.created_at),
    )[0];
    setHeroUrl(main?.image_url ?? front?.image_url ?? first?.image_url ?? null);
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);


  const handleDelete = async () => {
    if (!confirm("Delete this vehicle? This cannot be undone.")) return;
    const { error } = await supabase.from("vehicles").delete().eq("id", id);
    if (error) return alert(error.message);
    navigate({ to: "/inventory" });
  };

  if (loading) {
    return <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-muted-foreground">Loading…</main>;
  }
  if (!vehicle) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Vehicle not found.</p>
        <Link to="/inventory" className="text-sm text-primary mt-2 inline-block">Back to inventory</Link>
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
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-10">
      <Link to="/inventory" className="text-xs text-muted-foreground hover:text-foreground">
        ← Back to inventory
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground break-words">
            {vehicle.year} {vehicle.make} {vehicle.model}
          </h1>
          {vehicle.trim && <p className="text-sm text-muted-foreground mt-1">{vehicle.trim}</p>}
          <p className="text-xl sm:text-2xl font-semibold text-primary mt-3">{formatPrice(Number(vehicle.price))}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setEditOpen(true)}
            className="rounded-md border border-border bg-secondary px-4 py-2 min-h-[44px] inline-flex items-center text-sm text-secondary-foreground hover:bg-secondary/80"
          >
            Edit
          </button>
          <button
            onClick={() => setExportOpen(true)}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Export Photos
          </button>
          <button
            onClick={() => void handleDelete()}
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 min-h-[44px] text-sm text-destructive hover:bg-destructive/20"
          >
            Delete
          </button>
        </div>
      </div>

      {heroUrl && (
        <div className="mt-6 aspect-[16/9] rounded-xl overflow-hidden bg-background border border-border">
          <img src={heroUrl} alt={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} className="w-full h-full object-contain" />
        </div>
      )}

      <div className="mt-6">
        <VehiclePhotos vehicleId={id} />
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold text-card-foreground mb-4">Specifications</h2>
        <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
          {specs.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="text-sm text-card-foreground text-right">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>

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
    </main>
  );
}

function vehicleToFormValues(v: Vehicle): VehicleFormValues {
  const s = (k: string) => {
    const val = (v as Record<string, string | number | null>)[k];
    return val == null ? "" : String(val);
  };
  return {
    ...emptyVehicleValues,
    vin: s("vin"), year: s("year"), make: s("make"), model: s("model"), trim: s("trim"),
    body_class: s("body_class"), engine: s("engine"), cylinders: s("cylinders"),
    transmission: s("transmission"), drivetrain: s("drivetrain"), fuel_type: s("fuel_type"),
    exterior_color: s("exterior_color"), interior_color: s("interior_color"),
    odometer: s("odometer"), price: s("price"), stock_number: s("stock_number"),
    condition: s("condition") || "Used", status: s("status") || "Available",
  };
}
