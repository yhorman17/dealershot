import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Camera, CheckCircle2, Clock3, PackageOpen, ScanLine } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, ProductSelect, StatusBadge } from "@/components/product-ui";
import { toast } from "sonner";

const VinScannerModal = lazy(() =>
  import("@/components/VinScannerModal").then((module) => ({ default: module.VinScannerModal })),
);

export const Route = createFileRoute("/_authenticated/bulk-photos")({
  head: () => ({ meta: [{ title: "Bulk Photos — DealerShot" }] }),
  component: BulkPhotosPage,
});

type Session = {
  id: string;
  dealership_id: string;
  vehicle_id: string | null;
  vin: string | null;
  status: "in_progress" | "completed" | "prepared";
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  photoCount: number;
  capturedBy: string;
};

function BulkPhotosPage() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { dealerships, selectedDealershipId, setSelectedDealershipId, canSwitchDealerships } =
    useAccessibleDealerships();
  const [vin, setVin] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => {
    if (!selectedDealershipId) return;
    setLoading(true);
    void (async () => {
      const { data } = await supabase
        .from("photo_capture_sessions")
        .select("id, dealership_id, vehicle_id, vin, status, created_by, created_at, completed_at")
        .eq("dealership_id", selectedDealershipId)
        .eq("mode", "bulk")
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as Omit<Session, "photoCount" | "capturedBy">[];
      const sessionIds = rows.map((row) => row.id);
      const profileIds = [
        ...new Set(rows.map((row) => row.created_by).filter((id): id is string => Boolean(id))),
      ];
      const [{ data: items }, { data: profiles }] = await Promise.all([
        sessionIds.length
          ? supabase.from("bulk_photo_items").select("session_id").in("session_id", sessionIds)
          : Promise.resolve({ data: [] }),
        profileIds.length
          ? supabase.from("profiles").select("id, full_name, email").in("id", profileIds)
          : Promise.resolve({ data: [] }),
      ]);
      const count = new Map<string, number>();
      (items ?? []).forEach((item) =>
        count.set(item.session_id, (count.get(item.session_id) ?? 0) + 1),
      );
      const names = new Map(
        (profiles ?? []).map((person) => [person.id, person.full_name || person.email]),
      );
      setSessions(
        rows.map((row) => ({
          ...row,
          photoCount: count.get(row.id) ?? 0,
          capturedBy: row.created_by ? (names.get(row.created_by) ?? "Team member") : "Former user",
        })),
      );
      setLoading(false);
    })();
  }, [selectedDealershipId]);

  const normalizedVin = useMemo(
    () =>
      vin
        .trim()
        .toUpperCase()
        .replace(/[^A-HJ-NPR-Z0-9]/g, ""),
    [vin],
  );
  const createPackage = async () => {
    if (!user || !selectedDealershipId || normalizedVin.length !== 17) return;
    setCreating(true);
    try {
      const { data: vehicle } = await supabase
        .from("vehicles")
        .select("id")
        .eq("dealership_id", selectedDealershipId)
        .eq("vin", normalizedVin)
        .maybeSingle();
      const { data, error } = await supabase
        .from("photo_capture_sessions")
        .insert({
          dealership_id: selectedDealershipId,
          vehicle_id: vehicle?.id ?? null,
          vin: normalizedVin,
          mode: "bulk",
          created_by: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      navigate({ to: "/bulk-photos/$id", params: { id: data.id } });
    } catch (reason) {
      toast.error("Bulk package could not be created", {
        description: reason instanceof Error ? reason.message : "Try again.",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Fast intake"
        title="Bulk Photos"
        description="Capture raw originals now. Organize and prepare them in the office later."
      />
      <section className="ds-surface mb-6 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          {canSwitchDealerships && (
            <div>
              <label className="mb-1.5 block text-xs font-medium">Dealership</label>
              <ProductSelect
                value={selectedDealershipId ?? ""}
                onValueChange={setSelectedDealershipId}
                ariaLabel="Dealership"
                options={dealerships.map((item) => ({ value: item.id, label: item.name }))}
              />
            </div>
          )}
          <div>
            <label htmlFor="bulk-vin" className="mb-1.5 block text-xs font-medium">
              VIN
            </label>
            <div className="flex gap-2">
              <Input
                id="bulk-vin"
                value={vin}
                onChange={(event) => setVin(event.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={17}
                placeholder="17-character VIN"
                className="h-12 min-w-0 flex-1 font-mono tracking-wide"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-12 shrink-0"
                aria-label="Scan VIN"
                onClick={() => setScannerOpen(true)}
              >
                <ScanLine className="size-5" />
              </Button>
            </div>
          </div>
          <Button
            className="h-12"
            onClick={() => void createPackage()}
            disabled={creating || normalizedVin.length !== 17 || !selectedDealershipId}
          >
            <Camera className="size-4" /> {creating ? "Starting…" : "Start Bulk Photos"}
          </Button>
        </div>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <ScanLine className="size-4" /> Scan the windshield or enter the VIN manually. No full
          inventory form is required before capture.
        </p>
      </section>

      {scannerOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-background/80">
              <div className="ds-surface p-4 text-sm font-medium">Opening VIN scanner…</div>
            </div>
          }
        >
          <VinScannerModal
            onClose={() => setScannerOpen(false)}
            onDetected={(detectedVin) => {
              setVin(detectedVin);
              setScannerOpen(false);
            }}
          />
        </Suspense>
      )}

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Photo intake</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} packages</span>
      </div>
      {loading ? (
        <div className="ds-surface p-8 text-center text-sm text-muted-foreground">
          Loading Bulk Photos…
        </div>
      ) : sessions.length === 0 ? (
        <div className="ds-surface p-10 text-center">
          <PackageOpen className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-semibold">No bulk packages yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter a VIN above to start the first high-throughput photo set.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sessions.map((session) => (
            <article key={session.id} className="ds-surface p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm font-semibold tracking-wide">{session.vin}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Captured by {session.capturedBy}
                  </p>
                </div>
                <StatusBadge
                  tone={
                    session.status === "completed"
                      ? "success"
                      : session.status === "prepared"
                        ? "neutral"
                        : "info"
                  }
                >
                  {session.status === "completed"
                    ? "Ready"
                    : session.status === "prepared"
                      ? "Prepared"
                      : "In Progress"}
                </StatusBadge>
              </div>
              <div className="mt-4 flex items-center gap-5 border-t border-border pt-4 text-sm">
                <span className="font-semibold">{session.photoCount} photos</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {session.completed_at ? (
                    <CheckCircle2 className="size-4" />
                  ) : (
                    <Clock3 className="size-4" />
                  )}
                  {session.completed_at
                    ? new Date(session.completed_at).toLocaleString()
                    : "Capture active"}
                </span>
              </div>
              <Button
                asChild
                className="mt-4 w-full"
                variant={profile?.role === "staff" ? "outline" : "default"}
              >
                <Link to="/bulk-photos/$id" params={{ id: session.id }}>
                  {session.status === "in_progress" ? "Continue" : "Open"}
                </Link>
              </Button>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
