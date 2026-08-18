import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { VehicleForm } from "@/components/VehicleForm";
import { CarFront } from "lucide-react";
import { EmptyState, PageHeader, StatusBadge } from "@/components/product-ui";

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
    selectedDealership,
    selectedDealershipId: dealershipId,
    requestedDealershipDenied,
  } = useAccessibleDealerships(dealership);

  if (requestedDealershipDenied) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface">
          <EmptyState
            icon={<CarFront className="size-5" />}
            title="Store access required"
            description="This add-vehicle link belongs to a store you cannot access. Choose an authorized store from the global selector."
          />
        </div>
      </main>
    );
  }

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

      {selectedDealership && (
        <div className="mb-6">
          <StatusBadge tone="info" className="min-h-8 px-3">
            Adding to {selectedDealership.name}
          </StatusBadge>
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
