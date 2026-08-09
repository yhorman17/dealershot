import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AuthFrame, PageSkeleton } from "@/components/product-ui";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Set new password — DealerShot" }] }),
  component: ResetPasswordPage,
});

function isStrong(pw: string): { ok: boolean; msg: string | null } {
  if (pw.length < 12) return { ok: false, msg: "Use at least 12 characters" };
  if (!/[A-Z]/.test(pw)) return { ok: false, msg: "Include an uppercase letter" };
  if (!/[a-z]/.test(pw)) return { ok: false, msg: "Include a lowercase letter" };
  if (!/[0-9]/.test(pw)) return { ok: false, msg: "Include a number" };
  if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, msg: "Include a symbol" };
  return { ok: true, msg: null };
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [validSession, setValidSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Supabase recovery links set the session via URL fragment automatically.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setValidSession(true);
        setReady(true);
      }
    });
    // Fallback: check existing session
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setValidSession(true);
      setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const pwCheck = isStrong(password);
  const matches = password === confirm;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!pwCheck.ok) return setError(pwCheck.msg);
    if (!matches) return setError("Passwords do not match");
    setSubmitting(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updErr) return setError(updErr.message);
    setPassword("");
    setConfirm("");
    toast.success("Password updated");
    navigate({ to: "/dashboard", replace: true });
  };

  if (!ready) {
    return <PageSkeleton cards={0} rows={3} />;
  }

  return (
    <AuthFrame
      title="Set a new password"
      description="Choose a strong password to secure your DealerShot account."
    >
      <div className="ds-surface p-5 sm:p-6">
        {!validSession ? (
          <>
            <p className="text-sm text-destructive">
              This reset link is invalid or has expired. Request a new one from the sign-in page.
            </p>
            <div className="mt-6">
              <Link to="/login" className="text-sm text-foreground hover:underline">
                Back to sign in
              </Link>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-card-foreground mb-1.5">
                New password
              </label>
              <input
                type="password"
                name="new-password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {password.length > 0 && !pwCheck.ok && (
                <p className="mt-1 text-xs text-destructive">{pwCheck.msg}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-card-foreground mb-1.5">
                Confirm password
              </label>
              <input
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {confirm.length > 0 && !matches && (
                <p className="mt-1 text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
            {error && (
              <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !pwCheck.ok || !matches}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}
