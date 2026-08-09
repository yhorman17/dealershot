import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  Camera,
  CheckCircle2,
  ImageOff,
  LoaderCircle,
  Search,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 border-b border-border pb-5 sm:mb-8 sm:pb-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              {eyebrow}
            </p>
          )}
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[2rem]">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          )}
          {children}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function AuthFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[minmax(22rem,0.85fr)_minmax(28rem,1.15fr)]">
      <section className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div aria-hidden className="ds-grid-lines absolute inset-0 opacity-[0.08]" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Camera className="size-5" />
          </span>
          <div>
            <p className="text-lg font-semibold tracking-[-0.025em] text-white">DealerShot</p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/45">
              Photo operations
            </p>
          </div>
        </div>
        <div className="relative max-w-lg">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sidebar-primary">
            Built for the lot
          </p>
          <p className="mt-4 text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-white xl:text-5xl">
            From arrival to retail-ready, without the busywork.
          </p>
          <p className="mt-5 max-w-md text-sm leading-6 text-sidebar-foreground/65">
            Keep inventory details, guided photos, processing, documents, and exports moving in one
            protected workspace.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-sidebar-foreground/45">
          <ShieldCheck className="size-4" />
          Tenant-protected dealership access
        </div>
      </section>
      <section className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground">
              <Camera className="size-5" />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-[-0.025em]">DealerShot</p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Photo operations
              </p>
            </div>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
            Secure workspace
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-foreground">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          <div className="mt-7">{children}</div>
          {footer && (
            <div className="mt-6 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">
              {footer}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 sm:px-5">
      <div>
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-card-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

const statusStyles = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  success: "border-success/25 bg-success/10 text-[color:oklch(0.42_0.11_155)]",
  warning: "border-warning/35 bg-warning/15 text-[color:oklch(0.42_0.1_68)]",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  info: "border-info/25 bg-info/10 text-[color:oklch(0.42_0.11_233)]",
} as const;

export function StatusBadge({
  children,
  tone = "neutral",
  dot = true,
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof statusStyles;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "motion-status inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-4",
        statusStyles[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "attention";
}) {
  return (
    <div className="ds-surface min-w-0 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon && (
          <span
            className={cn(
              "text-muted-foreground",
              tone === "attention" && "text-warning-foreground",
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-card-foreground tabular-nums">
        {value}
      </p>
      {detail && <div className="mt-1.5 text-xs leading-5 text-muted-foreground">{detail}</div>}
    </div>
  );
}

export function SearchInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className={cn("relative", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input {...props} type="search" className="h-11 bg-card pl-9" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact = false,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "motion-empty flex flex-col items-center justify-center px-5 text-center",
        compact ? "py-8" : "min-h-64 py-12",
      )}
    >
      <div className="mb-4 grid size-11 place-items-center rounded-lg border border-border bg-secondary text-muted-foreground">
        {icon ?? <ImageOff aria-hidden className="size-5" />}
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "We couldn’t load this view",
  description,
  onRetry,
}: {
  title?: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="ds-surface flex min-h-56 flex-col items-center justify-center px-5 py-10 text-center"
      role="alert"
    >
      <div className="mb-4 grid size-11 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <AlertCircle aria-hidden className="size-5" />
      </div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {onRetry && (
        <Button onClick={onRetry} className="mt-5">
          Try again
        </Button>
      )}
    </div>
  );
}

export function PageSkeleton({ cards = 4, rows = 5 }: { cards?: number; rows?: number }) {
  return (
    <div aria-label="Loading content" aria-busy="true" className="ds-page-gutter motion-content">
      <div className="mb-7 space-y-3 border-b border-border pb-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-64 max-w-[70vw]" />
        <Skeleton className="h-4 w-96 max-w-[85vw]" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: cards }).map((_, index) => (
          <div key={index} className="ds-surface p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="ds-surface mt-5 overflow-hidden">
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 border-b border-border p-4 last:border-0"
          >
            <Skeleton className="size-11 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="hidden h-6 w-20 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function InlineLoading({ label = "Working…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      {label}
    </span>
  );
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-success/25 bg-success/10 p-3 text-sm text-[color:oklch(0.4_0.1_155)]">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
      {children}
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80"
    >
      {children}
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}
