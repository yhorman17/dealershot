import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { VehicleForm } from "@/components/VehicleForm";
import { CarFront } from "lucide-react";
import { EmptyState, PageHeader, ProductSelect } from "@/components/product-ui";

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
  const {
    dealerships,
    selectedDealershipId: dealershipId,
    setSelectedDealershipId: setDealershipId,
    canSwitchDealerships,
  } = useAccessibleDealerships(dealership);

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

      {canSwitchDealerships && dealerships.length > 1 && (
        <div className="mb-6">
          <label className="block text-xs font-medium text-card-foreground mb-1.5">
            Dealership
          </label>
          <ProductSelect
            value={dealershipId || ""}
            onValueChange={setDealershipId}
            ariaLabel="Dealership"
            className="max-w-sm"
            options={dealerships.map((item) => ({ value: item.id, label: item.name }))}
          />
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
