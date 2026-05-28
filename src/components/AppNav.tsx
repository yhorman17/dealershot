import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";

type NavItem = { to: string; label: string };

export function AppNav() {
  const { profile, user, signOut } = useAuth();
  const isOwner = profile?.role === "owner";
  const [open, setOpen] = useState(false);

  const items: NavItem[] = [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/inventory", label: "Inventory" },
    { to: "/overlays", label: "Overlays" },
    { to: "/backdrops", label: "Backdrops" },
    { to: "/documents", label: "Documents" },
    ...(isOwner ? [{ to: "/dealerships", label: "Dealerships" }] : []),
  ];

  // Close drawer on Esc + lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <header className="border-b border-border bg-background sticky top-0 z-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Mobile: hamburger + wordmark */}
        <div className="flex items-center gap-3 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-secondary"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>
          <Link to="/dashboard" className="text-base font-semibold tracking-tight text-foreground">
            DealerShot
          </Link>
        </div>

        {/* Desktop: full nav */}
        <div className="hidden md:flex items-center gap-8">
          <Link to="/dashboard" className="text-lg font-semibold tracking-tight text-foreground">
            DealerShot
          </Link>
          <nav className="flex items-center gap-1">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to}>{i.label}</NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {profile?.full_name || user?.email}
          </span>
          <button
            onClick={() => void signOut()}
            className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-background border-r border-border shadow-2xl flex flex-col animate-in slide-in-from-left">
            <div className="h-14 px-5 flex items-center justify-between border-b border-border">
              <span className="text-lg font-semibold tracking-tight text-foreground">DealerShot</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">
              {items.map((i) => (
                <Link
                  key={i.to}
                  to={i.to}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-3 min-h-[44px] rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  activeProps={{ className: "block px-4 py-3 min-h-[44px] rounded-md text-sm text-foreground bg-secondary font-medium" }}
                >
                  {i.label}
                </Link>
              ))}
            </nav>
            <div className="border-t border-border p-4 space-y-3">
              <div className="px-1">
                <p className="text-sm text-foreground truncate">{profile?.full_name || user?.email}</p>
                {profile?.role && (
                  <span className="inline-flex mt-1 items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                    {profile.role}
                  </span>
                )}
              </div>
              <button
                onClick={() => { setOpen(false); void signOut(); }}
                className="w-full text-left px-4 py-3 min-h-[44px] rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                Sign out
              </button>
            </div>
          </aside>
        </div>
      )}
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
