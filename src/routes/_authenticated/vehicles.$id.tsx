import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatMiles, formatPrice } from "@/lib/vehicle-options";
import { VehiclePhotos } from "@/components/VehiclePhotos";

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

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [{ data }, { data: photos }] = await Promise.all([
        supabase.from("vehicles").select("*").eq("id", id).maybeSingle(),
        supabase
          .from("photos")
          .select("image_url, shot_type, sort_order, created_at, is_main")
          .eq("vehicle_id", id),
      ]);
      setVehicle(data as Vehicle | null);
      const rows = (photos as { image_url: string; shot_type: string | null; sort_order: number; created_at: string; is_main: boolean }[]) || [];
      const main = rows.find((p) => p.is_main);
      const front = rows.find((p) => p.shot_type === "Front");
      const first = [...rows].sort((a, b) =>
        a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.created_at.localeCompare(b.created_at),
      )[0];
      setHeroUrl(main?.image_url ?? front?.image_url ?? first?.image_url ?? null);
      setLoading(false);
    })();
  }, [id]);

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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link to="/inventory" className="text-xs text-muted-foreground hover:text-foreground">
        ← Back to inventory
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {vehicle.year} {vehicle.make} {vehicle.model}
          </h1>
          {vehicle.trim && <p className="text-sm text-muted-foreground mt-1">{vehicle.trim}</p>}
          <p className="text-2xl font-semibold text-primary mt-3">{formatPrice(Number(vehicle.price))}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/vehicles/$id/edit"
            params={{ id }}
            className="rounded-md border border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80"
          >
            Edit
          </Link>
          <button
            onClick={() => void handleDelete()}
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive hover:bg-destructive/20"
          >
            Delete
          </button>
        </div>
      </div>

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
    </main>
  );
}
