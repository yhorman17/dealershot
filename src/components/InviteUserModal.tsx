import { useEffect, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { inviteUser } from "@/lib/api/users.functions";
import { toast } from "sonner";

type Dealership = { id: string; name: string };

export function InviteUserModal({
  defaultDealershipId,
  onClose,
  onInvited,
}: {
  defaultDealershipId?: string | null;
  onClose: () => void;
  onInvited?: () => void;
}) {
  const callInvite = useServerFn(inviteUser);
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"dealer_admin" | "staff">("staff");
  const [dealershipId, setDealershipId] = useState<string>(defaultDealershipId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase
      .from("dealerships")
      .select("id, name")
      .order("name")
      .then(({ data }) => {
        const list = (data as Dealership[]) ?? [];
        setDealerships(list);
        if (!dealershipId && list.length) setDealershipId(list[0].id);
      });
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!dealershipId) return setError("Select a dealership");
    setSubmitting(true);
    try {
      await callInvite({
        data: {
          email: email.trim().toLowerCase(),
          full_name: fullName.trim(),
          role,
          dealership_id: dealershipId,
          origin: window.location.origin,
        },
      });
      toast.success(`Invitation sent to ${email.trim().toLowerCase()}`);
      onInvited?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invitation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-card-foreground">Invite user</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-5">
          They'll receive an email with a link to create their password.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Full name
            </label>
            <input
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="form-input w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "dealer_admin" | "staff")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="staff">Staff</option>
              <option value="dealer_admin">Dealer Admin</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              Dealership
            </label>
            <select
              required
              value={dealershipId}
              onChange={(e) => setDealershipId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Select dealership…
              </option>
              {dealerships.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
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
              disabled={submitting}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
