import { useEffect, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { inviteUser } from "@/lib/api/users.functions";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductSelect } from "@/components/product-ui";

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
        setDealershipId((current) => current || list[0]?.id || "");
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>
            They'll receive an email with a link to create their password.
          </DialogDescription>
        </DialogHeader>
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
            <ProductSelect
              value={role}
              onValueChange={(nextRole) => setRole(nextRole as "dealer_admin" | "staff")}
              ariaLabel="Role"
              options={[
                { value: "staff", label: "Staff" },
                { value: "dealer_admin", label: "Dealer administrator" },
              ]}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-card-foreground mb-1.5">
              {role === "dealer_admin" ? "Primary dealership" : "Dealership"}
            </label>
            <ProductSelect
              value={dealershipId}
              onValueChange={setDealershipId}
              ariaLabel="Dealership"
              placeholder="Select dealership…"
              options={dealerships.map((dealership) => ({
                value: dealership.id,
                label: dealership.name,
              }))}
            />
            {role === "dealer_admin" && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                After they accept, use Edit user to assign additional dealerships.
              </p>
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
              disabled={submitting}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
