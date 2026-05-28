import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { VehicleForm } from "@/components/VehicleForm";

export const Route = createFileRoute("/_authenticated/vehicles/new")({
  validateSearch: (s: Record<string, unknown>) => ({
    dealership: typeof s.dealership === "string" ? s.dealership : undefined,
  }),
  head: () => ({ meta: [{ title: "Add Vehicle — DealerShot" }] }),
  component: NewVehiclePage,
});

function NewVehiclePage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { dealership } = Route.useSearch();
  const [dealershipId, setDealershipId] = useState<string | null>(null);
  const [dealerships, setDealerships] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (profile?.role === "owner") {
      void (async () => {
        const { data } = await supabase.from("dealerships").select("id, name").order("name");
        const list = (data as { id: string; name: string }[]) || [];
        setDealerships(list);
        setDealershipId(dealership || list[0]?.id || null);
      })();
    } else if (profile?.dealership_id) {
      setDealershipId(profile.dealership_id);
    }
  }, [profile?.role, profile?.dealership_id, dealership]);

  if (!dealershipId) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10">
        <p className="text-sm text-muted-foreground">
          {profile?.role === "owner" ? "Create a dealership first." : "No dealership assigned to your account."}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Add Vehicle</h1>
        <p className="text-sm text-muted-foreground mt-1">Enter VIN to auto-fill specs, then review and save.</p>
      </div>

      {profile?.role === "owner" && dealerships.length > 1 && (
        <div className="mb-6">
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Dealership</label>
          <select
            value={dealershipId}
            onChange={(e) => setDealershipId(e.target.value)}
            className="form-input max-w-sm"
          >
            {dealerships.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6">
        <VehicleForm
          dealershipId={dealershipId}
          onSaved={(id) => navigate({ to: "/vehicles/$id", params: { id } })}
          onCancel={() => navigate({ to: "/inventory" })}
        />
      </div>
    </main>
  );
}
