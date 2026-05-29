import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/accept-invite")({
  head: () => ({ meta: [{ title: "Accept invitation — DealerShot" }] }),
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string) || "",
  }),
  component: AcceptInvitePage,
});

type InvitationDetails = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  dealership_id: string | null;
  dealership_name: string | null;
  expires_at: string;
  status: string;
};

function isStrong(pw: string): { ok: boolean; msg: string | null } {
  if (pw.length < 8) return { ok: false, msg: "At least 8 characters" };
  if (!/[A-Za-z]/.test(pw)) return { ok: false, msg: "Must include a letter" };
  if (!/[0-9]/.test(pw)) return { ok: false, msg: "Must include a number" };
  return { ok: true, msg: null };
}

function AcceptInvitePage() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [emailHasAccount, setEmailHasAccount] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      if (!token) {
        setLoadError("Missing invitation token.");
        setLoading(false);
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      setIsSignedIn(!!sess.session);

      const { data, error } = await supabase.rpc("get_invitation_details", { _token: token });
      if (error) {
        setLoadError(error.message);
      } else {
        const row = (data as InvitationDetails[] | null)?.[0] ?? null;
        if (!row) {
          setLoadError("This invitation is invalid.");
        } else if (row.status !== "pending") {
          setLoadError("This invitation is no longer valid.");
        } else if (new Date(row.expires_at) < new Date()) {
          setLoadError("This invitation has expired.");
        } else {
          // Check whether the invitee email already has a pre-existing account
          const { data: exists } = await supabase.rpc("check_invitation_account_exists", { _token: token });
          if (exists === true) {
            setEmailHasAccount(true);
          } else {
            setDetails(row);
          }
        }
      }
      setLoading(false);
    };
    void run();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setIsSignedIn(!!s);
    });
    return () => subscription.unsubscribe();
  }, [token]);

  const pwCheck = isStrong(password);
  const matches = password === confirm;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!details) return;
    if (!pwCheck.ok) return setError(pwCheck.msg);
    if (!matches) return setError("Passwords do not match");
    setSubmitting(true);
    try {
      if (!isSignedIn) {
        setError("Your invitation session has expired. Please use the link from your email again.");
        setSubmitting(false);
        return;
      }
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;

      const { error: accErr } = await supabase.rpc("accept_invitation", { _token: token });
      if (accErr) throw accErr;

      toast.success("Welcome to DealerShot");
      navigate({ to: "/dashboard", replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <h1 className="text-center text-3xl font-semibold tracking-tight text-foreground mb-8">
          DealerShot
        </h1>
        <div className="rounded-xl border border-border bg-card p-8 shadow-xl">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading invitation…</p>
          ) : emailHasAccount ? (
            <>
              <h2 className="text-xl font-medium text-card-foreground mb-2">Account already exists</h2>
              <p className="text-sm text-muted-foreground">
                This email already has an account on DealerShot. Please sign in instead.
              </p>
              <div className="mt-6">
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Go to sign in
                </Link>
              </div>
            </>
          ) : loadError || !details ? (
            <>
              <h2 className="text-xl font-medium text-card-foreground mb-2">Invitation unavailable</h2>
              <p className="text-sm text-muted-foreground">
                {loadError ?? "This invitation has expired or is no longer valid. Please contact your dealership admin."}
              </p>
              <div className="mt-6">
                <Link to="/login" className="text-sm text-foreground hover:underline">Back to sign in</Link>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-xl font-medium text-card-foreground mb-1">Welcome to DealerShot</h2>
              <p className="text-sm text-muted-foreground mb-5">
                You've been invited to join {details.dealership_name ?? "DealerShot"}.
              </p>
              <div className="space-y-2 rounded-md bg-secondary/40 p-3 mb-5 text-sm">
                <Row label="Email" value={details.email} />
                <Row label="Name" value={details.full_name} />
                <Row label="Role" value={roleLabel(details.role)} />
                {details.dealership_name && <Row label="Dealership" value={details.dealership_name} />}
              </div>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-card-foreground mb-1.5">Set password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {password.length > 0 && !pwCheck.ok && (
                    <p className="mt-1 text-xs text-destructive">{pwCheck.msg}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-card-foreground mb-1.5">Confirm password</label>
                  <input
                    type="password"
                    required
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
                  {submitting ? "Accepting…" : "Accept invitation"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-card-foreground text-right">{value}</span>
    </div>
  );
}

function roleLabel(r: string) {
  if (r === "dealer_admin") return "Dealer Admin";
  if (r === "owner") return "Owner";
  return "Staff";
}
