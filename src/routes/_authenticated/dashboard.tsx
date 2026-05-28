import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — DealerShot" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const { user, profile } = useAuth();
  const displayName = profile?.full_name || user?.email || "there";
  const roleLabel = profile?.role
    ? profile.role.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";

  return (
    <main className="mx-auto max-w-7xl px-6 py-12">
      <div className="rounded-xl border border-border bg-card p-8 mb-6">
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
      <div className="grid sm:grid-cols-2 gap-4">
        <Link to="/inventory" className="rounded-xl border border-border bg-card p-6 hover:border-primary/60 transition-colors">
          <h3 className="font-medium text-card-foreground">Inventory</h3>
          <p className="text-sm text-muted-foreground mt-1">Manage your vehicles</p>
        </Link>
        {profile?.role === "owner" && (
          <Link to="/dealerships" className="rounded-xl border border-border bg-card p-6 hover:border-primary/60 transition-colors">
            <h3 className="font-medium text-card-foreground">Dealerships</h3>
            <p className="text-sm text-muted-foreground mt-1">Manage dealership accounts</p>
          </Link>
        )}
      </div>
    </main>
  );
}
