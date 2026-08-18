import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Aperture, Eye, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, PageHeader } from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { MediaPreviewDialog, RenameMediaDialog } from "@/components/MediaAssetDialogs";
import { toast } from "sonner";
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

export const Route = createFileRoute("/_authenticated/backdrops")({
  validateSearch: (search: Record<string, unknown>) => ({
    dealership: typeof search.dealership === "string" ? search.dealership : undefined,
  }),
  head: () => ({ meta: [{ title: "Backdrops — DealerShot" }] }),
  component: BackdropsPage,
});

type Backdrop = {
  id: string;
  name: string;
  image_url: string;
  dealership_id: string;
  created_at: string;
};

function BackdropsPage() {
  const { dealership } = Route.useSearch();
  const { selectedDealershipId, loadingDealerships, requestedDealershipDenied } =
    useAccessibleDealerships(dealership);
  const [items, setItems] = useState<Backdrop[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Backdrop | null>(null);
  const [previewTarget, setPreviewTarget] = useState<Backdrop | null>(null);
  const [editTarget, setEditTarget] = useState<Backdrop | null>(null);

  const load = async () => {
    if (!selectedDealershipId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("backdrops")
      .select("*")
      .eq("dealership_id", selectedDealershipId)
      .order("created_at", { ascending: false });
    setItems((data as Backdrop[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [selectedDealershipId]);

  const handleDelete = async (b: Backdrop) => {
    try {
      const url = new URL(b.image_url);
      const idx = url.pathname.indexOf("/backdrops/");
      if (idx !== -1) {
        const path = url.pathname.slice(idx + "/backdrops/".length);
        await supabase.storage.from("backdrops").remove([path]);
      }
    } catch {
      /* ignore */
    }
    await supabase.from("backdrops").delete().eq("id", b.id);
    void load();
  };

  const handleRename = async (name: string) => {
    if (!editTarget || !selectedDealershipId) return;
    const { error } = await supabase
      .from("backdrops")
      .update({ name })
      .eq("id", editTarget.id)
      .eq("dealership_id", selectedDealershipId);
    if (error) throw error;
    toast.success("Backdrop renamed");
    await load();
  };

  if (requestedDealershipDenied) {
    return (
      <main className="ds-page-gutter">
        <ErrorState description="This backdrop link belongs to a store you cannot access." />
      </main>
    );
  }

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Photo resources"
        title="Backdrops"
        description="Manage approved showroom and lot backgrounds for processed vehicle photos."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setShowForm(true)} disabled={!selectedDealershipId}>
              <Plus className="size-4" />
              Add backdrop
            </Button>
          </div>
        }
      />

      {loading || loadingDealerships ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="ds-surface overflow-hidden" key={index}>
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="p-4">
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<Aperture className="size-5" />}
            title="No backdrops yet"
            description="Upload an approved background to use in the vehicle photo editor."
            action={
              <Button onClick={() => setShowForm(true)} disabled={!selectedDealershipId}>
                <Plus className="size-4" />
                Add backdrop
              </Button>
            }
          />
        </div>
      ) : (
        <div className="motion-content grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((b) => (
            <div key={b.id} className="motion-card ds-surface overflow-hidden">
              <div className="aspect-[16/9] bg-secondary overflow-hidden">
                <img
                  src={b.image_url}
                  alt={b.name}
                  className="w-full h-full object-contain bg-background"
                />
              </div>
              <div className="p-4">
                <h3 className="font-medium text-card-foreground text-sm truncate">{b.name}</h3>
                <div className="mt-3 flex flex-wrap justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreviewTarget(b)}
                  >
                    <Eye aria-hidden className="size-3.5" />
                    View
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditTarget(b)}>
                    <Pencil aria-hidden className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(b)}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && selectedDealershipId && (
        <BackdropForm
          dealershipId={selectedDealershipId}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      <MediaPreviewDialog
        asset={previewTarget}
        kind="backdrop"
        onClose={() => setPreviewTarget(null)}
      />
      <RenameMediaDialog
        asset={editTarget}
        kind="backdrop"
        onClose={() => setEditTarget(null)}
        onSave={handleRename}
      />
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backdrop?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” will be removed from the photo editor. Existing processed
              images are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep backdrop</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete backdrop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function BackdropForm({
  dealershipId,
  onClose,
  onSaved,
}: {
  dealershipId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Please select an image.");
      return;
    }
    setSaving(true);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${dealershipId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("backdrops")
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("backdrops").getPublicUrl(path);
      const { error: insErr } = await supabase.from("backdrops").insert({
        name: name.trim(),
        image_url: pub.publicUrl,
        dealership_id: dealershipId,
      });
      if (insErr) throw insErr;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="motion-overlay-static fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add backdrop"
        className="motion-panel-static w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-card-foreground mb-1">Add Backdrop</h2>
        <p className="text-xs text-muted-foreground mb-5">Upload a JPG or PNG background image</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Name <span className="text-destructive">*</span>
            </label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="form-input"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Image <span className="text-destructive">*</span>
            </label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:text-secondary-foreground"
            />
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "Uploading…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
