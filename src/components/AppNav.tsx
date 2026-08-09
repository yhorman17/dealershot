import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

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
    ...(isOwner
      ? [
          { to: "/dealerships", label: "Dealerships" },
          { to: "/users", label: "Users" },
        ]
      : []),
    { to: "/export", label: "Export" },
  ];

  return (
    <header className="border-b border-border bg-background sticky top-0 z-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="Open navigation"
                className="motion-icon-button inline-flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-secondary"
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="4" y1="7" x2="20" y2="7" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="17" x2="20" y2="17" />
                </svg>
              </button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-72 max-w-[85vw] p-0 flex flex-col gap-0 bg-background"
            >
              <div className="h-14 px-5 flex items-center border-b border-border">
                <SheetTitle className="text-lg font-semibold tracking-tight text-foreground">
                  DealerShot
                </SheetTitle>
              </div>
              <nav className="flex-1 overflow-y-auto p-3">
                {items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className="motion-row block px-4 py-3 min-h-[44px] rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary"
                    activeProps={{
                      className:
                        "motion-row block px-4 py-3 min-h-[44px] rounded-md text-sm text-foreground bg-secondary font-medium",
                    }}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="border-t border-border p-4 space-y-3">
                <div className="px-1">
                  <p className="text-sm text-foreground truncate">
                    {profile?.full_name || user?.email}
                  </p>
                  {profile?.role && (
                    <span className="motion-status inline-flex mt-1 items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                      {profile.role}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    setOpen(false);
                    void signOut();
                  }}
                  className="motion-button w-full text-left px-4 py-3 min-h-[44px] rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  Sign out
                </button>
              </div>
            </SheetContent>
          </Sheet>
          <Link to="/dashboard" className="text-base font-semibold tracking-tight text-foreground">
            DealerShot
          </Link>
        </div>

        <div className="hidden md:flex items-center gap-8">
          <Link to="/dashboard" className="text-lg font-semibold tracking-tight text-foreground">
            DealerShot
          </Link>
          <nav className="flex items-center gap-1">
            {items.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {profile?.full_name || user?.email}
          </span>
          <button
            onClick={() => void signOut()}
            className="motion-button hidden md:inline text-sm text-muted-foreground hover:text-foreground"
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
      className="motion-row px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary"
      activeProps={{
        className: "motion-row px-3 py-1.5 rounded-md text-sm text-foreground bg-secondary",
      }}
    >
      {children}
    </Link>
  );
}
