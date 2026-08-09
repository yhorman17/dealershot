import { useImpersonation } from "@/hooks/use-impersonation";

export function ImpersonationBanner() {
  const { impersonation, end } = useImpersonation();
  if (!impersonation) return null;

  return (
    <div className="sticky top-0 z-30 w-full border-b border-warning bg-warning text-warning-foreground shadow-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <p className="text-xs sm:text-sm font-semibold tracking-tight truncate">
          <span className="uppercase">Viewing as:</span>{" "}
          <span className="font-bold">{impersonation.dealershipName}</span>
        </p>
        <button
          type="button"
          onClick={() => void end()}
          className="inline-flex min-h-9 shrink-0 items-center rounded-md bg-warning-foreground px-3 py-1.5 text-xs font-medium text-warning hover:opacity-90 sm:text-sm"
        >
          Exit impersonation
        </button>
      </div>
    </div>
  );
}
