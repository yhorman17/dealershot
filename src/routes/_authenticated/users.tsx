import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { InviteUserModal } from "@/components/InviteUserModal";
import {
  deleteUserAccount,
  listUsersWithAuth,
  resendInvite,
} from "@/lib/api/users.functions";
import { relativeTime } from "@/lib/relative-time";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({ meta: [{ title: "Users — DealerShot" }] }),
  component: UsersPage,
});

type Dealership = { id: string; name: string; logo_url: string | null };
type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  dealership_id: string | null;
  status: string;
  created_at: string;
  last_sign_in_at: string | null;
};
type Invitation = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  dealership_id: string | null;
  invited_at: string;
  expires_at: string;
  status: string;
  token: string;
};

function UsersPage() {
  const { profile, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const callList = useServerFn(listUsersWithAuth);
  const callDelete = useServerFn(deleteUserAccount);
  const callResend = useServerFn(resendInvite);

  const [tab, setTab] = useState<"active" | "pending">("active");
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterDealership, setFilterDealership] = useState<string>("all");
  const [showInvite, setShowInvite] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  useEffect(() => {
    if (!authLoading && profile && profile.role !== "owner") {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [profile, authLoading, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, u, i] = await Promise.all([
      supabase.from("dealerships").select("id, name, logo_url").order("name"),
      callList(),
      supabase.from("user_invitations").select("*").order("invited_at", { ascending: false }),
    ]);
    setDealerships((d.data as Dealership[]) ?? []);
    setUsers((u as UserRow[]) ?? []);
    setInvites((i.data as Invitation[]) ?? []);
    setLoading(false);
  }, [callList]);

  useEffect(() => {
    if (profile?.role === "owner") void load();
  }, [profile?.role, load]);

  const dealershipById = useMemo(() => {
    const m = new Map<string, Dealership>();
    dealerships.forEach((d) => m.set(d.id, d));
    return m;
  }, [dealerships]);

  const filteredUsers = useMemo(() => {
    if (filterDealership === "all") return users;
    return users.filter((u) => u.dealership_id === filterDealership);
  }, [users, filterDealership]);

  const pendingInvites = useMemo(() => {
    const list = invites.filter((i) => i.status === "pending");
    if (filterDealership === "all") return list;
    return list.filter((i) => i.dealership_id === filterDealership);
  }, [invites, filterDealership]);

  if (profile?.role !== "owner") return null;

  const handleSendReset = async (email: string) => {
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    toast.success(`Password reset email sent to ${email}`);
  };

  const handleToggleActive = async (u: UserRow) => {
    const next = u.status === "deactivated" ? "active" : "deactivated";
    const { error } = await supabase.from("profiles").update({ status: next }).eq("id", u.id);
    if (error) return toast.error(error.message);
    toast.success(next === "deactivated" ? "User deactivated" : "User reactivated");
    void load();
  };

  const handleDelete = async (u: UserRow) => {
    try {
      await callDelete({ data: { user_id: u.id } });
      toast.success("User removed");
      setDeleteTarget(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove user");
    }
  };

  const handleResend = async (inv: Invitation) => {
    try {
      await callResend({ data: { invitation_id: inv.id, origin: window.location.origin } });
      toast.success("Invitation resent");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resend");
    }
  };

  const handleCopyLink = async (inv: Invitation) => {
    const url = `${window.location.origin}/accept-invite?token=${encodeURIComponent(inv.token)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied to clipboard");
    } catch {
      toast.error("Could not copy link");
    }
  };

  const handleRevoke = async (inv: Invitation) => {
    if (!confirm(`Revoke invitation for ${inv.email}?`)) return;
    const { error } = await supabase
      .from("user_invitations")
      .update({ status: "revoked" })
      .eq("id", inv.id);
    if (error) return toast.error(error.message);
    toast.success("Invitation revoked");
    void load();
  };

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage user accounts and invitations across all dealerships
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="rounded-md bg-primary px-4 py-2.5 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Invite user
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">Dealership</label>
          <select
            value={filterDealership}
            onChange={(e) => setFilterDealership(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="all">All dealerships</option>
            {dealerships.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div className="flex rounded-md border border-border bg-card p-1 self-start">
          <button
            onClick={() => setTab("active")}
            className={`px-3 py-1.5 text-sm rounded ${tab === "active" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Active users ({filteredUsers.length})
          </button>
          <button
            onClick={() => setTab("pending")}
            className={`px-3 py-1.5 text-sm rounded ${tab === "pending" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Pending invitations ({pendingInvites.length})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground text-center">Loading…</div>
      ) : tab === "active" ? (
        <ActiveUsersTab
          users={filteredUsers}
          dealershipById={dealershipById}
          currentUserId={user?.id ?? ""}
          onEdit={setEditTarget}
          onToggleActive={handleToggleActive}
          onSendReset={(u) => void handleSendReset(u.email)}
          onDelete={setDeleteTarget}
        />
      ) : (
        <PendingInvitesTab
          invites={pendingInvites}
          dealershipById={dealershipById}
          onResend={(i) => void handleResend(i)}
          onCopy={(i) => void handleCopyLink(i)}
          onRevoke={(i) => void handleRevoke(i)}
        />
      )}

      {showInvite && (
        <InviteUserModal
          defaultDealershipId={filterDealership !== "all" ? filterDealership : undefined}
          onClose={() => setShowInvite(false)}
          onInvited={() => void load()}
        />
      )}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          dealerships={dealerships}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); void load(); }}
          isSelf={editTarget.id === user?.id}
        />
      )}
      {deleteTarget && (
        <ConfirmRemove
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete(deleteTarget)}
        />
      )}
    </main>
  );
}

function ActiveUsersTab({
  users, dealershipById, currentUserId, onEdit, onToggleActive, onSendReset, onDelete,
}: {
  users: UserRow[];
  dealershipById: Map<string, Dealership>;
  currentUserId: string;
  onEdit: (u: UserRow) => void;
  onToggleActive: (u: UserRow) => void;
  onSendReset: (u: UserRow) => void;
  onDelete: (u: UserRow) => void;
}) {
  if (users.length === 0) {
    return <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground text-center">No users found.</div>;
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Dealership</th>
              <th className="px-4 py-3 font-medium">Last sign-in</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const d = u.dealership_id ? dealershipById.get(u.dealership_id) : null;
              const isSelf = u.id === currentUserId;
              return (
                <tr key={u.id} className="border-t border-border hover:bg-secondary/20">
                  <td className="px-4 py-3 text-card-foreground">
                    <div className="flex items-center gap-2">
                      <span>{u.full_name || "—"}</span>
                      {u.status === "deactivated" && (
                        <span className="text-[10px] uppercase tracking-wide rounded-full bg-destructive/15 text-destructive px-1.5 py-0.5">Deactivated</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {d ? (
                      <div className="flex items-center gap-2">
                        {d.logo_url ? (
                          <img src={d.logo_url} alt="" className="h-5 w-5 rounded object-cover bg-secondary" />
                        ) : null}
                        <span>{d.name}</span>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {u.last_sign_in_at ? relativeTime(u.last_sign_in_at) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowMenu
                      onEdit={() => onEdit(u)}
                      onToggleActive={() => onToggleActive(u)}
                      onSendReset={() => onSendReset(u)}
                      onDelete={() => onDelete(u)}
                      status={u.status}
                      disableDelete={isSelf}
                      disableToggle={isSelf}
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
        {users.map((u) => {
          const d = u.dealership_id ? dealershipById.get(u.dealership_id) : null;
          const isSelf = u.id === currentUserId;
          return (
            <div key={u.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-card-foreground truncate">{u.full_name || u.email}</p>
                  <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <RoleBadge role={u.role} />
                    {d && <span className="text-[10px] text-muted-foreground">{d.name}</span>}
                    {u.status === "deactivated" && (
                      <span className="text-[10px] uppercase tracking-wide rounded-full bg-destructive/15 text-destructive px-1.5 py-0.5">Deactivated</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Last sign-in: {u.last_sign_in_at ? relativeTime(u.last_sign_in_at) : "—"}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => onEdit(u)} className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground">Edit</button>
                <button
                  disabled={isSelf}
                  onClick={() => onToggleActive(u)}
                  className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground disabled:opacity-40"
                >
                  {u.status === "deactivated" ? "Reactivate" : "Deactivate"}
                </button>
                <button onClick={() => onSendReset(u)} className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground">Reset password</button>
                <button
                  disabled={isSelf}
                  onClick={() => onDelete(u)}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 min-h-[44px] text-xs font-medium text-destructive disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PendingInvitesTab({
  invites, dealershipById, onResend, onCopy, onRevoke,
}: {
  invites: Invitation[];
  dealershipById: Map<string, Dealership>;
  onResend: (i: Invitation) => void;
  onCopy: (i: Invitation) => void;
  onRevoke: (i: Invitation) => void;
}) {
  if (invites.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground text-center">
        No pending invitations. Click "Invite user" to add someone.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Dealership</th>
              <th className="px-4 py-3 font-medium">Invited</th>
              <th className="px-4 py-3 font-medium">Expires</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => {
              const d = i.dealership_id ? dealershipById.get(i.dealership_id) : null;
              return (
                <tr key={i.id} className="border-t border-border hover:bg-secondary/20">
                  <td className="px-4 py-3 text-card-foreground">{i.email}</td>
                  <td className="px-4 py-3 text-muted-foreground">{i.full_name}</td>
                  <td className="px-4 py-3"><RoleBadge role={i.role} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{d?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{relativeTime(i.invited_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{relativeTime(i.expires_at)}</td>
                  <td className="px-4 py-3 text-right text-xs space-x-3">
                    <button onClick={() => onResend(i)} className="text-muted-foreground hover:text-foreground">Resend</button>
                    <button onClick={() => onCopy(i)} className="text-muted-foreground hover:text-foreground">Copy link</button>
                    <button onClick={() => onRevoke(i)} className="text-destructive hover:text-destructive/80">Revoke</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="md:hidden divide-y divide-border">
        {invites.map((i) => {
          const d = i.dealership_id ? dealershipById.get(i.dealership_id) : null;
          return (
            <div key={i.id} className="p-4">
              <p className="font-medium text-card-foreground truncate">{i.email}</p>
              <p className="text-xs text-muted-foreground">{i.full_name}</p>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                <RoleBadge role={i.role} />
                {d && <span className="text-[10px] text-muted-foreground">{d.name}</span>}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Invited {relativeTime(i.invited_at)} · Expires {relativeTime(i.expires_at)}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button onClick={() => onResend(i)} className="rounded-md border border-border bg-secondary px-2 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground">Resend</button>
                <button onClick={() => onCopy(i)} className="rounded-md border border-border bg-secondary px-2 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground">Copy link</button>
                <button onClick={() => onRevoke(i)} className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-2 min-h-[44px] text-xs font-medium text-destructive">Revoke</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowMenu({
  onEdit, onToggleActive, onSendReset, onDelete, status, disableDelete, disableToggle,
}: {
  onEdit: () => void;
  onToggleActive: () => void;
  onSendReset: () => void;
  onDelete: () => void;
  status: string;
  disableDelete: boolean;
  disableToggle: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-3 text-xs">
      <button onClick={onEdit} className="text-muted-foreground hover:text-foreground">Edit</button>
      <button
        disabled={disableToggle}
        onClick={onToggleActive}
        className="text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        {status === "deactivated" ? "Reactivate" : "Deactivate"}
      </button>
      <button onClick={onSendReset} className="text-muted-foreground hover:text-foreground">Send reset</button>
      <button
        disabled={disableDelete}
        onClick={onDelete}
        className="text-destructive hover:text-destructive/80 disabled:opacity-40"
      >
        Remove
      </button>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const label = role === "owner" ? "Owner" : role === "dealer_admin" ? "Dealer Admin" : "Staff";
  const cls =
    role === "owner"
      ? "bg-primary/15 text-primary border-primary/30"
      : role === "dealer_admin"
      ? "bg-amber-400/15 text-amber-300 border-amber-400/30"
      : "bg-secondary text-secondary-foreground border-border";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function EditUserModal({
  user, dealerships, onClose, onSaved, isSelf,
}: {
  user: UserRow;
  dealerships: Dealership[];
  onClose: () => void;
  onSaved: () => void;
  isSelf: boolean;
}) {
  const [fullName, setFullName] = useState(user.full_name ?? "");
  const [role, setRole] = useState(user.role);
  const [dealershipId, setDealershipId] = useState(user.dealership_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const update: Record<string, unknown> = { full_name: fullName.trim() };
    if (!isSelf) {
      update.role = role;
      update.dealership_id = dealershipId || null;
    }
    const { error: upErr } = await supabase.from("profiles").update(update).eq("id", user.id);
    setSaving(false);
    if (upErr) return setError(upErr.message);
    toast.success("User updated");
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-card-foreground">Edit user</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Full name</label>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Email</label>
            <input value={user.email} disabled className="w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm text-muted-foreground" />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Role</label>
            <select
              value={role}
              disabled={isSelf}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
            >
              <option value="staff">Staff</option>
              <option value="dealer_admin">Dealer Admin</option>
              <option value="owner">Owner</option>
            </select>
            {isSelf && <p className="mt-1 text-[11px] text-muted-foreground">You can't change your own role.</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Dealership</label>
            <select
              value={dealershipId}
              disabled={isSelf}
              onChange={(e) => setDealershipId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
            >
              <option value="">—</option>
              {dealerships.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmRemove({
  user, onClose, onConfirm,
}: { user: UserRow; onClose: () => void; onConfirm: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-card-foreground mb-1">Remove user</h2>
        <p className="text-sm text-muted-foreground mb-4">
          This permanently deletes <span className="text-foreground font-medium">{user.email}</span> and revokes their access. This cannot be undone.
        </p>
        <p className="text-xs text-muted-foreground mb-2">Type <span className="font-mono text-foreground">REMOVE</span> to confirm.</p>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2 pt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          <button
            disabled={text !== "REMOVE"}
            onClick={onConfirm}
            className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            Remove user
          </button>
        </div>
      </div>
    </div>
  );
}
