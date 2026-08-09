import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, StatusBadge } from "@/components/product-ui";
import { Skeleton } from "@/components/ui/skeleton";
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

export const Route = createFileRoute("/_authenticated/dealerships")({
  head: () => ({ meta: [{ title: "Dealerships — DealerShot" }] }),
  component: DealershipsPage,
});

type Dealership = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  subscription_status: string;
  created_at: string;
};

function DealershipsPage() {
  const { profile, loading: authLoading } = useAuth();
  const isOwner = profile?.role === "owner";
  const canViewDealerships = isOwner || profile?.role === "dealer_admin";
  const navigate = useNavigate();
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Dealership | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Dealership | null>(null);

  useEffect(() => {
    if (!authLoading && profile && !canViewDealerships) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [profile, authLoading, navigate, canViewDealerships]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("dealerships")
      .select("*")
      .order("created_at", { ascending: false });
    setDealerships((data as Dealership[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    if (canViewDealerships) void load();
  }, [canViewDealerships]);

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("dealerships").delete().eq("id", id);
    if (error)
      return toast.error("Dealership could not be deleted", { description: error.message });
    toast.success("Dealership deleted");
    void load();
  };

  if (!canViewDealerships) return null;

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow={isOwner ? "Platform administration" : "Assigned access"}
        title="Dealerships"
        description={
          isOwner
            ? "Create and manage dealership tenant accounts, subscriptions, and contact details."
            : "Review every active dealership workspace assigned to your administrator account."
        }
        actions={
          isOwner ? (
            <Button
              onClick={() => {
                setEditing(null);
                setShowForm(true);
              }}
            >
              <Plus className="size-4" />
              Add dealership
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="ds-surface overflow-hidden" aria-busy="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b border-border p-4 last:border-0"
            >
              <Skeleton className="size-9" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : dealerships.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="No dealerships yet"
            description="Create the first dealership tenant before inviting staff or adding inventory."
            action={
              isOwner ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setShowForm(true);
                  }}
                >
                  <Plus className="size-4" />
                  Create dealership
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          {/* Mobile: card stack */}
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {dealerships.map((d) => (
              <div key={d.id} className="motion-card rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  {d.logo_url ? (
                    <img
                      src={d.logo_url}
                      alt=""
                      className="h-10 w-10 rounded object-cover bg-secondary"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded bg-secondary flex items-center justify-center text-sm text-muted-foreground">
                      {d.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-card-foreground truncate">{d.name}</p>
                    <StatusBadge tone={d.subscription_status === "active" ? "success" : "warning"}>
                      {d.subscription_status}
                    </StatusBadge>
                  </div>
                </div>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      Address
                    </dt>
                    <dd className="text-card-foreground text-right truncate">{d.address || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Phone</dt>
                    <dd className="text-card-foreground text-right">{d.phone || "—"}</dd>
                  </div>
                </dl>
                {isOwner && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => {
                        setEditing(d);
                        setShowForm(true);
                      }}
                      className="flex-1 rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteTarget(d)}
                      className="flex-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 min-h-[44px] text-xs font-medium text-destructive hover:bg-destructive/20"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="ds-surface hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Address</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  {isOwner && <th className="w-36 px-4 py-3 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {dealerships.map((d) => (
                  <tr key={d.id} className="motion-row border-t border-border">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {d.logo_url ? (
                          <img
                            src={d.logo_url}
                            alt=""
                            className="h-8 w-8 rounded object-cover bg-secondary"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded bg-secondary flex items-center justify-center text-xs text-muted-foreground">
                            {d.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="font-medium text-card-foreground">{d.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{d.address || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{d.phone || "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        tone={d.subscription_status === "active" ? "success" : "warning"}
                      >
                        {d.subscription_status}
                      </StatusBadge>
                    </td>
                    {isOwner && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => {
                            setEditing(d);
                            setShowForm(true);
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground mr-3"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(d)}
                          className="text-xs text-destructive hover:text-destructive/80"
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {isOwner && showForm && (
        <DealershipForm
          dealership={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this dealership?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” and its tenant relationships may be permanently removed. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep dealership</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete dealership
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function DealershipForm({
  dealership,
  onClose,
  onSaved,
}: {
  dealership: Dealership | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(dealership?.name || "");
  const [address, setAddress] = useState(dealership?.address || "");
  const [phone, setPhone] = useState(dealership?.phone || "");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUrl, setLogoUrl] = useState(dealership?.logo_url || "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let finalLogoUrl = logoUrl;
      if (logoFile) {
        const ext = logoFile.name.split(".").pop();
        const path = `${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("dealership-logos")
          .upload(path, logoFile, { upsert: false });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from("dealership-logos").getPublicUrl(path);
        finalLogoUrl = pub.publicUrl;
      }

      const payload = {
        name: name.trim(),
        address: address.trim() || null,
        phone: phone.trim() || null,
        logo_url: finalLogoUrl || null,
      };

      if (dealership) {
        const { error: upErr } = await supabase
          .from("dealerships")
          .update(payload)
          .eq("id", dealership.id);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabase.from("dealerships").insert(payload);
        if (insErr) throw insErr;
      }
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
        aria-label="Dealership details"
        className="motion-panel-static w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-card-foreground mb-1">
          {dealership ? "Edit Dealership" : "Add Dealership"}
        </h2>
        <p className="text-xs text-muted-foreground mb-5">Manage dealership information</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Name" required>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="form-input"
            />
          </Field>
          <Field label="Address">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="form-input"
            />
          </Field>
          <Field label="Phone">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="form-input"
            />
          </Field>
          <Field label="Logo">
            <div className="flex items-center gap-3">
              {logoUrl && !logoFile && (
                <img src={logoUrl} alt="" className="h-10 w-10 rounded object-cover bg-secondary" />
              )}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
                className="text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:text-secondary-foreground"
              />
            </div>
          </Field>
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
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : dealership ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-card-foreground mb-1.5">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
