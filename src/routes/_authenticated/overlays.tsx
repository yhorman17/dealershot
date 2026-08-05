import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/overlays")({
  head: () => ({ meta: [{ title: "Overlays — DealerShot" }] }),
  component: OverlaysPage,
});

const CATEGORIES = ["Header Banner", "Footer Banner", "Badge/Corner", "Other"] as const;

type Overlay = {
  id: string;
  name: string;
  category: string | null;
  image_url: string;
  dealership_id: string | null;
  created_at: string;
};

type Dealership = { id: string; name: string };

function OverlaysPage() {
  const { profile } = useAuth();
  const isOwner = profile?.role === "owner";
  const [overlays, setOverlays] = useState<Overlay[]>([]);
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
      setOverlays([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from("overlay_templates")
      .select("*")
      .eq("dealership_id", selectedDealershipId)
      .order("created_at", { ascending: false });
    setOverlays((data as Overlay[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [selectedDealershipId]);

  const handleDelete = async (o: Overlay) => {
    if (!confirm(`Delete overlay "${o.name}"?`)) return;
    try {
      const url = new URL(o.image_url);
      const idx = url.pathname.indexOf("/overlays/");
      if (idx !== -1) {
        const path = url.pathname.slice(idx + "/overlays/".length);
        await supabase.storage.from("overlays").remove([path]);
      }
    } catch {
      // ignore
    }
    await supabase.from("overlay_templates").delete().eq("id", o.id);
    void load();
  };

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overlays</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reusable banner images you can stamp on vehicle photos
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
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowForm(true)}
            disabled={!selectedDealershipId}
            className="rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            Add Overlay
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-16">Loading…</div>
      ) : overlays.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-16 rounded-xl border border-dashed border-border">
          No overlays yet. Upload a PNG banner to get started.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {overlays.map((o) => (
            <div key={o.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="aspect-[16/9] bg-[conic-gradient(at_top_left,_#1a1a2e,_#0f0f1a)] flex items-center justify-center overflow-hidden">
                <img
                  src={o.image_url}
                  alt={o.name}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              <div className="p-4">
                <h3 className="font-medium text-card-foreground text-sm truncate">{o.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{o.category || "—"}</p>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => void handleDelete(o)}
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
        <OverlayForm
          dealershipId={selectedDealershipId}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
    </main>
  );
}

function OverlayForm({
  dealershipId,
  onClose,
  onSaved,
}: {
  dealershipId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Please select a PNG image.");
      return;
    }
    setSaving(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${dealershipId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("overlays")
        .upload(path, file, { contentType: file.type || "image/png", upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("overlays").getPublicUrl(path);
      const { error: insErr } = await supabase.from("overlay_templates").insert({
        name: name.trim(),
        category,
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
        <h2 className="text-lg font-semibold text-card-foreground mb-1">Add Overlay</h2>
        <p className="text-xs text-muted-foreground mb-5">Upload a transparent PNG banner</p>
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
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="form-input"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              PNG image <span className="text-destructive">*</span>
            </label>
            <input
              type="file"
              accept="image/png,image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:text-secondary-foreground"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Transparent PNG recommended.</p>
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
