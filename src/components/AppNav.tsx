import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Aperture,
  BarChart3,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileImage,
  FileOutput,
  Images,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageSearch,
  Camera,
  PanelLeftClose,
  Plus,
  ScanLine,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { isStoreSwitchLocked } from "@/lib/active-store";
import { useCaptureMethods } from "@/hooks/use-capture-methods";
import { BackgroundProcessingStatus } from "@/components/BackgroundProcessingStatus";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard };
export function AppNav({ children }: { children: ReactNode }) {
  const { profile, user, signOut } = useAuth();
  const {
    dealerships,
    selectedDealership,
    selectedDealershipId,
    setSelectedDealershipId,
    loadingDealerships,
    dealershipError,
    canSwitchDealerships,
    capabilities,
  } = useAccessibleDealerships();
  const isOwner = profile?.role === "owner";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const staffCanUse = (area: "capture" | "media" | "documents" | "reports" | "settings") => {
    if (profile?.role !== "staff") return true;
    return capabilities?.[area] ?? false;
  };
  const canUseInventory =
    profile?.role !== "staff" || Boolean(capabilities?.capture || capabilities?.media);
  const canAddVehicle = profile?.role !== "staff" || Boolean(capabilities?.media);
  const { configuration: captureMethods } = useCaptureMethods(selectedDealershipId);

  const items: NavItem[] = [
    { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
    ...(canUseInventory ? [{ to: "/inventory", label: "Inventory", icon: PackageSearch }] : []),
    ...(staffCanUse("capture") && captureMethods.bulkEnabled
      ? [{ to: "/bulk-photos", label: "Capture", icon: Camera }]
      : []),
    ...(staffCanUse("media")
      ? [
          { to: "/overlays", label: "Overlays", icon: Images },
          { to: "/backdrops", label: "Backdrops", icon: Aperture },
        ]
      : []),
    ...(staffCanUse("documents")
      ? [
          { to: "/documents", label: "Documents", icon: FileImage },
          { to: "/export", label: "Exports", icon: FileOutput },
        ]
      : []),
    ...(staffCanUse("reports")
      ? [{ to: "/reports", label: "Production & payouts", icon: BarChart3 }]
      : []),
    ...(isOwner || profile?.role === "dealer_admin"
      ? [{ to: "/dealerships", label: "Dealerships", icon: Building2 }]
      : []),
    ...(isOwner || profile?.role === "dealer_admin"
      ? [{ to: "/users", label: "Users & access", icon: Users }]
      : []),
    ...(isOwner || profile?.role === "dealer_admin" || staffCanUse("settings")
      ? [{ to: "/settings", label: "Store settings", icon: Settings }]
      : []),
  ];

  const title = pageTitle(pathname);
  const displayName = profile?.full_name || user?.email || "DealerShot user";
  const initials = displayName
    .split(/\s|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const switchLocked = isStoreSwitchLocked(pathname);

  const renderNavigation = (isCollapsed: boolean, showMobileClose = false) => (
    <>
      <div
        className={cn(
          "flex h-16 items-center border-b border-sidebar-border px-4",
          isCollapsed ? "justify-center px-2" : "gap-3",
        )}
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
          <ScanLine aria-hidden className="size-5" />
        </div>
        {!isCollapsed && (
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold leading-5 tracking-[-0.02em] text-white">
              DealerShot
            </p>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-sidebar-foreground/50">
              Photo operations
            </p>
          </div>
        )}
        {showMobileClose && (
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-11 shrink-0 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
              aria-label="Close navigation"
            >
              <PanelLeftClose aria-hidden className="size-5" />
            </Button>
          </SheetClose>
        )}
      </div>
      <StoreContextControl
        collapsed={isCollapsed}
        dealerships={dealerships}
        selectedDealershipId={selectedDealershipId}
        selectedDealership={selectedDealership}
        loading={loadingDealerships}
        error={dealershipError}
        canSwitch={canSwitchDealerships}
        disabled={switchLocked}
        onSelect={setSelectedDealershipId}
      />
      <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-2 py-4">
        {!isCollapsed && (
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-sidebar-foreground/45">
            Workspace
          </p>
        )}
        <div className="space-y-1">
          {items.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
            const Icon = item.icon;
            const link = (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "motion-row group flex min-h-10 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-sidebar-ring",
                  isCollapsed && "justify-center px-0",
                  active &&
                    "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--color-sidebar-primary)]",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-[18px] shrink-0", active && "text-sidebar-primary")}
                />
                {!isCollapsed && <span>{item.label}</span>}
              </Link>
            );
            return isCollapsed ? (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            ) : (
              link
            );
          })}
        </div>
      </nav>
      <div className="border-t border-sidebar-border p-2">
        {!isCollapsed && (
          <div className="mb-2 rounded-md border border-sidebar-border bg-sidebar-accent/50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-sidebar-foreground">
              <ShieldCheck aria-hidden className="size-4 text-sidebar-primary" />
              Protected workspace
            </div>
            <p className="mt-1 text-[11px] leading-4 text-sidebar-foreground/50">
              {selectedDealership
                ? `Operating in ${selectedDealership.name}.`
                : "Access follows your active dealership role."}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="motion-button hidden min-h-10 w-full items-center justify-center gap-2 rounded-md text-xs font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:flex"
          aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {isCollapsed ? (
            <ChevronRight aria-hidden className="size-4" />
          ) : (
            <>
              <ChevronLeft aria-hidden className="size-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </>
  );

  return (
    <TooltipProvider delayDuration={120}>
      <div className="min-h-screen bg-background">
        <aside
          className={cn(
            "motion-sidebar fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] md:flex",
            collapsed ? "w-[72px]" : "w-64",
          )}
        >
          {renderNavigation(collapsed)}
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-[19rem] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
          >
            <SheetTitle className="sr-only">DealerShot navigation</SheetTitle>
            <SheetDescription className="sr-only">Navigate dealership operations.</SheetDescription>
            <div className="flex h-full flex-col">{renderNavigation(false, true)}</div>
          </SheetContent>
        </Sheet>

        <div
          className={cn(
            "motion-sidebar min-h-screen transition-[padding]",
            collapsed ? "md:pl-[72px]" : "md:pl-64",
          )}
        >
          <header className="app-shell-header sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-card/95 px-3 backdrop-blur sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 md:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <Menu aria-hidden className="size-5" />
              </Button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                  {title}
                </p>
                <p className="truncate text-[11px] text-muted-foreground sm:text-xs">
                  {selectedDealership?.name ?? "Dealer operations workspace"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              {canAddVehicle && (
                <Button asChild size="sm" className="hidden sm:inline-flex">
                  <Link
                    to="/vehicles/new"
                    search={{ dealership: selectedDealershipId ?? undefined }}
                  >
                    <Plus aria-hidden className="size-4" /> Add vehicle
                  </Link>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-11 gap-2 px-2"
                    aria-label="Open account menu"
                  >
                    <Avatar className="size-8 border border-border">
                      <AvatarFallback className="bg-secondary text-xs font-semibold text-secondary-foreground">
                        {initials || "DS"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-36 truncate text-sm font-medium sm:block">
                      {displayName}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>
                    <span className="block truncate text-sm font-semibold">{displayName}</span>
                    <span className="mt-0.5 block text-xs font-normal capitalize text-muted-foreground">
                      {profile?.role?.replace("_", " ")}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>
                    <UserRound aria-hidden />
                    Account settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => void signOut()}
                    className="text-destructive focus:text-destructive"
                  >
                    <LogOut aria-hidden />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div key={`${pathname}:${selectedDealershipId ?? "no-store"}`} className="motion-page">
            {children}
          </div>
        </div>
        <BackgroundProcessingStatus />
      </div>
    </TooltipProvider>
  );
}

type StoreContextControlProps = {
  collapsed: boolean;
  dealerships: ReturnType<typeof useAccessibleDealerships>["dealerships"];
  selectedDealershipId: string | null;
  selectedDealership: ReturnType<typeof useAccessibleDealerships>["selectedDealership"];
  loading: boolean;
  error: string | null;
  canSwitch: boolean;
  disabled: boolean;
  onSelect: (dealershipId: string | null) => void;
};

function StoreContextControl({
  collapsed,
  dealerships,
  selectedDealershipId,
  selectedDealership,
  loading,
  error,
  canSwitch,
  disabled,
  onSelect,
}: StoreContextControlProps) {
  const label = loading
    ? "Loading stores…"
    : error
      ? "Store access unavailable"
      : (selectedDealership?.name ?? "No authorized store");
  const trigger = (
    <button
      type="button"
      disabled={!canSwitch || disabled || loading || Boolean(error)}
      aria-label={
        disabled
          ? `Active store: ${label}. Finish the current vehicle task before switching stores.`
          : `Active store: ${label}`
      }
      className={cn(
        "motion-button flex min-h-11 w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/45 px-2.5 text-left text-sidebar-foreground hover:bg-sidebar-accent focus-visible:outline-sidebar-ring disabled:cursor-default disabled:opacity-100",
        collapsed && "mx-auto size-11 w-11 justify-center px-0",
      )}
    >
      <Building2 aria-hidden className="size-4 shrink-0 text-sidebar-primary" />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/45">
              {selectedDealership?.organization_name ?? "Active store"}
            </span>
            <span className="block truncate text-xs font-semibold">{label}</span>
          </span>
          {canSwitch && !disabled && (
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-sidebar-foreground/45" />
          )}
        </>
      )}
    </button>
  );

  return (
    <div className={cn("border-b border-sidebar-border p-2", collapsed && "px-1.5")}>
      {canSwitch && !disabled ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent side={collapsed ? "right" : "bottom"} align="start" className="w-72">
            <DropdownMenuLabel>
              <span className="block text-sm font-semibold">Switch active store</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                The workspace follows this selection.
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {dealerships.map((dealership) => (
              <DropdownMenuItem
                key={dealership.id}
                onSelect={() => onSelect(dealership.id)}
                className="min-h-11 gap-3"
              >
                <Check
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    selectedDealershipId === dealership.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{dealership.name}</span>
                  {dealership.organization_name && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {dealership.organization_name}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        trigger
      )}
      {!collapsed && disabled && (
        <p className="mt-1.5 px-1 text-[10px] leading-4 text-sidebar-foreground/45">
          Finish the current vehicle task before switching stores.
        </p>
      )}
    </div>
  );
}

function pageTitle(pathname: string) {
  if (pathname.startsWith("/vehicles/new")) return "Add vehicle";
  if (pathname.startsWith("/vehicles/")) return "Vehicle workspace";
  if (pathname.startsWith("/bulk-photos")) return "Bulk Photos";
  const labels: Record<string, string> = {
    "/dashboard": "Overview",
    "/inventory": "Inventory",
    "/bulk-photos": "Bulk Photos",
    "/overlays": "Overlays",
    "/backdrops": "Backdrops",
    "/documents": "Documents",
    "/export": "Exports",
    "/dealerships": "Dealerships",
    "/users": "Users & access",
    "/settings": "Store settings",
  };
  return labels[pathname] ?? "DealerShot";
}
