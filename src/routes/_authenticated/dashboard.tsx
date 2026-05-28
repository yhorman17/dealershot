import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard — DealerShot" }],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { user, profile, signOut } = useAuth();
  const displayName = profile?.full_name || user?.email || "there";
  const roleLabel = profile?.role
    ? profile.role.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">DealerShot</h1>
          <button
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-16">
        <div className="rounded-xl border border-border bg-card p-8">
          <p className="text-sm text-muted-foreground mb-2">Welcome</p>
          <h2 className="text-3xl font-semibold text-card-foreground tracking-tight mb-6">
            {displayName}
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Role</span>
            <span className="inline-flex items-center rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
              {roleLabel}
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
