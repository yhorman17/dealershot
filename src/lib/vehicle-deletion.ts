export type VehicleDeletionFailureCode =
  | "not_allowed"
  | "active_capture"
  | "active_processing"
  | "not_found"
  | "dependency_cleanup_failed"
  | "delete_failed";

export type VehicleDeletionFailure = {
  code: VehicleDeletionFailureCode;
  message: string;
};

export function translateVehicleDeletionFailure(error: {
  code?: string;
  message?: string;
}): VehicleDeletionFailure {
  const message = error.message ?? "";
  if (error.code === "42501") {
    return {
      code: "not_allowed",
      message: "You do not have permission to delete this vehicle.",
    };
  }
  if (/active photo shoot|pending uploads/i.test(message)) {
    return {
      code: "active_capture",
      message:
        "This vehicle has an active photo workflow. Cancel or finish it before deleting the vehicle.",
    };
  }
  if (/media processing in progress/i.test(message)) {
    return {
      code: "active_processing",
      message: "This vehicle is currently processing media. Try again after processing finishes.",
    };
  }
  if (error.code === "P0002" || /vehicle is unavailable/i.test(message)) {
    return { code: "not_found", message: "This vehicle is no longer available." };
  }
  if (/dependency|cleanup|foreign key|constraint/i.test(message)) {
    return {
      code: "dependency_cleanup_failed",
      message: "DealerShot could not safely remove all vehicle dependencies. No data was removed.",
    };
  }
  return {
    code: "delete_failed",
    message:
      "DealerShot couldn't safely delete this vehicle. No partial database deletion occurred.",
  };
}

export function vehicleDeletionIsBlocked(code: VehicleDeletionFailureCode) {
  return code === "active_capture" || code === "active_processing";
}
