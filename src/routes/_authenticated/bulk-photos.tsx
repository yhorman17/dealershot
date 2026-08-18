import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Ban, Camera, CheckCircle2, Clock3, PackageOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, PageHeader, StatusBadge } from "@/components/product-ui";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { useCaptureMethods } from "@/hooks/use-capture-methods";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/bulk-photos")({
  head: () => ({ meta: [{ title: "Capture — DealerShot" }] }),
  component: BulkPhotosRoute,
});

function BulkPhotosRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname.startsWith("/bulk-photos/") ? <Outlet /> : <BulkPhotosPage />;
}

type Session = {
  id: string;
  vehicle_id: string | null;
  vin: string | null;
  status: "in_progress" | "completed" | "prepared" | "canceled";
  workflow_stage: "capture" | "review" | "processing" | "completed";
  created_at: string;
  completed_at: string | null;
  photoCount: number;
};

function BulkPhotosPage() {
  const { selectedDealership, selectedDealershipId } = useAccessibleDealerships();
  const { configuration, loading: loadingConfiguration } = useCaptureMethods(selectedDealershipId);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState<Session | null>(null);
  const [canceling, setCanceling] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!selectedDealershipId || !configuration.bulkEnabled) {
      setSessions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("photo_capture_sessions")
      .select("id, vehicle_id, vin, status, workflow_stage, created_at, completed_at")
      .eq("dealership_id", selectedDealershipId)
      .eq("mode", "bulk")
      .neq("status", "canceled")
      .order("created_at", { ascending: false })
      .limit(30);
    const rows = (data ?? []) as Omit<Session, "photoCount">[];
    const ids = rows.map((row) => row.id);
    const { data: items } = ids.length
      ? await supabase.from("bulk_photo_items").select("session_id").in("session_id", ids)
      : { data: [] };
    const counts = new Map<string, number>();
    for (const item of items ?? []) {
      counts.set(item.session_id, (counts.get(item.session_id) ?? 0) + 1);
    }
    setSessions(rows.map((row) => ({ ...row, photoCount: counts.get(row.id) ?? 0 })));
    setLoading(false);
  }, [configuration.bulkEnabled, selectedDealershipId]);

  useEffect(() => {
    let cancelled = false;
    void loadSessions().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  const cancelWorkflow = async () => {
    if (!cancelTarget || canceling) return;
    setCanceling(true);
    const { error } = await supabase.rpc("cancel_bulk_capture_workflow", {
      _session_id: cancelTarget.id,
    });
    if (error) {
      toast.error("Capture workflow could not be canceled", {
        description: error.message,
      });
      setCanceling(false);
      return;
    }
    setSessions((current) => current.filter((session) => session.id !== cancelTarget.id));
    setCancelTarget(null);
    setCanceling(false);
    toast.success("Capture workflow canceled", {
      description: "The vehicle and any uploaded photos were kept.",
    });
  };

  if (!loadingConfiguration && !configuration.bulkEnabled) {
    return (
      <main className="ds-page-gutter">
        <PageHeader
          eyebrow="Store photography"
          title="Bulk Capture is disabled"
          description="This store currently uses Guided Capture. A settings administrator can re-enable Bulk Capture."
        />
        <div className="ds-surface">
          <EmptyState
            icon={<Camera className="size-5" />}
            title="Capture method unavailable"
            description="Direct Bulk Capture links remain protected while this method is disabled."
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Fast vehicle photography"
        title="Bulk Capture"
        description="Add the vehicle once, take consecutive photos, review retakes, then queue optional background work."
        actions={
          <Button asChild className="min-h-11">
            <Link to="/vehicles/new" search={{ dealership: undefined }}>
              <Plus className="size-4" /> Add vehicle & start photos
            </Link>
          </Button>
        }
      />
      <section className="ds-surface mb-6 p-4 sm:p-5">
        <p className="text-sm font-semibold">
          Capturing for {selectedDealership?.name ?? "your active store"}
        </p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          New vehicles flow directly from VIN and details into the camera. For an existing vehicle,
          open its Media workspace and choose Start Bulk Capture.
        </p>
      </section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Recent capture workflows</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} sessions</span>
      </div>
      {loading ? (
        <div className="ds-surface p-8 text-center text-sm text-muted-foreground" aria-busy>
          Loading Bulk Capture…
        </div>
      ) : sessions.length === 0 ? (
        <div className="ds-surface p-10 text-center">
          <PackageOpen className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-semibold">No Bulk Capture sessions yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a vehicle to begin the first consecutive photo workflow.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sessions.map((session) => (
            <article key={session.id} className="ds-surface p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm font-semibold tracking-wide">
                    {session.vin ?? "Existing vehicle"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.photoCount} captured · {workflowLabel(session.workflow_stage)}
                  </p>
                </div>
                <StatusBadge tone={session.workflow_stage === "completed" ? "success" : "info"}>
                  {session.workflow_stage === "completed" ? "Complete" : "Active"}
                </StatusBadge>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                {session.completed_at ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <Clock3 className="size-4" />
                )}
                {session.completed_at
                  ? new Date(session.completed_at).toLocaleString()
                  : "Capture timer active"}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Button asChild className="min-h-11 w-full" variant="outline">
                  <Link to="/bulk-photos/$id" params={{ id: session.id }}>
                    {session.workflow_stage === "completed"
                      ? "Review session"
                      : "Continue workflow"}
                  </Link>
                </Button>
                {session.status === "in_progress" && (
                  <Button
                    className="min-h-11 w-full"
                    variant="ghost"
                    onClick={() => setCancelTarget(session)}
                  >
                    <Ban className="size-4" /> Cancel workflow
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(open) => !open && !canceling && setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this capture workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              The active timer will stop and this workflow will leave the active list. The vehicle
              and any photos already uploaded will be kept in Inventory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={canceling}>Keep capturing</AlertDialogCancel>
            <AlertDialogAction
              disabled={canceling}
              onClick={(event) => {
                event.preventDefault();
                void cancelWorkflow();
              }}
            >
              {canceling ? "Canceling…" : "Cancel workflow"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function workflowLabel(stage: Session["workflow_stage"]) {
  if (stage === "review") return "Review photos";
  if (stage === "processing") return "Select processing";
  if (stage === "completed") return "Workflow complete";
  return "Taking photos";
}
