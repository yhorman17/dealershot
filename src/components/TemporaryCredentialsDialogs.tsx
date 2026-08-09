import { useMemo, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Clipboard, Eye, EyeOff, KeyRound } from "lucide-react";
import { provisionUserWithTemporaryPassword } from "@/lib/api/users.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductSelect } from "@/components/product-ui";

export type TemporaryCredentials = {
  email: string;
  temporary_password: string;
  requires_password_change: true;
};

type Dealership = { id: string; name: string };

export function ProvisionUserDialog({
  dealerships,
  actorRole,
  defaultDealershipId,
  onClose,
  onCreated,
}: {
  dealerships: Dealership[];
  actorRole: "owner" | "dealer_admin";
  defaultDealershipId?: string;
  onClose: () => void;
  onCreated: (credentials: TemporaryCredentials) => void;
}) {
  const callProvision = useServerFn(provisionUserWithTemporaryPassword);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"dealer_admin" | "staff">("staff");
  const [dealershipIds, setDealershipIds] = useState<string[]>(
    defaultDealershipId ? [defaultDealershipId] : dealerships[0] ? [dealerships[0].id] : [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await callProvision({
        data: {
          email,
          full_name: fullName,
          role,
          dealership_ids: dealershipIds,
          idempotency_key: idempotencyKey,
        },
      });
      if (!result.credentials) {
        throw new Error(
          result.status === "complete"
            ? "This request already completed. Its one-time password is no longer available. Reset credentials if needed."
            : "This request cannot be repeated until its operation is reconciled.",
        );
      }
      onCreated(result.credentials as TemporaryCredentials);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  const primaryId = dealershipIds[0] ?? "";
  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create login now</DialogTitle>
          <DialogDescription>
            Generate a one-time temporary password. The user must replace it before accessing
            dealership data.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} autoComplete="off" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="provision-email">Work email</Label>
              <Input
                id="provision-email"
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="provision-name">Full name</Label>
              <Input
                id="provision-name"
                autoComplete="off"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <ProductSelect
                value={role}
                onValueChange={(value) => {
                  const next = value as "dealer_admin" | "staff";
                  setRole(next);
                  if (next === "staff") setDealershipIds((ids) => ids.slice(0, 1));
                }}
                ariaLabel="Role"
                options={[
                  { value: "staff", label: "Staff" },
                  ...(actorRole === "owner"
                    ? [{ value: "dealer_admin", label: "Dealer administrator" }]
                    : []),
                ]}
              />
            </div>
            <div className="space-y-2">
              <Label>Primary dealership</Label>
              <ProductSelect
                value={primaryId}
                onValueChange={(value) =>
                  setDealershipIds((ids) => [value, ...ids.filter((id) => id !== value)])
                }
                ariaLabel="Primary dealership"
                placeholder="Select dealership…"
                options={dealerships.map((dealership) => ({
                  value: dealership.id,
                  label: dealership.name,
                }))}
              />
            </div>
          </div>
          {role === "dealer_admin" && actorRole === "owner" && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-medium text-foreground">
                Additional dealership access
              </legend>
              <div className="mt-1 max-h-36 space-y-1 overflow-y-auto">
                {dealerships
                  .filter((dealership) => dealership.id !== primaryId)
                  .map((dealership) => (
                    <label
                      key={dealership.id}
                      className="flex min-h-10 items-center gap-3 rounded px-2 text-sm hover:bg-secondary/60"
                    >
                      <input
                        type="checkbox"
                        checked={dealershipIds.includes(dealership.id)}
                        onChange={(event) =>
                          setDealershipIds((ids) =>
                            event.target.checked
                              ? [...ids, dealership.id]
                              : ids.filter((id) => id !== dealership.id),
                          )
                        }
                        className="size-4 accent-primary"
                      />
                      {dealership.name}
                    </label>
                  ))}
              </div>
            </fieldset>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || dealershipIds.length === 0}>
              <KeyRound aria-hidden className="size-4" />
              {submitting ? "Creating…" : "Create login"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TemporaryCredentialsDialog({
  credentials,
  onClose,
}: {
  credentials: TemporaryCredentials;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyText = useMemo(
    () =>
      `DealerShot login\nEmail: ${credentials.email}\nTemporary password: ${credentials.temporary_password}\nSign in and change this password immediately.`,
    [credentials],
  );

  const copy = async () => {
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Copy these credentials now</DialogTitle>
          <DialogDescription>
            This temporary password is shown once and is not stored by DealerShot. Closing this
            window permanently removes it from the page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
            Share through a trusted channel. The user cannot access dealership data until they
            choose a private password.
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-sm">
              {credentials.email}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Temporary password</Label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1 rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-sm tracking-wide">
                {revealed ? credentials.temporary_password : "••••••••••••••••••••"}
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setRevealed((value) => !value)}
                aria-label={revealed ? "Hide password" : "Reveal password"}
              >
                {revealed ? (
                  <EyeOff aria-hidden className="size-4" />
                ) : (
                  <Eye aria-hidden className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={copy}>
            {copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <Clipboard aria-hidden className="size-4" />
            )}
            {copied ? "Copied" : "Copy credentials"}
          </Button>
          <Button type="button" onClick={onClose}>
            I saved them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
