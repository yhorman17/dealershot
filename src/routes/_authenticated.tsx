import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AppNav } from "@/components/AppNav";
import { ImpersonationProvider } from "@/hooks/use-impersonation";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "@/components/product-ui";

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
    return <PageSkeleton cards={3} rows={4} />;
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-7 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-card-foreground">
            Access could not be verified
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {authorizationError ?? "Your account authorization is unavailable."}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Button type="button" onClick={retryAuthorization}>
              Retry
            </Button>
            <Button type="button" variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ImpersonationProvider>
      <ImpersonationBanner />
      <AppNav>
        <Outlet />
      </AppNav>
    </ImpersonationProvider>
  );
}
