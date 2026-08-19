import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { translateVehicleDeletionFailure } from "@/lib/vehicle-deletion";

const deleteVehicleInput = z.object({ vehicle_id: z.string().uuid() });

type DeleteVehicleResult = {
  status: "deleted" | "already_deleted";
  operation_id: string;
  vehicle_id: string;
  storage_status: "queued" | "running" | "succeeded" | "failed";
  storage_object_count: number;
  cancelled_job_count?: number;
};

export const deleteVehicle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => deleteVehicleInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase.rpc(
      "delete_vehicle" as never,
      {
        _vehicle_id: data.vehicle_id,
      } as never,
    );
    if (error) {
      console.error("[Vehicle deletion] Database operation failed", {
        vehicle_id: data.vehicle_id,
        error_code: error.code,
      });
      return { ok: false as const, error: translateVehicleDeletionFailure(error) };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return {
        ok: false as const,
        error: {
          code: "delete_failed" as const,
          message: "DealerShot couldn't confirm that the vehicle was deleted safely.",
        },
      };
    }
    return { ok: true as const, result: result as unknown as DeleteVehicleResult };
  });
