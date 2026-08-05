import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AppNav } from "@/components/AppNav";
import { ImpersonationProvider } from "@/hooks/use-impersonation";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { session, profile, loading, authorizationError, retryAuthorization, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !session) {
      navigate({ to: "/login", replace: true });
    }
  }, [session, loading, navigate]);

  if (loading || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-card-foreground">
            Access could not be verified
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {authorizationError ?? "Your account authorization is unavailable."}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={retryAuthorization}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ImpersonationProvider>
      <div className="min-h-screen bg-background">
        <ImpersonationBanner />
        <AppNav />
        <Outlet />
      </div>
    </ImpersonationProvider>
  );
}
