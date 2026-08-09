import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CONDITIONS, STATUSES } from "@/lib/vehicle-options";
import { FileImage, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, ProductSelect } from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function pathFromDocumentUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/documents\/(.+)$/);
    return m ? decodeURIComponent(m[1].split("?")[0]) : null;
  } catch {
    return null;
  }
}

function DocumentThumb({ doc }: { doc: { id: string; image_url: string; name: string } }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; url: string } | { kind: "error"; msg: string }
  >({ kind: "loading" });

  const sign = async () => {
    setState({ kind: "loading" });
    const path = pathFromDocumentUrl(doc.image_url);
    if (!path) {
      const msg = "Could not parse document path";
      setState({ kind: "error", msg });
      toast.error(`Couldn't load "${doc.name}": ${msg}`);
      return;
    }
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      const msg = error?.message ?? "Could not generate signed URL";
      // eslint-disable-next-line no-console
      console.error("[documents] sign failed", path, error);
      setState({ kind: "error", msg });
      toast.error(`Couldn't load "${doc.name}": ${msg}`);
      return;
    }
    setState({ kind: "ready", url: data.signedUrl });
  };

  useEffect(() => {
    void sign();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.image_url]);

  if (state.kind === "loading") {
    return (
      <div className="motion-skeleton h-full w-full bg-secondary/60" aria-label="Loading preview" />
    );
  }
  if (state.kind === "error") {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-3 text-center bg-destructive/10 text-destructive">
        <span className="text-xs font-medium">Preview unavailable</span>
        <span className="text-[10px] opacity-80 break-words">{state.msg}</span>
        <button
          type="button"
          onClick={() => void sign()}
          className="text-[10px] underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <img
      src={state.url}
      alt={doc.name}
      className="max-w-full max-h-full object-contain"
      onError={() => {
        const msg = "Image failed to load";
        setState({ kind: "error", msg });
        toast.error(`Couldn't load "${doc.name}": ${msg}`);
      }}
    />
  );
}

export const Route = createFileRoute("/_authenticated/documents")({
  head: () => ({ meta: [{ title: "Documents — DealerShot" }] }),
  component: DocumentsPage,
});

type Dealership = { id: string; name: string };
type DocumentRow = {
  id: string;
  name: string;
  image_url: string;
  dealership_id: string;
  created_at: string;
};

