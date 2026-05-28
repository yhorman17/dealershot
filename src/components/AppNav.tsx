import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

export function AppNav() {
  const { profile, user, signOut } = useAuth();
  const isOwner = profile?.role === "owner";

  return (
    <header className="border-b border-border bg-background sticky top-0 z-20">
      <div className="mx-auto max-w-7xl px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link to="/dashboard" className="text-lg font-semibold tracking-tight text-foreground">
            DealerShot
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/dashboard">Dashboard</NavLink>
            <NavLink to="/inventory">Inventory</NavLink>
            <NavLink to="/overlays">Overlays</NavLink>
            {isOwner && <NavLink to="/dealerships">Dealerships</NavLink>}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {profile?.full_name || user?.email}
          </span>
          <button
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      activeProps={{ className: "px-3 py-1.5 rounded-md text-sm text-foreground bg-secondary" }}
    >
      {children}
    </Link>
  );
}
