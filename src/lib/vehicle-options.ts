export const CONDITIONS = ["New", "Used", "Certified Pre-Owned"] as const;
export const STATUSES = ["Available", "Pending", "Sold", "In Service"] as const;

export type VehicleCondition = (typeof CONDITIONS)[number];
export type VehicleStatus = (typeof STATUSES)[number];

export function formatPrice(price: number | null | undefined) {
  if (price == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(price));
}

export function formatMiles(odometer: number | null | undefined) {
  if (odometer == null) return "—";
  return `${new Intl.NumberFormat("en-US").format(odometer)} mi`;
}
