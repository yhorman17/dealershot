import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useImpersonation } from "@/hooks/use-impersonation";
import { relativeTime } from "@/lib/relative-time";
import { InviteUserModal } from "@/components/InviteUserModal";

type Dealership = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  status: string;
  subscription_status: string;
  created_at: string;
};
type Vehicle = {
  id: string;
  dealership_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  created_at: string;
};
type Photo = { id: string; vehicle_id: string; created_at: string };
type Profile = {
  id: string;
  full_name: string | null;
  email: string;
  role: string;
  dealership_id: string | null;
  created_at: string;
};

type ActivityEvent = {
  id: string;
  type: "vehicle" | "photo" | "user" | "dealership";
  description: string;
  dealershipName: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  trial: "bg-amber-400/15 text-amber-300 border-amber-400/30",
  suspended: "bg-red-500/15 text-red-400 border-red-500/30",
};

export function OwnerDashboard() {
  const { user } = useAuth();
  const { start: startImpersonation } = useImpersonation();
  const [loading, setLoading] = useState(true);
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Dealership | null>(null);
  const [showSubs, setShowSubs] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Dealership | null>(null);
  const [impersonateTarget, setImpersonateTarget] = useState<Dealership | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, v, p, pr] = await Promise.all([
      supabase.from("dealerships").select("*").order("created_at", { ascending: false }),
      supabase
        .from("vehicles")
        .select("id, dealership_id, year, make, model, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("photos")
        .select("id, vehicle_id, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("profiles")
        .select("id, full_name, email, role, dealership_id, created_at")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    setDealerships((d.data as Dealership[]) || []);
    setVehicles((v.data as Vehicle[]) || []);
    setPhotos((p.data as Photo[]) || []);
    setProfiles((pr.data as Profile[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dealershipById = useMemo(() => {
    const m = new Map<string, Dealership>();
    dealerships.forEach((d) => m.set(d.id, d));
    return m;
  }, [dealerships]);
  const vehicleById = useMemo(() => {
    const m = new Map<string, Vehicle>();
    vehicles.forEach((v) => m.set(v.id, v));
    return m;
  }, [vehicles]);

  const totalDealerships = dealerships.length;
  const totalUsers = profiles.filter((p) => p.id !== user?.id).length;
  const totalVehicles = vehicles.length;
  const totalPhotos = photos.length;

  // Per-dealership counts
  const stats = useMemo(() => {
    const map = new Map<string, { users: number; vehicles: number; photos: number }>();
    dealerships.forEach((d) => map.set(d.id, { users: 0, vehicles: 0, photos: 0 }));
    profiles.forEach((p) => {
      if (p.dealership_id && map.has(p.dealership_id)) map.get(p.dealership_id)!.users++;
    });
    vehicles.forEach((v) => {
      if (map.has(v.dealership_id)) map.get(v.dealership_id)!.vehicles++;
    });
    photos.forEach((ph) => {
      const veh = vehicleById.get(ph.vehicle_id);
      if (veh && map.has(veh.dealership_id)) map.get(veh.dealership_id)!.photos++;
    });
    return map;
  }, [dealerships, profiles, vehicles, photos, vehicleById]);

  // Activity feed
  const events = useMemo<ActivityEvent[]>(() => {
    const e: ActivityEvent[] = [];
    vehicles.slice(0, 30).forEach((v) => {
      const dn = dealershipById.get(v.dealership_id)?.name ?? null;
      const label = [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
      e.push({
        id: `v-${v.id}`,
        type: "vehicle",
        description: `New vehicle added: ${label}`,
        dealershipName: dn,
        created_at: v.created_at,
      });
    });
    photos.slice(0, 30).forEach((ph) => {
      const veh = vehicleById.get(ph.vehicle_id);
      const dn = veh ? (dealershipById.get(veh.dealership_id)?.name ?? null) : null;
      const label = veh
        ? [veh.year, veh.make, veh.model].filter(Boolean).join(" ") || "vehicle"
        : "vehicle";
      e.push({
        id: `p-${ph.id}`,
        type: "photo",
        description: `New photo uploaded for ${label}`,
        dealershipName: dn,
        created_at: ph.created_at,
      });
    });
    profiles.slice(0, 30).forEach((pr) => {
      if (pr.id === user?.id) return;
      const dn = pr.dealership_id ? (dealershipById.get(pr.dealership_id)?.name ?? null) : null;
      const name = pr.full_name || pr.email;
      e.push({
        id: `u-${pr.id}`,
        type: "user",
        description: `New user signed up: ${name}`,
        dealershipName: dn,
        created_at: pr.created_at,
      });
    });
    dealerships.slice(0, 20).forEach((d) => {
      e.push({
        id: `d-${d.id}`,
        type: "dealership",
        description: `New dealership created: ${d.name}`,
        dealershipName: d.name,
        created_at: d.created_at,
      });
    });
    return e.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 20);
  }, [vehicles, photos, profiles, dealerships, dealershipById, vehicleById, user?.id]);

  const handleToggleStatus = async (d: Dealership) => {
    const newStatus = d.status === "suspended" ? "active" : "suspended";
    if (
      newStatus === "suspended" &&
      !confirm(`Suspend ${d.name}? Users from this dealership will be unable to sign in.`)
    )
      return;
    const { error } = await supabase
      .from("dealerships")
      .update({ status: newStatus })
      .eq("id", d.id);
    if (error) return alert(error.message);
    void load();
  };

  const handleImpersonate = async (d: Dealership) => {
    await startImpersonation({ id: d.id, name: d.name });
    setImpersonateTarget(null);
  };

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
          Owner Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Command center for all dealerships</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
        <Kpi label="Dealerships" value={totalDealerships} loading={loading} />
        <Kpi label="Users" value={totalUsers} loading={loading} />
        <Kpi label="Vehicles" value={totalVehicles} loading={loading} />
        <Kpi label="Photos" value={totalPhotos} loading={loading} />
      </div>

      {/* Activity Feed */}
      <div className="rounded-xl border border-border bg-card mb-8">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-card-foreground">Recent activity</h2>
        </div>
        <div className="max-h-96 overflow-y-auto divide-y divide-border">
          {loading ? (
            <div className="px-5 py-8 text-sm text-muted-foreground text-center">Loading…</div>
          ) : events.length === 0 ? (
            <div className="px-5 py-8 text-sm text-muted-foreground text-center">
              No activity yet.
            </div>
          ) : (
            events.map((e) => <EventRow key={e.id} event={e} />)
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mb-4">
        <button
          onClick={() => {
            setEditing(null);
            setShowCreate(true);
          }}
          className="rounded-md bg-primary px-4 py-2.5 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Create new dealership
        </button>
        <button
          onClick={() => setShowSubs(true)}
          className="rounded-md border border-border bg-secondary px-4 py-2.5 min-h-[44px] text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
        >
          Manage subscriptions
        </button>
        <button
          onClick={() => setShowInvite(true)}
          className="rounded-md border border-border bg-secondary px-4 py-2.5 min-h-[44px] text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
        >
          Invite user
        </button>
      </div>

      {/* Breakdown */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-card-foreground">All dealerships</h2>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
        ) : dealerships.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground text-center">No dealerships yet.</div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Dealership</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium text-right">Users</th>
                    <th className="px-4 py-3 font-medium text-right">Vehicles</th>
                    <th className="px-4 py-3 font-medium text-right">Photos</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dealerships.map((d) => {
                    const s = stats.get(d.id) ?? { users: 0, vehicles: 0, photos: 0 };
                    return (
                      <tr key={d.id} className="border-t border-border hover:bg-secondary/20">
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
                        <td className="px-4 py-3">
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-card-foreground">{s.users}</td>
                        <td className="px-4 py-3 text-right text-card-foreground">{s.vehicles}</td>
                        <td className="px-4 py-3 text-right text-card-foreground">{s.photos}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {new Date(d.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <RowActions
                            d={d}
                            onEdit={() => {
                              setEditing(d);
                              setShowCreate(true);
                            }}
                            onToggle={() => void handleToggleStatus(d)}
                            onImpersonate={() => setImpersonateTarget(d)}
                            onDelete={() => setDeleteTarget(d)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border">
              {dealerships.map((d) => {
                const s = stats.get(d.id) ?? { users: 0, vehicles: 0, photos: 0 };
                return (
                  <div key={d.id} className="p-4">
                    <div className="flex items-start gap-3">
                      {d.logo_url ? (
                        <img
                          src={d.logo_url}
                          alt=""
                          className="h-10 w-10 rounded object-cover bg-secondary shrink-0"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded bg-secondary flex items-center justify-center text-sm text-muted-foreground shrink-0">
                          {d.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-card-foreground truncate">{d.name}</p>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                          <StatusBadge status={d.status} />
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(d.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <Stat label="Users" value={s.users} />
                      <Stat label="Vehicles" value={s.vehicles} />
                      <Stat label="Photos" value={s.photos} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => {
                          setEditing(d);
                          setShowCreate(true);
                        }}
                        className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void handleToggleStatus(d)}
                        className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
                      >
                        {d.status === "suspended" ? "Reactivate" : "Suspend"}
                      </button>
                      <button
                        onClick={() => setImpersonateTarget(d)}
                        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 min-h-[44px] text-xs font-medium text-amber-300 hover:bg-amber-500/20"
                      >
                        Impersonate
                      </button>
                      <button
                        onClick={() => setDeleteTarget(d)}
                        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 min-h-[44px] text-xs font-medium text-destructive hover:bg-destructive/20"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <DealershipModal
          dealership={editing}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
      {showSubs && <SubsModal onClose={() => setShowSubs(false)} />}
      {showInvite && (
        <InviteUserModal onClose={() => setShowInvite(false)} onInvited={() => void load()} />
      )}
      {deleteTarget && (
        <DeleteModal
          dealership={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void load();
          }}
        />
      )}
      {impersonateTarget && (
        <ImpersonateModal
          dealership={impersonateTarget}
          onClose={() => setImpersonateTarget(null)}
          onConfirm={() => void handleImpersonate(impersonateTarget)}
        />
      )}
    </main>
  );
}

function Kpi({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl sm:text-3xl font-semibold text-card-foreground tabular-nums">
        {loading ? "—" : value.toLocaleString()}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-secondary/40 py-2">
      <p className="text-base font-semibold text-card-foreground tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.active;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

const EVENT_ICONS: Record<ActivityEvent["type"], string> = {
  vehicle: "🚗",
  photo: "📷",
  user: "👤",
  dealership: "🏢",
};

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <div className="px-5 py-3 flex items-start gap-3">
      <span className="text-base shrink-0 mt-0.5" aria-hidden>
        {EVENT_ICONS[event.type]}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-card-foreground truncate">{event.description}</p>
        <div className="mt-0.5 flex items-center gap-2 flex-wrap">
          {event.dealershipName && (
            <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
              {event.dealershipName}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {relativeTime(event.created_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

function RowActions({
  d,
  onEdit,
  onToggle,
  onImpersonate,
  onDelete,
}: {
  d: Dealership;
  onEdit: () => void;
  onToggle: () => void;
  onImpersonate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-2 text-xs">
      <button onClick={onEdit} className="text-muted-foreground hover:text-foreground">
        Edit
      </button>
      <span className="text-border">·</span>
      <button onClick={onToggle} className="text-muted-foreground hover:text-foreground">
        {d.status === "suspended" ? "Reactivate" : "Suspend"}
      </button>
      <span className="text-border">·</span>
      <button onClick={onImpersonate} className="text-amber-400 hover:text-amber-300">
        Impersonate
      </button>
      <span className="text-border">·</span>
      <button onClick={onDelete} className="text-destructive hover:text-destructive/80">
        Delete
      </button>
    </div>
  );
}

function DealershipModal({
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
  const [status, setStatus] = useState<string>(dealership?.status || "active");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUrl, setLogoUrl] = useState(dealership?.logo_url || "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let finalLogo = logoUrl;
      if (logoFile) {
        const ext = logoFile.name.split(".").pop();
        const path = `${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("dealership-logos")
          .upload(path, logoFile);
        if (upErr) throw upErr;
        finalLogo = supabase.storage.from("dealership-logos").getPublicUrl(path).data.publicUrl;
      }
      const payload = {
        name: name.trim(),
        address: address.trim() || null,
        phone: phone.trim() || null,
        logo_url: finalLogo || null,
        status,
      };
      if (dealership) {
        const { error: e1 } = await supabase
          .from("dealerships")
          .update(payload)
          .eq("id", dealership.id);
        if (e1) throw e1;
      } else {
        const { error: e1 } = await supabase.from("dealerships").insert(payload);
        if (e1) throw e1;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={dealership ? "Edit dealership" : "Create new dealership"}>
      <form onSubmit={submit} className="space-y-4">
        <FieldLabel label="Name" required>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="form-input"
          />
        </FieldLabel>
        <FieldLabel label="Initial status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="form-input">
            <option value="active">Active</option>
            <option value="trial">Trial</option>
            {dealership && <option value="suspended">Suspended</option>}
          </select>
        </FieldLabel>
        <FieldLabel label="Address">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="form-input"
          />
        </FieldLabel>
        <FieldLabel label="Phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className="form-input" />
        </FieldLabel>
        <FieldLabel label="Logo">
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
        </FieldLabel>
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
    </Modal>
  );
}

function SubsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="Manage subscriptions">
      <p className="text-sm text-muted-foreground">
        Subscription management coming soon when billing is connected.
      </p>
      <div className="flex justify-end pt-4">
        <button
          onClick={onClose}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}

function DeleteModal({
  dealership,
  onClose,
  onDeleted,
}: {
  dealership: Dealership;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canDelete = typed.trim() === dealership.name;

  const submit = async () => {
    if (!canDelete) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.from("dealerships").delete().eq("id", dealership.id);
      if (error) throw error;
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Delete dealership">
      <p className="text-sm text-foreground">
        This will permanently delete <strong>{dealership.name}</strong> and ALL of its vehicles,
        photos, overlays, documents, backdrops, and users.
      </p>
      <p className="text-sm text-muted-foreground mt-2">Type the dealership name to confirm:</p>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="form-input mt-2"
        placeholder={dealership.name}
      />
      {err && (
        <div className="mt-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={!canDelete || busy}
          className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
      </div>
    </Modal>
  );
}

function ImpersonateModal({
  dealership,
  onClose,
  onConfirm,
}: {
  dealership: Dealership;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={onClose} title="Impersonate dealership">
      <p className="text-sm text-foreground">
        You will view the app as a Dealer Admin of <strong>{dealership.name}</strong>. All actions
        you take will be logged. Continue?
      </p>
      <div className="flex justify-end gap-2 pt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950 hover:bg-amber-400"
        >
          Start impersonating
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-semibold text-card-foreground">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FieldLabel({
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
