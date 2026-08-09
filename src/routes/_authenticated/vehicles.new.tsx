import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { VehicleForm } from "@/components/VehicleForm";
import { CarFront } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/product-ui";

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
      <main className="ds-page-gutter">
        <div className="ds-surface">
          <EmptyState
            icon={<CarFront className="size-5" />}
            title="A dealership is required"
            description={
              profile?.role === "owner"
                ? "Create a dealership before adding its first vehicle."
                : "Your account is not assigned to a dealership. Ask an owner to update your access."
            }
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds-page-gutter max-w-6xl">
      <PageHeader
        eyebrow="Inventory intake"
        title="Add vehicle"
        description="Decode the VIN, verify the inventory details, then continue directly into the photo workspace."
      />

      {profile?.role === "owner" && dealerships.length > 1 && (
        <div className="mb-6">
          <label className="block text-xs font-medium text-card-foreground mb-1.5">
            Dealership
          </label>
          <select
            value={dealershipId}
            onChange={(e) => setDealershipId(e.target.value)}
            className="form-input max-w-sm"
          >
            {dealerships.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="ds-surface p-4 sm:p-6">
        <VehicleForm
          dealershipId={dealershipId}
          onSaved={(id) => navigate({ to: "/vehicles/$id", params: { id } })}
          onCancel={() => navigate({ to: "/inventory" })}
        />
      </div>
    </main>
  );
}
