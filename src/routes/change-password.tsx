import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { AuthFrame, InlineLoading, PageSkeleton } from "@/components/product-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { completeTemporaryPasswordChange } from "@/lib/api/users.functions";

export const Route = createFileRoute("/change-password")({
  head: () => ({ meta: [{ title: "Secure your account — DealerShot" }] }),
  component: ChangePasswordPage,
});

function passwordError(password: string) {
  if (password.length < 12) return "Use at least 12 characters.";
  if (!/[A-Z]/.test(password)) return "Include an uppercase letter.";
  if (!/[a-z]/.test(password)) return "Include a lowercase letter.";
  if (!/[0-9]/.test(password)) return "Include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Include a symbol.";
  return null;
}

function ChangePasswordPage() {
  const navigate = useNavigate();
  const callComplete = useServerFn(completeTemporaryPasswordChange);
  const { session, profile, loading, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/login", replace: true });
    if (!loading && profile && !profile.password_change_required) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [loading, session, profile, navigate]);

  if (loading || !session || !profile) return <PageSkeleton cards={0} rows={3} />;

  const validation = passwordError(password);
  const matches = password === confirm;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (validation) return setError(validation);
    if (!matches) return setError("Passwords do not match.");
    setSubmitting(true);
    try {
      await callComplete({ data: { password } });
      // A full navigation reloads authorization state after Supabase may rotate
      // the session during the password update.
      window.location.assign("/dashboard");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password could not be changed.");
      setSubmitting(false);
    }
  };

  return (
    <AuthFrame
      title="Secure your account"
      description="Replace the temporary password before entering your dealership workspace."
      footer="Until this step is complete, DealerShot blocks all dealership data at the database boundary."
    >
      <div className="ds-surface p-5 sm:p-6">
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck aria-hidden className="size-4" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">One required security step</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Choose a private password you do not use elsewhere. Your administrator cannot view it.
            </p>
          </div>
        </div>

        <form onSubmit={submit} autoComplete="on" className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              12+ characters with uppercase, lowercase, number, and symbol.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="h-11"
            />
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <Button
            type="submit"
            disabled={submitting || !!validation || !matches}
            className="h-11 w-full"
          >
            {submitting ? (
              <InlineLoading label="Securing account…" />
            ) : (
              <>
                <KeyRound aria-hidden className="size-4" /> Save private password
              </>
            )}
          </Button>
          <Button type="button" variant="ghost" onClick={() => void signOut()} className="w-full">
            Sign out instead
          </Button>
        </form>
      </div>
    </AuthFrame>
  );
}
