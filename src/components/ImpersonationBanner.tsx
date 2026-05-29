import { useImpersonation } from "@/hooks/use-impersonation";

export function ImpersonationBanner() {
  const { impersonation, end } = useImpersonation();
  if (!impersonation) return null;

  return (
    <div className="sticky top-0 z-30 w-full bg-amber-400 text-amber-950 border-b border-amber-600 shadow-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <p className="text-xs sm:text-sm font-semibold tracking-tight truncate">
          <span className="uppercase">Viewing as:</span>{" "}
          <span className="font-bold">{impersonation.dealershipName}</span>
        </p>
        <button
          type="button"
          onClick={() => void end()}
          className="shrink-0 inline-flex items-center rounded-md bg-amber-950 px-3 py-1.5 text-xs sm:text-sm font-medium text-amber-50 hover:bg-amber-900 transition-colors"
        >
          Exit impersonation
        </button>
      </div>
    </div>
  );
}
