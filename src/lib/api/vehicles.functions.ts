import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const deleteVehicleInput = z.object({ vehicle_id: z.string().uuid() });

type DeleteVehicleResult = {
  status: "deleted" | "already_deleted";
  operation_id: string;
  vehicle_id: string;
  storage_status: "queued" | "running" | "succeeded" | "failed";
  storage_object_count: number;
  cancelled_job_count?: number;
};

function deletionFailure(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (error.code === "42501") {
    return {
      code: "not_allowed",
      message: "You do not have permission to delete this vehicle.",
    } as const;
  }
  if (/active photo shoot|pending uploads/i.test(message)) {
    return {
      code: "active_capture",
      message:
        "This vehicle has an active photo shoot or pending uploads. Finish or cancel that work before deleting it.",
    } as const;
  }
  if (/media processing in progress/i.test(message)) {
    return {
      code: "active_processing",
      message: "This vehicle has media processing in progress. Try again after it finishes.",
    } as const;
  }
  if (error.code === "P0002" || /vehicle is unavailable/i.test(message)) {
    return {
      code: "not_found",
      message: "This vehicle is no longer available.",
    } as const;
  }
  return {
    code: "delete_failed",
    message:
      "DealerShot couldn't safely delete this vehicle. No partial database deletion occurred.",
  } as const;
}

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
      return { ok: false as const, error: deletionFailure(error) };
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
