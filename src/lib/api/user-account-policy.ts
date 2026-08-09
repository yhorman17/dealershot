export type ManagedDealerRole = "dealer_admin" | "staff";

type ResolveUserAccountUpdateInput = {
  targetRole: string;
  requestedRole?: ManagedDealerRole;
  requestedDealershipIds: string[];
};

export function resolveUserAccountUpdate({
  targetRole,
  requestedRole,
  requestedDealershipIds,
}: ResolveUserAccountUpdateInput): {
  role: "owner" | ManagedDealerRole;
  dealershipId: string | null;
  dealershipIds: string[];
} {
  if (targetRole === "owner") {
    if (requestedRole !== undefined) {
      throw new Error("Owner roles cannot be changed through browser input.");
    }
    return { role: "owner", dealershipId: null, dealershipIds: [] };
  }

  if (requestedRole !== "dealer_admin" && requestedRole !== "staff") {
    throw new Error("Select a dealer role for this user.");
  }
  const dealershipIds = [...new Set(requestedDealershipIds)];
  if (dealershipIds.length === 0) {
    throw new Error("Dealer users must belong to an active dealership.");
  }
  if (requestedRole === "staff" && dealershipIds.length !== 1) {
    throw new Error("Staff users must belong to exactly one dealership.");
  }

  return { role: requestedRole, dealershipId: dealershipIds[0], dealershipIds };
}