function DocumentsPage() {
  const { profile } = useAuth();
  const isOwner = profile?.role === "owner";
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [selectedDealershipId, setSelectedDealershipId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [attachingDoc, setAttachingDoc] = useState<DocumentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null);

  useEffect(() => {
    if (isOwner) {
      void (async () => {
        const { data } = await supabase.from("dealerships").select("id, name").order("name");
        const list = (data as Dealership[]) || [];
        setDealerships(list);
        if (list.length > 0) setSelectedDealershipId((curr) => curr ?? list[0].id);
      })();
    } else if (profile?.dealership_id) {
      setSelectedDealershipId(profile.dealership_id);
    }
  }, [isOwner, profile?.dealership_id]);

  const load = async () => {
    if (!selectedDealershipId) {
      setDocuments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data: docs } = await supabase
      .from("documents")
      .select("*")
      .eq("dealership_id", selectedDealershipId)
      .order("created_at", { ascending: false });
    const list = (docs as DocumentRow[]) || [];
    setDocuments(list);
    if (list.length > 0) {
      const { data: links } = await supabase
        .from("vehicle_documents")
        .select("document_id")
        .in(
          "document_id",
          list.map((d) => d.id),
        );
      const tally: Record<string, number> = {};
      ((links as { document_id: string }[]) || []).forEach((r) => {
        tally[r.document_id] = (tally[r.document_id] || 0) + 1;
      });
      setCounts(tally);
    } else {
      setCounts({});
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [selectedDealershipId]);

  const handleDelete = async (d: DocumentRow) => {
    try {
      const url = new URL(d.image_url);
      const idx = url.pathname.indexOf("/documents/");
      if (idx !== -1) {
        const path = url.pathname.slice(idx + "/documents/".length);
        await supabase.storage.from("documents").remove([path]);
      }
    } catch {
      /* ignore */
    }
    await supabase.from("documents").delete().eq("id", d.id);
    void load();
  };

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Vehicle resources"
        title="Documents"
        description="Maintain reusable window stickers, disclosures, and supporting images, then attach them to inventory."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isOwner && (
              <ProductSelect
                value={selectedDealershipId || ""}
                onValueChange={(value) => setSelectedDealershipId(value || null)}
                ariaLabel="Dealership"
                placeholder="Select dealership"
                options={dealerships.map((dealership) => ({
                  value: dealership.id,
                  label: dealership.name,
                }))}
              />
            )}
            <Button onClick={() => setShowForm(true)} disabled={!selectedDealershipId}>
              <Plus className="size-4" />
              Add document
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="ds-surface overflow-hidden" key={index}>
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : documents.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<FileImage className="size-5" />}
            title="No documents yet"
            description="Upload a window sticker, disclosure, or other reusable vehicle image."
            action={
              <Button onClick={() => setShowForm(true)} disabled={!selectedDealershipId}>
                <Plus className="size-4" />
                Add document
              </Button>
            }
          />
        </div>
      ) : (
        <div className="motion-content grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {documents.map((d) => (
            <div key={d.id} className="motion-card ds-surface flex flex-col overflow-hidden">
              <div className="aspect-[16/9] bg-secondary flex items-center justify-center overflow-hidden">
                <DocumentThumb doc={d} />
              </div>

              <div className="p-4 flex-1 flex flex-col">
                <h3 className="font-medium text-card-foreground text-sm truncate">{d.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Used by {counts[d.id] || 0} {(counts[d.id] || 0) === 1 ? "vehicle" : "vehicles"}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setAttachingDoc(d)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Attach to Vehicles
                  </button>
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeleteTarget(d)}
                    className="text-xs text-destructive hover:text-destructive/80 ml-auto"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && selectedDealershipId && (
        <DocumentForm
          dealershipId={selectedDealershipId}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      {editing && (
        <RenameDocumentForm
          doc={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {attachingDoc && (
        <BulkAttachModal
          doc={attachingDoc}
          dealershipId={attachingDoc.dealership_id}
          onClose={() => setAttachingDoc(null)}
          onDone={() => {
            setAttachingDoc(null);
            void load();
          }}
        />
      )}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” will be removed from the library and detached from every
              vehicle. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep document</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function DocumentForm({
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
    if (!["image/png", "image/jpeg", "image/jpg"].includes(file.type)) {
      setError("Only PNG or JPG images are supported.");
      return;
    }
    setSaving(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${dealershipId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("documents").getPublicUrl(path);
      const { error: insErr } = await supabase.from("documents").insert({
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
    <Modal onClose={onClose} title="Add Document" subtitle="PNG or JPG only — no PDFs">
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
            Image (PNG / JPG) <span className="text-destructive">*</span>
          </label>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:text-secondary-foreground"
          />
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <ModalFooter onClose={onClose} saving={saving} label="Create" savingLabel="Uploading…" />
      </form>
    </Modal>
  );
}

function RenameDocumentForm({
  doc,
  onClose,
  onSaved,
}: {
  doc: DocumentRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(doc.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const { error: updErr } = await supabase
      .from("documents")
      .update({ name: name.trim() })
      .eq("id", doc.id);
    setSaving(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    onSaved();
  };

  return (
    <Modal onClose={onClose} title="Rename Document">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="form-input"
          />
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <ModalFooter onClose={onClose} saving={saving} label="Save" savingLabel="Saving…" />
      </form>
    </Modal>
  );
}

type VehicleLite = {
  id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  condition: string | null;
  status: string | null;
};

function BulkAttachModal({
  doc,
  dealershipId,
  onClose,
  onDone,
}: {
  doc: DocumentRow;
  dealershipId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [alreadyAttached, setAlreadyAttached] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [{ data: vs }, { data: links }] = await Promise.all([
        supabase
          .from("vehicles")
          .select("id, year, make, model, trim, condition, status")
          .eq("dealership_id", dealershipId)
          .order("created_at", { ascending: false }),
        supabase.from("vehicle_documents").select("vehicle_id").eq("document_id", doc.id),
      ]);
      setVehicles((vs as VehicleLite[]) || []);
      setAlreadyAttached(
        new Set(((links as { vehicle_id: string }[]) || []).map((l) => l.vehicle_id)),
      );
      setLoading(false);
    })();
  }, [dealershipId, doc.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (condition && v.condition !== condition) return false;
      if (status && v.status !== status) return false;
      if (q) {
        const hay =
          `${v.year || ""} ${v.make || ""} ${v.model || ""} ${v.trim || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [vehicles, search, condition, status]);

  const toggle = (id: string) => {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectAllFiltered = () => {
    setChecked((s) => {
      const n = new Set(s);
      filtered.forEach((v) => n.add(v.id));
      return n;
    });
  };

  const clearAll = () => setChecked(new Set());

  const handleConfirm = async () => {
    const targets = Array.from(checked).filter((id) => !alreadyAttached.has(id));
    if (targets.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const rows = targets.map((vehicle_id) => ({
      vehicle_id,
      document_id: doc.id,
      sort_order: 9999,
    }));
    const { error } = await supabase.from("vehicle_documents").insert(rows);
    setSaving(false);
    if (error) {
      toast.error("Documents could not be attached", { description: error.message });
      return;
    }
    onDone();
  };

  return (
    <Modal onClose={onClose} title={`Attach "${doc.name}" to Vehicles`} wide>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-3 gap-2">
          <input
            placeholder="Search make / model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="form-input"
          />
          <ProductSelect
            value={condition}
            onValueChange={setCondition}
            ariaLabel="Condition"
            emptyLabel="All conditions"
            options={CONDITIONS.map((item) => ({ value: item, label: item }))}
          />
          <ProductSelect
            value={status}
            onValueChange={setStatus}
            ariaLabel="Status"
            emptyLabel="All statuses"
            options={STATUSES.map((item) => ({ value: item, label: item }))}
          />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={selectAllFiltered}
            className="rounded border border-border bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-secondary/80"
          >
            Select All Filtered ({filtered.length})
          </button>
          <button
            onClick={clearAll}
            className="rounded border border-border bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-secondary/80"
          >
            Clear
          </button>
          <span className="ml-auto text-muted-foreground">{checked.size} selected</span>
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border divide-y divide-border">
          {loading ? (
            <div className="space-y-0" aria-busy="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 border-b border-border p-3 last:border-0"
                >
                  <Skeleton className="size-4" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">No vehicles match.</div>
          ) : (
            filtered.map((v) => {
              const isAttached = alreadyAttached.has(v.id);
              const isChecked = checked.has(v.id) || isAttached;
              return (
                <label
                  key={v.id}
                  className={`motion-row flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40 cursor-pointer ${isAttached ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isAttached}
                    onChange={() => toggle(v.id)}
                    className="accent-primary h-4 w-4"
                  />
                  <span className="text-sm text-foreground">
                    {v.year || "—"} {v.make || ""} {v.model || ""}{" "}
                    {v.trim && <span className="text-muted-foreground">{v.trim}</span>}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {isAttached ? "Already attached" : `${v.condition || "—"} · ${v.status || "—"}`}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={saving || checked.size === 0}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? "Attaching…" : `Attach to ${checked.size}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  children,
  onClose,
  title,
  subtitle,
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  subtitle?: string;
  wide?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "max-h-[90vh] max-w-3xl overflow-y-auto" : "max-w-lg"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={subtitle ? undefined : "sr-only"}>
            {subtitle ?? "Manage this DealerShot document."}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function ModalFooter({
  onClose,
  saving,
  label,
  savingLabel,
}: {
  onClose: () => void;
  saving: boolean;
  label: string;
  savingLabel: string;
}) {
  return (
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
        {saving ? savingLabel : label}
      </button>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}
