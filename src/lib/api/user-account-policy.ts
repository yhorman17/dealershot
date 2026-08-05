export type ManagedDealerRole = "dealer_admin" | "staff";

type ResolveUserAccountUpdateInput = {
  targetRole: string;
  requestedRole?: ManagedDealerRole;
  requestedDealershipId: string | null;
};

export function resolveUserAccountUpdate({
  targetRole,
  requestedRole,
  requestedDealershipId,
}: ResolveUserAccountUpdateInput): {
  role: "owner" | ManagedDealerRole;
  dealershipId: string | null;
} {
  if (targetRole === "owner") {
    if (requestedRole !== undefined) {
      throw new Error("Owner roles cannot be changed through browser input.");
    }
    return { role: "owner", dealershipId: null };
  }

  if (requestedRole !== "dealer_admin" && requestedRole !== "staff") {
    throw new Error("Select a dealer role for this user.");
  }
  if (!requestedDealershipId) {
    throw new Error("Dealer users must belong to an active dealership.");
  }

  return { role: requestedRole, dealershipId: requestedDealershipId };
}
