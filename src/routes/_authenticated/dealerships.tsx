import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

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
  const navigate = useNavigate();
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Dealership | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (!authLoading && profile && profile.role !== "owner") {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [profile, authLoading, navigate]);

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
    if (profile?.role === "owner") void load();
  }, [profile?.role]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this dealership? This cannot be undone.")) return;
    const { error } = await supabase.from("dealerships").delete().eq("id", id);
    if (error) return alert(error.message);
    void load();
  };

  if (profile?.role !== "owner") return null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dealerships</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage all dealership accounts</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Add Dealership
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
        ) : dealerships.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground text-center">No dealerships yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dealerships.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {d.logo_url ? (
                        <img src={d.logo_url} alt="" className="h-8 w-8 rounded object-cover bg-secondary" />
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
                    <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">
                      {d.subscription_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => { setEditing(d); setShowForm(true); }}
                      className="text-xs text-muted-foreground hover:text-foreground mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void handleDelete(d.id)}
                      className="text-xs text-destructive hover:text-destructive/80"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <DealershipForm
          dealership={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); void load(); }}
        />
      )}
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
        const { error: upErr } = await supabase.from("dealerships").update(payload).eq("id", dealership.id);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl">
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
            <input value={address} onChange={(e) => setAddress(e.target.value)} className="form-input" />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="form-input" />
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
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
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

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-card-foreground mb-1.5">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
