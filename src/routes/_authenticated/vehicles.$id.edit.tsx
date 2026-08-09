import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { VehicleForm, type VehicleFormValues, emptyVehicleValues } from "@/components/VehicleForm";
import { PageHeader, PageSkeleton } from "@/components/product-ui";

export const Route = createFileRoute("/_authenticated/vehicles/$id/edit")({
  head: () => ({ meta: [{ title: "Edit Vehicle — DealerShot" }] }),
  component: EditVehiclePage,
});

function EditVehiclePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [initial, setInitial] = useState<VehicleFormValues | null>(null);
  const [dealershipId, setDealershipId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from("vehicles").select("*").eq("id", id).maybeSingle();
      if (!data) return;
      const v = data as Record<string, unknown>;
      const s = (k: string) => (v[k] == null ? "" : String(v[k]));
      setDealershipId(v.dealership_id as string);
      setInitial({
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
      });
    })();
  }, [id]);

  if (!initial || !dealershipId) {
    return <PageSkeleton cards={0} rows={7} />;
  }

  return (
    <main className="ds-page-gutter max-w-6xl">
      <PageHeader
        eyebrow="Vehicle details"
        title="Edit vehicle"
        description="Update retail and specification details without changing the vehicle’s identity."
      />
      <div className="ds-surface p-4 sm:p-6">
        <VehicleForm
          initial={initial}
          dealershipId={dealershipId}
          vehicleId={id}
          onSaved={(vid) => navigate({ to: "/vehicles/$id", params: { id: vid } })}
          onCancel={() => navigate({ to: "/vehicles/$id", params: { id } })}
        />
      </div>
    </main>
  );
}
