import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { InviteUserModal } from "@/components/InviteUserModal";
import {
  ProvisionUserDialog,
  TemporaryCredentialsDialog,
  type TemporaryCredentials,
} from "@/components/TemporaryCredentialsDialogs";
import {
  createInvitationAcceptanceLink,
  listUsersWithAuth,
  listUserInvitations,
  resetTemporaryPassword,
  resendInvite,
  revokeInvite,
  setUserActivation,
  updateUserAccount,
} from "@/lib/api/users.functions";
import { relativeTime } from "@/lib/relative-time";
import { toast } from "sonner";
import { Plus, Users } from "lucide-react";
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
  dealership_ids: string[];
  status: string;
  created_at: string;
  last_sign_in_at: string | null;
  password_change_required: boolean;
  access_role: "store_manager" | "photographer" | "inventory_media" | "accounting" | null;
  payout_eligible: boolean;
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
};

function UsersPage() {
  const { profile, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const callList = useServerFn(listUsersWithAuth);
  const callListInvitations = useServerFn(listUserInvitations);
  const callCreateInvitationLink = useServerFn(createInvitationAcceptanceLink);
  const callResetTemporaryPassword = useServerFn(resetTemporaryPassword);
  const callResend = useServerFn(resendInvite);
  const callRevoke = useServerFn(revokeInvite);
  const callSetActivation = useServerFn(setUserActivation);

  const [tab, setTab] = useState<"active" | "pending">("active");
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterDealership, setFilterDealership] = useState<string>("all");
  const [showInvite, setShowInvite] = useState(false);
  const [showProvision, setShowProvision] = useState(false);
  const [temporaryCredentials, setTemporaryCredentials] = useState<TemporaryCredentials | null>(
    null,
  );
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);

  useEffect(() => {
    if (!authLoading && profile && profile.role === "staff") {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [profile, authLoading, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, u, i] = await Promise.all([
      supabase.from("dealerships").select("id, name, logo_url").order("name"),
      callList(),
      callListInvitations(),
    ]);
    setDealerships((d.data as Dealership[]) ?? []);
    setUsers((u as UserRow[]) ?? []);
    setInvites((i as Invitation[]) ?? []);
    setLoading(false);
  }, [callList, callListInvitations]);

  useEffect(() => {
    if (profile?.role === "owner" || profile?.role === "dealer_admin") void load();
  }, [profile?.role, load]);

  const dealershipById = useMemo(() => {
    const m = new Map<string, Dealership>();
    dealerships.forEach((d) => m.set(d.id, d));
    return m;
  }, [dealerships]);

  const filteredUsers = useMemo(() => {
    if (filterDealership === "all") return users;
    return users.filter((u) => u.dealership_ids.includes(filterDealership));
  }, [users, filterDealership]);

  const pendingInvites = useMemo(() => {
    const list = invites.filter((i) => i.status === "pending");
    if (filterDealership === "all") return list;
    return list.filter((i) => i.dealership_id === filterDealership);
  }, [invites, filterDealership]);

  if (profile?.role !== "owner" && profile?.role !== "dealer_admin") return null;

  const handleSendReset = async (target: UserRow) => {
    try {
      const result = await callResetTemporaryPassword({
        data: { user_id: target.id, idempotency_key: crypto.randomUUID() },
      });
      if (!result.credentials) throw new Error("The one-time password is unavailable.");
      setTemporaryCredentials(result.credentials as TemporaryCredentials);
      toast.success(`Temporary credentials created for ${target.email}`);
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password could not be reset");
    }
  };

  const handleToggleActive = async (u: UserRow) => {
    const next = u.status === "deactivated" ? "active" : "deactivated";
    try {
      await callSetActivation({ data: { user_id: u.id, status: next } });
      toast.success(next === "deactivated" ? "User deactivated" : "User reactivated");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update user");
    }
  };

  const handleResend = async (inv: Invitation) => {
    try {
      await callResend({ data: { invitation_id: inv.id } });
      toast.success("Invitation resent");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resend");
    }
  };

  const handleCopyLink = async (inv: Invitation) => {
    try {
      const { url } = await callCreateInvitationLink({ data: { invitation_id: inv.id } });
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied to clipboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy link");
    }
  };

  const handleRevoke = async (inv: Invitation) => {
    try {
      await callRevoke({ data: { invitation_id: inv.id } });
      toast.success("Invitation revoked");
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invitation could not be revoked");
    }
  };

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Access administration"
        title="Users & invitations"
        description="Manage scoped dealership access, invitations, temporary credentials, and activation."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowInvite(true)}>
              Send invitation
            </Button>
            <Button onClick={() => setShowProvision(true)}>
              <Plus className="size-4" /> Create login now
            </Button>
          </div>
        }
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            Dealership
          </label>
          <ProductSelect
            value={filterDealership}
            onValueChange={setFilterDealership}
            ariaLabel="Filter by dealership"
            options={[
              { value: "all", label: "All dealerships" },
              ...dealerships.map((dealership) => ({
                value: dealership.id,
                label: dealership.name,
              })),
            ]}
          />
        </div>
        <div className="flex rounded-md border border-border bg-card p-1 self-start">
          <button
            onClick={() => setTab("active")}
            className={`motion-tab px-3 py-1.5 text-sm rounded ${tab === "active" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Active users ({filteredUsers.length})
          </button>
          <button
            onClick={() => setTab("pending")}
            className={`motion-tab px-3 py-1.5 text-sm rounded ${tab === "pending" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Pending invitations ({pendingInvites.length})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="ds-surface overflow-hidden" aria-busy="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-b border-border p-4 last:border-0"
            >
              <Skeleton className="size-9" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : tab === "active" ? (
        <ActiveUsersTab
          users={filteredUsers}
          dealershipById={dealershipById}
          currentUserId={user?.id ?? ""}
          onEdit={setEditTarget}
          onToggleActive={handleToggleActive}
          onSendReset={(u) => void handleSendReset(u)}
        />
      ) : (
        <PendingInvitesTab
          invites={pendingInvites}
          dealershipById={dealershipById}
          onResend={(i) => void handleResend(i)}
          onCopy={(i) => void handleCopyLink(i)}
          onRevoke={setRevokeTarget}
        />
      )}

      {showInvite && (
        <InviteUserModal
          defaultDealershipId={filterDealership !== "all" ? filterDealership : undefined}
          onClose={() => setShowInvite(false)}
          onInvited={() => void load()}
        />
      )}
      {showProvision && (
        <ProvisionUserDialog
          dealerships={dealerships}
          actorRole={profile.role as "owner" | "dealer_admin"}
          defaultDealershipId={filterDealership !== "all" ? filterDealership : undefined}
          onClose={() => setShowProvision(false)}
          onCreated={(credentials) => {
            setShowProvision(false);
            setTemporaryCredentials(credentials);
            void load();
          }}
        />
      )}
      {temporaryCredentials && (
        <TemporaryCredentialsDialog
          credentials={temporaryCredentials}
          onClose={() => setTemporaryCredentials(null)}
        />
      )}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          dealerships={dealerships}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void load();
          }}
          isSelf={editTarget.id === user?.id}
        />
      )}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.email} will no longer be able to use this invitation link. You can send
              a new invitation later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep invitation</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (revokeTarget) void handleRevoke(revokeTarget);
                setRevokeTarget(null);
              }}
            >
              Revoke invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function ActiveUsersTab({
  users,
  dealershipById,
  currentUserId,
  onEdit,
  onToggleActive,
  onSendReset,
}: {
  users: UserRow[];
  dealershipById: Map<string, Dealership>;
  currentUserId: string;
  onEdit: (u: UserRow) => void;
  onToggleActive: (u: UserRow) => void;
  onSendReset: (u: UserRow) => void;
}) {
  if (users.length === 0) {
    return (
      <div className="ds-surface">
        <EmptyState
          compact
          icon={<Users className="size-5" />}
          title="No users found"
          description="No active users match the selected dealership filter."
        />
      </div>
    );
  }

  return (
    <div className="motion-content rounded-xl border border-border bg-card overflow-hidden">
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
              const additionalDealershipCount = Math.max(0, u.dealership_ids.length - 1);
              const isSelf = u.id === currentUserId;
              return (
                <tr key={u.id} className="motion-row border-t border-border hover:bg-secondary/20">
                  <td className="px-4 py-3 text-card-foreground">
                    <div className="flex items-center gap-2">
                      <span>{u.full_name || "—"}</span>
                      {u.status === "deactivated" && (
                        <span className="text-[10px] uppercase tracking-wide rounded-full bg-destructive/15 text-destructive px-1.5 py-0.5">
                          Deactivated
                        </span>
                      )}
                      {u.password_change_required && (
                        <span className="text-[10px] uppercase tracking-wide rounded-full border border-warning/30 bg-warning/10 text-warning-foreground px-1.5 py-0.5">
                          Password change required
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {d ? (
                      <div className="flex items-center gap-2">
                        {d.logo_url ? (
                          <img
                            src={d.logo_url}
                            alt=""
                            className="h-5 w-5 rounded object-cover bg-secondary"
                          />
                        ) : null}
                        <span>{d.name}</span>
                        {additionalDealershipCount > 0 && (
                          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
                            +{additionalDealershipCount}
                          </span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {u.last_sign_in_at ? relativeTime(u.last_sign_in_at) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowMenu
                      onEdit={() => onEdit(u)}
                      onToggleActive={() => onToggleActive(u)}
                      onSendReset={() => onSendReset(u)}
                      status={u.status}
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
          const additionalDealershipCount = Math.max(0, u.dealership_ids.length - 1);
          const isSelf = u.id === currentUserId;
          return (
            <div key={u.id} className="motion-row p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-card-foreground truncate">
                    {u.full_name || u.email}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <RoleBadge role={u.role} />
                    {d && <span className="text-[10px] text-muted-foreground">{d.name}</span>}
                    {additionalDealershipCount > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        +{additionalDealershipCount} more
                      </span>
                    )}
                    {u.status === "deactivated" && (
                      <span className="motion-status text-[10px] uppercase tracking-wide rounded-full bg-destructive/15 text-destructive px-1.5 py-0.5">
                        Deactivated
                      </span>
                    )}
                    {u.password_change_required && (
                      <span className="motion-status text-[10px] uppercase tracking-wide rounded-full border border-warning/30 bg-warning/10 text-warning-foreground px-1.5 py-0.5">
                        Password change required
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Last sign-in: {u.last_sign_in_at ? relativeTime(u.last_sign_in_at) : "—"}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={() => onEdit(u)}
                  className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground"
                >
                  Edit
                </button>
                <button
                  disabled={isSelf}
                  onClick={() => onToggleActive(u)}
                  className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground disabled:opacity-40"
                >
                  {u.status === "deactivated" ? "Reactivate" : "Deactivate"}
                </button>
                <button
                  onClick={() => onSendReset(u)}
                  className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground"
                >
                  Reset password
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
  invites,
  dealershipById,
  onResend,
  onCopy,
  onRevoke,
}: {
  invites: Invitation[];
  dealershipById: Map<string, Dealership>;
  onResend: (i: Invitation) => void;
  onCopy: (i: Invitation) => void;
  onRevoke: (i: Invitation) => void;
}) {
  if (invites.length === 0) {
    return (
      <div className="motion-empty rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground text-center">
        No pending invitations. Click "Invite user" to add someone.
      </div>
    );
  }

  return (
    <div className="motion-content rounded-xl border border-border bg-card overflow-hidden">
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
                <tr key={i.id} className="motion-row border-t border-border hover:bg-secondary/20">
                  <td className="px-4 py-3 text-card-foreground">{i.email}</td>
                  <td className="px-4 py-3 text-muted-foreground">{i.full_name}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={i.role} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{d?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {relativeTime(i.invited_at)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {relativeTime(i.expires_at)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs space-x-3">
                    <button
                      onClick={() => onResend(i)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Resend
                    </button>
                    <button
                      onClick={() => onCopy(i)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Copy link
                    </button>
                    <button
                      onClick={() => onRevoke(i)}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Revoke
                    </button>
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
                <button
                  onClick={() => onResend(i)}
                  className="rounded-md border border-border bg-secondary px-2 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground"
                >
                  Resend
                </button>
                <button
                  onClick={() => onCopy(i)}
                  className="rounded-md border border-border bg-secondary px-2 py-2 min-h-[44px] text-xs font-medium text-secondary-foreground"
                >
                  Copy link
                </button>
                <button
                  onClick={() => onRevoke(i)}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-2 min-h-[44px] text-xs font-medium text-destructive"
                >
                  Revoke
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowMenu({
  onEdit,
  onToggleActive,
  onSendReset,
  status,
  disableToggle,
}: {
  onEdit: () => void;
  onToggleActive: () => void;
  onSendReset: () => void;
  status: string;
  disableToggle: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-3 text-xs">
      <button onClick={onEdit} className="text-muted-foreground hover:text-foreground">
        Edit
      </button>
      <button
        disabled={disableToggle}
        onClick={onToggleActive}
        className="text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        {status === "deactivated" ? "Reactivate" : "Deactivate"}
      </button>
      <button onClick={onSendReset} className="text-muted-foreground hover:text-foreground">
        Send reset
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
        ? "border-warning/35 bg-warning/15 text-warning-foreground"
        : "bg-secondary text-secondary-foreground border-border";
  return (
    <span
      className={`motion-status inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function EditUserModal({
  user,
  dealerships,
  onClose,
  onSaved,
  isSelf,
}: {
  user: UserRow;
  dealerships: Dealership[];
  onClose: () => void;
  onSaved: () => void;
  isSelf: boolean;
}) {
  const callUpdateUser = useServerFn(updateUserAccount);
  const [fullName, setFullName] = useState(user.full_name ?? "");
  const [role, setRole] = useState(user.role);
  const [accessRole, setAccessRole] = useState(user.access_role ?? "photographer");
  const [dealershipIds, setDealershipIds] = useState<string[]>(
    user.dealership_ids.length > 0
      ? user.dealership_ids
      : user.dealership_id
        ? [user.dealership_id]
        : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (isSelf) {
        const { error: updateError } = await supabase
          .from("profiles")
          .update({ full_name: fullName.trim() })
          .eq("id", user.id);
        if (updateError) throw updateError;
      } else {
        await callUpdateUser({
          data: {
            user_id: user.id,
            full_name: fullName.trim(),
            role: user.role === "owner" ? undefined : (role as "dealer_admin" | "staff"),
            dealership_ids: user.role === "owner" ? [] : dealershipIds,
            access_role: role === "staff" ? accessRole : undefined,
          },
        });
      }
      toast.success("User updated");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="motion-overlay-static fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit user"
        className="motion-panel-static w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-card-foreground">Edit user</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Full name
            </label>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          {role === "staff" && user.role !== "owner" && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-card-foreground">
                Operational access
              </label>
              <ProductSelect
                value={accessRole}
                disabled={isSelf}
                onValueChange={(value) =>
                  setAccessRole(
                    value as "store_manager" | "photographer" | "inventory_media" | "accounting",
                  )
                }
                ariaLabel="Operational access"
                options={[
                  { value: "photographer", label: "Photographer" },
                  { value: "inventory_media", label: "Inventory / media staff" },
                  { value: "store_manager", label: "Store manager" },
                  { value: "accounting", label: "Accounting / reporting" },
                ]}
              />
              <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                Controls store-level capture, inventory, document, media, or payout access. Platform
                and dealer administrator roles remain separate.
              </p>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Email</label>
            <input
              value={user.email}
              disabled
              className="w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm text-muted-foreground"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Role</label>
            <ProductSelect
              value={role}
              disabled={isSelf || user.role === "owner"}
              onValueChange={(nextRole) => {
                setRole(nextRole);
                if (nextRole === "staff" && dealershipIds.length > 1) {
                  setDealershipIds([dealershipIds[0]]);
                }
              }}
              ariaLabel="Role"
              options={[
                { value: "staff", label: "Staff" },
                { value: "dealer_admin", label: "Dealer administrator" },
                ...(user.role === "owner" ? [{ value: "owner", label: "Owner" }] : []),
              ]}
            />
            {(isSelf || user.role === "owner") && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {isSelf ? "You can't change your own role." : "Owner roles cannot be changed here."}
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Primary dealership
            </label>
            <ProductSelect
              value={dealershipIds[0] ?? ""}
              disabled={isSelf || user.role === "owner"}
              onValueChange={(value) =>
                setDealershipIds((current) =>
                  role === "dealer_admin"
                    ? [value, ...current.filter((id) => id !== value)]
                    : value
                      ? [value]
                      : [],
                )
              }
              ariaLabel="Dealership"
              emptyLabel="—"
              options={dealerships.map((dealership) => ({
                value: dealership.id,
                label: dealership.name,
              }))}
            />
            {role === "dealer_admin" && user.role !== "owner" && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-card-foreground">
                  Additional dealership access
                </p>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
                  {dealerships
                    .filter((dealership) => dealership.id !== dealershipIds[0])
                    .map((dealership) => {
                      const selected = dealershipIds.includes(dealership.id);
                      return (
                        <label
                          key={dealership.id}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-secondary/60"
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={isSelf}
                            onChange={(event) =>
                              setDealershipIds((current) =>
                                event.target.checked
                                  ? [...current, dealership.id]
                                  : current.filter((id) => id !== dealership.id),
                              )
                            }
                            className="size-4 accent-primary"
                          />
                          <span>{dealership.name}</span>
                        </label>
                      );
                    })}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  This administrator can switch between every selected dealership.
                </p>
              </div>
            )}
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
              disabled={saving || (user.role !== "owner" && dealershipIds.length === 0)}
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
