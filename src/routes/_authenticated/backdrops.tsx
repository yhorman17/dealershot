import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/backdrops")({
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

type Dealership = { id: string; name: string };

function BackdropsPage() {
  const { profile } = useAuth();
  const isOwner = profile?.role === "owner";
  const [items, setItems] = useState<Backdrop[]>([]);
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [selectedDealershipId, setSelectedDealershipId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (isOwner) {
      void (async () => {
        const { data } = await supabase.from("dealerships").select("id, name").order("name");
        const list = (data as Dealership[]) || [];
        setDealerships(list);
        if (list.length > 0 && !selectedDealershipId) setSelectedDealershipId(list[0].id);
      })();
    } else if (profile?.dealership_id) {
      setSelectedDealershipId(profile.dealership_id);
    }
  }, [isOwner, profile?.dealership_id]);

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

  useEffect(() => { void load(); }, [selectedDealershipId]);

  const handleDelete = async (b: Backdrop) => {
    if (!confirm(`Delete backdrop "${b.name}"?`)) return;
    try {
      const url = new URL(b.image_url);
      const idx = url.pathname.indexOf("/backdrops/");
      if (idx !== -1) {
        const path = url.pathname.slice(idx + "/backdrops/".length);
        await supabase.storage.from("backdrops").remove([path]);
      }
    } catch { /* ignore */ }
    await supabase.from("backdrops").delete().eq("id", b.id);
    void load();
  };

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Backdrops</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Background images for composited vehicle photos
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 w-full sm:w-auto">
          {isOwner && (
            <select
              value={selectedDealershipId || ""}
              onChange={(e) => setSelectedDealershipId(e.target.value || null)}
              className="form-input"
            >
              {dealerships.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowForm(true)}
            disabled={!selectedDealershipId}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            Add Backdrop
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-16">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-16 rounded-xl border border-dashed border-border">
          No backdrops yet. Upload a background image to get started.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((b) => (
            <div key={b.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="aspect-[16/9] bg-secondary overflow-hidden">
                <img src={b.image_url} alt={b.name} className="w-full h-full object-cover" />
              </div>
              <div className="p-4">
                <h3 className="font-medium text-card-foreground text-sm truncate">{b.name}</h3>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => void handleDelete(b)}
                    className="text-xs text-destructive hover:text-destructive/80"
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
        <BackdropForm
          dealershipId={selectedDealershipId}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); void load(); }}
        />
      )}
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
    if (!file) { setError("Please select an image."); return; }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-card-foreground mb-1">Add Backdrop</h2>
        <p className="text-xs text-muted-foreground mb-5">Upload a JPG or PNG background image</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Name <span className="text-destructive">*</span>
            </label>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="form-input" />
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
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
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
