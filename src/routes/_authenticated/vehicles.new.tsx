import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { VehicleForm } from "@/components/VehicleForm";
import { CarFront } from "lucide-react";
import { EmptyState, PageHeader, StatusBadge } from "@/components/product-ui";
import { useCaptureMethods } from "@/hooks/use-capture-methods";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { parseCaptureMethodConfiguration } from "@/lib/capture-methods";
import { toast } from "sonner";

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
  const { configuration, loading: loadingCaptureMethods } = useCaptureMethods(dealershipId);

  const continueToCapture = async (vehicleId: string) => {
    const { data: currentConfiguration, error: configurationError } = await supabase.rpc(
      "get_capture_method_configuration",
      { _dealership_id: dealershipId! },
    );
    if (configurationError) {
      toast.error("Vehicle saved, but capture settings could not be loaded", {
        description: configurationError.message,
      });
      await navigate({ to: "/vehicles/$id", params: { id: vehicleId } });
      return;
    }
    const method = parseCaptureMethodConfiguration(currentConfiguration as Json).defaultMethod;
    const { data, error } = await supabase.rpc("start_photo_capture_session", {
      _dealership_id: dealershipId!,
      _vehicle_id: vehicleId,
      _mode: method,
    });
    if (error) {
      toast.error("Vehicle saved, but capture could not start", {
        description: error.message,
      });
      await navigate({ to: "/vehicles/$id", params: { id: vehicleId } });
      return;
    }
    if (method === "bulk") {
      await navigate({ to: "/bulk-photos/$id", params: { id: data.id } });
      return;
    }
    await navigate({
      to: "/vehicles/$id",
      params: { id: vehicleId },
      search: { capture: "guided" },
    });
  };

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
        description="Identify the vehicle, verify its details, then start the store's preferred photo workflow without returning to Inventory."
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
          onSaved={continueToCapture}
          onCancel={() => navigate({ to: "/inventory" })}
          submitLabel={
            loadingCaptureMethods
              ? "Save & start photos"
              : configuration.defaultMethod === "bulk"
                ? "Start photos"
                : "Start guided capture"
          }
        />
      </div>
    </main>
  );
}
