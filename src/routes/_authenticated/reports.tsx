import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CameraOff,
  Download,
  Printer,
  ReceiptText,
  TimerReset,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "@/components/product-ui";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { supabase } from "@/integrations/supabase/client";
import { accountingRowsToCsv, summarizeAccounting, type AccountingRow } from "@/lib/accounting";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Production & payouts — DealerShot" }] }),
  component: ReportsPage,
});

type PayoutRecord = {
  id: string;
  dealership_id: string;
  employee_id: string;
  vehicle_id: string | null;
  photo_shoot_id: string | null;
  task_type: string;
  work_date: string;
  amount: number;
  status: "pending" | "approved" | "paid" | "void";
};

type ReportView = "payouts" | "daily" | "no_photos" | "short_shoot" | "processing" | "attention";

function ReportsPage() {
  const { dealerships, selectedDealership, selectedDealershipId, setSelectedDealershipId } =
    useAccessibleDealerships();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState(today);
  const [status, setStatus] = useState("all");
  const [employee, setEmployee] = useState("all");
  const [rows, setRows] = useState<Array<AccountingRow & { payoutId: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ReportView>("payouts");
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!selectedDealershipId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      let payoutQuery = supabase
        .from("payout_entries")
        .select(
          "id, dealership_id, employee_id, vehicle_id, photo_shoot_id, task_type, work_date, amount, status",
        )
        .eq("dealership_id", selectedDealershipId)
        .gte("work_date", fromDate)
        .lte("work_date", toDate)
        .order("work_date", { ascending: false });
      if (status !== "all")
        payoutQuery = payoutQuery.eq("status", status as PayoutRecord["status"]);
      const { data, error: payoutError } = await payoutQuery;
      if (cancelled) return;
      if (payoutError) {
        setError(
          "Production records could not be loaded. Your role may not include reporting access.",
        );
        setLoading(false);
        return;
      }
      const payouts = (data as PayoutRecord[]) ?? [];
      const employeeIds = [...new Set(payouts.map((item) => item.employee_id))];
      const vehicleIds = [
        ...new Set(payouts.flatMap((item) => (item.vehicle_id ? [item.vehicle_id] : []))),
      ];
      const shootIds = [
        ...new Set(payouts.flatMap((item) => (item.photo_shoot_id ? [item.photo_shoot_id] : []))),
      ];
      const [profilesResult, vehiclesResult, shootsResult] = await Promise.all([
        employeeIds.length
          ? supabase.from("profiles").select("id, full_name, email").in("id", employeeIds)
          : Promise.resolve({ data: [] }),
        vehicleIds.length
          ? supabase
              .from("vehicles")
              .select("id, stock_number, vin, year, make, model, trim")
              .in("id", vehicleIds)
          : Promise.resolve({ data: [] }),
        shootIds.length
          ? supabase
              .from("photo_capture_sessions")
              .select(
                "id, started_at, completed_at, duration_seconds, photo_count, video_count, review_status",
              )
              .in("id", shootIds)
          : Promise.resolve({ data: [] }),
      ]);
      if (cancelled) return;
      const profileMap = new Map(
        (
          (profilesResult.data as Array<{ id: string; full_name: string | null; email: string }>) ??
          []
        ).map((item) => [item.id, item.full_name || item.email]),
      );
      const vehicleMap = new Map(
        ((vehiclesResult.data as Array<Record<string, string | number | null>>) ?? []).map(
          (item) => [item.id, item],
        ),
      );
      const shootMap = new Map(
        ((shootsResult.data as Array<Record<string, string | number | null>>) ?? []).map((item) => [
          item.id,
          item,
        ]),
      );
      setRows(
        payouts.map((item) => {
          const vehicle = item.vehicle_id ? vehicleMap.get(item.vehicle_id) : undefined;
          const shoot = item.photo_shoot_id ? shootMap.get(item.photo_shoot_id) : undefined;
          return {
            payoutId: item.id,
            employee: profileMap.get(item.employee_id) ?? "Former user",
            workDate: item.work_date,
            dealership: selectedDealership?.name ?? "Dealership",
            stockNumber: String(vehicle?.stock_number ?? ""),
            vin: String(vehicle?.vin ?? ""),
            vehicle: [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.trim]
              .filter(Boolean)
              .join(" "),
            taskType: humanize(item.task_type),
            startedAt: String(shoot?.started_at ?? ""),
            completedAt: String(shoot?.completed_at ?? ""),
            durationSeconds:
              typeof shoot?.duration_seconds === "number" ? shoot.duration_seconds : null,
            photoCount: Number(shoot?.photo_count ?? 0),
            videoCount: Number(shoot?.video_count ?? 0),
            amount: Number(item.amount),
            payoutStatus: item.status,
            reviewStatus: String(shoot?.review_status ?? "unreviewed"),
          };
        }),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fromDate, refreshKey, selectedDealership?.name, selectedDealershipId, status, toDate]);

  const employees = useMemo(() => [...new Set(rows.map((row) => row.employee))].sort(), [rows]);
  const filteredRows = employee === "all" ? rows : rows.filter((row) => row.employee === employee);
  const summary = summarizeAccounting(filteredRows);

  if (view !== "payouts") {
    return (
      <OperationalReport
        view={view}
        onViewChange={setView}
        dealershipId={selectedDealershipId}
        dealershipName={selectedDealership?.name ?? "Dealership"}
        dealerships={dealerships}
        onDealershipChange={setSelectedDealershipId}
        fromDate={fromDate}
        toDate={toDate}
        setFromDate={setFromDate}
        setToDate={setToDate}
      />
    );
  }

  const downloadCsv = () => {
    const blob = new Blob([accountingRowsToCsv(filteredRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dealershot-production-${fromDate}-${toDate}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const updateStatus = async (payoutId: string, nextStatus: "approved" | "paid") => {
    const { error: updateError } = await supabase.rpc("set_payout_status", {
      _payout_id: payoutId,
      _status: nextStatus,
    });
    if (updateError) {
      toast.error("Payout status could not be changed", { description: updateError.message });
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.payoutId === payoutId ? { ...row, payoutStatus: nextStatus } : row,
      ),
    );
    toast.success(nextStatus === "paid" ? "Payout marked paid" : "Payout approved");
  };

  return (
    <main className="ds-page-gutter report-page">
      <PageHeader
        eyebrow="Durable production records"
        title="Production & payouts"
        description="Filter completed work, review explainable payout entries, export CSV, or print a report for accounting."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setAdjustmentOpen(true)}
              disabled={!selectedDealershipId}
            >
              Manual adjustment
            </Button>
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={!filteredRows.length}
            >
              <Printer className="size-4" /> Print
            </Button>
            <Button onClick={downloadCsv} disabled={!filteredRows.length}>
              <Download className="size-4" /> Export CSV
            </Button>
          </>
        }
      />

      <ManualAdjustmentDialog
        open={adjustmentOpen}
        onOpenChange={setAdjustmentOpen}
        dealershipId={selectedDealershipId}
        onCreated={() => setRefreshKey((value) => value + 1)}
      />

      <ReportNav value={view} onChange={setView} />

      <section className="ds-surface mb-5 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5 print:hidden">
        <Select value={selectedDealershipId ?? ""} onValueChange={setSelectedDealershipId}>
          <SelectTrigger className="h-11">
            <SelectValue placeholder="Dealership" />
          </SelectTrigger>
          <SelectContent>
            {dealerships.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Report start date"
          type="date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
          className="h-11"
        />
        <Input
          aria-label="Report end date"
          type="date"
          value={toDate}
          onChange={(event) => setToDate(event.target.value)}
          className="h-11"
        />
        <Select value={employee} onValueChange={setEmployee}>
          <SelectTrigger className="h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees</SelectItem>
            {employees.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["all", "pending", "approved", "paid", "void"].map((value) => (
              <SelectItem key={value} value={value}>
                {humanize(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Vehicles completed" value={summary.vehiclesCompleted} />
        <MetricCard label="Photos captured" value={summary.photos} />
        <MetricCard label="Total payout" value={currency(summary.payout)} />
        <MetricCard
          label="Average shoot"
          value={
            summary.vehiclesCompleted
              ? duration(Math.round(summary.durationSeconds / summary.vehiclesCompleted))
              : "—"
          }
        />
      </div>

      {loading ? (
        <div className="ds-surface p-8 text-sm text-muted-foreground" aria-busy="true">
          Loading production records…
        </div>
      ) : error ? (
        <ErrorState description={error} onRetry={() => setFromDate((value) => value)} />
      ) : filteredRows.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={<ReceiptText className="size-5" />}
            title="No production records"
            description="Completed shoots with configured payout rules will appear here. No sample accounting data is shown."
          />
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-card lg:block">
            <table className="w-full min-w-[1100px] text-left text-xs">
              <thead className="sticky top-16 bg-secondary text-muted-foreground">
                <tr>
                  {[
                    "Employee",
                    "Date",
                    "Stock / VIN",
                    "Vehicle",
                    "Task",
                    "Completed",
                    "Duration",
                    "Photos",
                    "Payout",
                    "Status",
                    "Actions",
                  ].map((label) => (
                    <th key={label} className="px-3 py-3 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.payoutId} className="border-t border-border">
                    <td className="px-3 py-3 font-medium">{row.employee}</td>
                    <td className="px-3 py-3">{row.workDate}</td>
                    <td className="px-3 py-3">
                      <span className="block font-medium">{row.stockNumber || "—"}</span>
                      <span className="text-muted-foreground">{row.vin || "—"}</span>
                    </td>
                    <td className="px-3 py-3">{row.vehicle || "—"}</td>
                    <td className="px-3 py-3">{row.taskType}</td>
                    <td className="px-3 py-3">{dateTime(row.completedAt)}</td>
                    <td className="px-3 py-3 tabular-nums">{duration(row.durationSeconds)}</td>
                    <td className="px-3 py-3 tabular-nums">{row.photoCount}</td>
                    <td className="px-3 py-3 font-semibold tabular-nums">{currency(row.amount)}</td>
                    <td className="px-3 py-3">
                      <StatusBadge
                        tone={
                          row.payoutStatus === "paid"
                            ? "success"
                            : row.payoutStatus === "pending"
                              ? "warning"
                              : "info"
                        }
                      >
                        {humanize(row.payoutStatus)}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-3 print:hidden">
                      {row.payoutStatus === "pending" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void updateStatus(row.payoutId, "approved")}
                        >
                          Approve
                        </Button>
                      ) : row.payoutStatus === "approved" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void updateStatus(row.payoutId, "paid")}
                        >
                          Mark paid
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={7} className="px-3 py-3 text-right">
                    Totals
                  </td>
                  <td className="px-3 py-3">{summary.photos}</td>
                  <td className="px-3 py-3">{currency(summary.payout)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="grid gap-3 lg:hidden">
            {filteredRows.map((row) => (
              <article key={row.payoutId} className="ds-surface p-4">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="font-semibold">{row.employee}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.workDate} · {row.stockNumber || row.vin || "Unassigned vehicle"}
                    </p>
                  </div>
                  <StatusBadge tone={row.payoutStatus === "paid" ? "success" : "warning"}>
                    {humanize(row.payoutStatus)}
                  </StatusBadge>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                  <ReportFact label="Vehicle" value={row.vehicle || "—"} />
                  <ReportFact label="Photos" value={String(row.photoCount)} />
                  <ReportFact label="Payout" value={currency(row.amount)} />
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function ManualAdjustmentDialog({
  open,
  onOpenChange,
  dealershipId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealershipId: string | null;
  onCreated: () => void;
}) {
  const [employees, setEmployees] = useState<Array<{ id: string; name: string }>>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || !dealershipId) return;
    void supabase
      .rpc("list_payout_eligible_profiles", { _dealership_id: dealershipId })
      .then(({ data }) => {
        const options = (data ?? []).map((item) => ({
          id: item.profile_id,
          name: item.full_name || item.email,
        }));
        setEmployees(options);
        setEmployeeId((current) => current || options[0]?.id || "");
      });
  }, [dealershipId, open]);
  const create = async () => {
    if (
      !dealershipId ||
      !employeeId ||
      !reason.trim() ||
      !Number.isFinite(Number(amount)) ||
      Number(amount) === 0
    )
      return;
    setSaving(true);
    const { error } = await supabase.rpc("create_manual_payout_adjustment", {
      _dealership_id: dealershipId,
      _employee_id: employeeId,
      _amount: Number(amount),
      _reason: reason.trim(),
      _work_date: workDate,
    });
    setSaving(false);
    if (error)
      return toast.error("Adjustment could not be created", { description: error.message });
    toast.success("Manual adjustment recorded", {
      description: "The reason and author were added to the audit trail.",
    });
    setAmount("");
    setReason("");
    onOpenChange(false);
    onCreated();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manual payout adjustment</DialogTitle>
          <DialogDescription>
            Authorized accounting correction, bonus, or deduction. Photographers cannot create
            adjustments.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor="adjustment-employee">Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger id="adjustment-employee" className="mt-1.5 h-11">
                <SelectValue placeholder="Select employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="adjustment-amount">Amount</Label>
              <Input
                id="adjustment-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="Use - for deduction"
                className="mt-1.5 h-11"
              />
            </div>
            <div>
              <Label htmlFor="adjustment-date">Work date</Label>
              <Input
                id="adjustment-date"
                type="date"
                value={workDate}
                onChange={(event) => setWorkDate(event.target.value)}
                className="mt-1.5 h-11"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="adjustment-reason">Reason</Label>
            <Textarea
              id="adjustment-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required accounting explanation"
              className="mt-1.5 min-h-24"
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || !employeeId || !reason.trim() || !amount || Number(amount) === 0}
            onClick={() => void create()}
          >
            {saving ? "Recording…" : "Record adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type OperationalVehicle = {
  id: string;
  stock_number: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  inventory_arrival_date: string | null;
  price: number | null;
  internet_price: number | null;
  retail_readiness_status: string;
  assigned_photographer_id: string | null;
};

type OperationalRow = OperationalVehicle & {
  photoCount: number;
  status: string;
  reasons: Array<{ key?: string; label?: string }>;
  processing: string[];
};

function OperationalReport({
  view,
  onViewChange,
  dealershipId,
  dealershipName,
  dealerships,
  onDealershipChange,
  fromDate,
  toDate,
  setFromDate,
  setToDate,
}: {
  view: Exclude<ReportView, "payouts">;
  onViewChange: (value: ReportView) => void;
  dealershipId: string | null;
  dealershipName: string;
  dealerships: Array<{ id: string; name: string }>;
  onDealershipChange: (value: string) => void;
  fromDate: string;
  toDate: string;
  setFromDate: (value: string) => void;
  setToDate: (value: string) => void;
}) {
  const [rows, setRows] = useState<OperationalRow[]>([]);
  const [daily, setDaily] = useState<
    Array<{
      id: string;
      completed_at: string | null;
      created_by: string | null;
      photo_count: number;
      video_count: number;
      duration_seconds: number | null;
    }>
  >([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dealershipId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const [vehiclesResult, readinessResult, sessionsResult] = await Promise.all([
        supabase
          .from("vehicles")
          .select(
            "id, stock_number, vin, year, make, model, trim, inventory_arrival_date, price, internet_price, retail_readiness_status, assigned_photographer_id",
          )
          .eq("dealership_id", dealershipId)
          .order("inventory_arrival_date", { ascending: true, nullsFirst: false }),
        supabase
          .from("vehicle_readiness")
          .select("vehicle_id, status, reasons, photo_count")
          .eq("dealership_id", dealershipId),
        supabase
          .from("photo_capture_sessions")
          .select("id, completed_at, created_by, photo_count, video_count, duration_seconds")
          .eq("dealership_id", dealershipId)
          .eq("status", "completed")
          .gte("completed_at", `${fromDate}T00:00:00`)
          .lte("completed_at", `${toDate}T23:59:59`)
          .order("completed_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const vehicleIds = (vehiclesResult.data ?? []).map((vehicle) => vehicle.id);
      const photosResult = vehicleIds.length
        ? await supabase
            .from("photos")
            .select("vehicle_id, processing_status")
            .in("vehicle_id", vehicleIds)
        : { data: [], error: null };
      const firstError = [
        vehiclesResult.error,
        readinessResult.error,
        photosResult.error,
        sessionsResult.error,
      ].find(Boolean);
      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }
      const readinessMap = new Map(
        (readinessResult.data ?? []).map((item) => [item.vehicle_id, item]),
      );
      const processingMap = new Map<string, string[]>();
      (photosResult.data ?? []).forEach((photo) =>
        processingMap.set(photo.vehicle_id, [
          ...(processingMap.get(photo.vehicle_id) ?? []),
          photo.processing_status,
        ]),
      );
      const mapped = ((vehiclesResult.data ?? []) as OperationalVehicle[]).map((vehicle) => {
        const readiness = readinessMap.get(vehicle.id);
        return {
          ...vehicle,
          photoCount: readiness?.photo_count ?? 0,
          status: readiness?.status ?? vehicle.retail_readiness_status,
          reasons: Array.isArray(readiness?.reasons)
            ? (readiness.reasons as Array<{ key?: string; label?: string }>)
            : [],
          processing: processingMap.get(vehicle.id) ?? [],
        };
      });
      const sessions = sessionsResult.data ?? [];
      const profileIds = [
        ...new Set([
          ...mapped.flatMap((item) =>
            item.assigned_photographer_id ? [item.assigned_photographer_id] : [],
          ),
          ...sessions.flatMap((item) => (item.created_by ? [item.created_by] : [])),
        ]),
      ];
      const profileResult = profileIds.length
        ? await supabase.from("profiles").select("id, full_name, email").in("id", profileIds)
        : { data: [] };
      if (cancelled) return;
      setNames(
        new Map(
          (profileResult.data ?? []).map((profile) => [
            profile.id,
            profile.full_name || profile.email,
          ]),
        ),
      );
      setRows(mapped);
      setDaily(sessions);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [dealershipId, fromDate, toDate]);

  const filtered = useMemo(() => {
    if (view === "no_photos") return rows.filter((row) => row.photoCount === 0);
    if (view === "short_shoot")
      return rows.filter((row) =>
        row.reasons.some(
          (reason) => reason.key === "media.required_shot" || reason.key === "media.minimum_photos",
        ),
      );
    if (view === "processing")
      return rows.filter(
        (row) =>
          row.processing.some((status) => ["queued", "processing", "failed"].includes(status)) ||
          row.status === "awaiting_review",
      );
    return rows.filter((row) => row.status !== "retail_ready");
  }, [rows, view]);

  const definition = reportDefinition(view);
  return (
    <main className="ds-page-gutter report-page">
      <PageHeader
        eyebrow="Inventory operations"
        title={definition.title}
        description={definition.description}
        actions={
          <Button
            variant="outline"
            onClick={() => window.print()}
            disabled={view !== "daily" && !filtered.length}
          >
            <Printer className="size-4" /> Print
          </Button>
        }
      />
      <ReportNav value={view} onChange={onViewChange} />
      <section className="ds-surface mb-5 grid gap-3 p-4 sm:grid-cols-3 print:hidden">
        <Select value={dealershipId ?? ""} onValueChange={onDealershipChange}>
          <SelectTrigger className="h-11">
            <SelectValue placeholder="Dealership" />
          </SelectTrigger>
          <SelectContent>
            {dealerships.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {view === "daily" ? (
          <>
            <Input
              aria-label="Start date"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="h-11"
            />
            <Input
              aria-label="End date"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="h-11"
            />
          </>
        ) : (
          <div className="col-span-2 flex items-center text-xs text-muted-foreground">
            {filtered.length} vehicle{filtered.length === 1 ? "" : "s"} at {dealershipName}
          </div>
        )}
      </section>
      {loading ? (
        <div className="ds-surface p-8 text-sm text-muted-foreground" aria-busy="true">
          Loading report…
        </div>
      ) : error ? (
        <ErrorState description={error} />
      ) : view === "daily" ? (
        <DailyActivity sessions={daily} names={names} dealershipName={dealershipName} />
      ) : filtered.length === 0 ? (
        <div className="ds-surface">
          <EmptyState
            icon={definition.icon}
            title={`No ${definition.title.toLowerCase()}`}
            description="There are no vehicles matching this operational condition."
          />
        </div>
      ) : (
        <OperationalVehicleList rows={filtered} names={names} view={view} />
      )}
    </main>
  );
}

function OperationalVehicleList({
  rows,
  names,
  view,
}: {
  rows: OperationalRow[];
  names: Map<string, string>;
  view: Exclude<ReportView, "payouts" | "daily">;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden grid-cols-[minmax(18rem,1.4fr)_9rem_8rem_10rem_minmax(14rem,1fr)] gap-3 bg-secondary px-4 py-3 text-xs font-semibold text-muted-foreground md:grid">
        <span>Vehicle</span>
        <span>Stock</span>
        <span>Photos</span>
        <span>Age</span>
        <span>Needs work</span>
      </div>
      {rows.map((row) => (
        <article
          key={row.id}
          className="grid gap-3 border-t border-border p-4 first:border-t-0 md:grid-cols-[minmax(18rem,1.4fr)_9rem_8rem_10rem_minmax(14rem,1fr)] md:items-center"
        >
          <div>
            <p className="font-semibold">
              {row.year} {row.make} {row.model} {row.trim}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{row.vin}</p>
          </div>
          <span className="text-sm">{row.stock_number}</span>
          <span className="text-sm tabular-nums">{row.photoCount}</span>
          <span className="text-sm">{inventoryAge(row.inventory_arrival_date)}</span>
          <div>
            <StatusBadge tone={row.status === "blocked" ? "danger" : "warning"}>
              {humanize(row.status)}
            </StatusBadge>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {view === "processing"
                ? processingSummary(row.processing, row.status)
                : row.reasons
                    .map((reason) => reason.label)
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(" · ") ||
                  (row.assigned_photographer_id
                    ? `Assigned to ${names.get(row.assigned_photographer_id) ?? "staff"}`
                    : "No photographer assigned")}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

function DailyActivity({
  sessions,
  names,
  dealershipName,
}: {
  sessions: Array<{
    id: string;
    completed_at: string | null;
    created_by: string | null;
    photo_count: number;
    video_count: number;
    duration_seconds: number | null;
  }>;
  names: Map<string, string>;
  dealershipName: string;
}) {
  const grouped = new Map<
    string,
    { employee: string; vehicles: number; photos: number; videos: number; duration: number }
  >();
  sessions.forEach((session) => {
    const key = session.created_by ?? "unknown";
    const current = grouped.get(key) ?? {
      employee: session.created_by ? (names.get(session.created_by) ?? "Former user") : "Unknown",
      vehicles: 0,
      photos: 0,
      videos: 0,
      duration: 0,
    };
    current.vehicles += 1;
    current.photos += session.photo_count;
    current.videos += session.video_count;
    current.duration += session.duration_seconds ?? 0;
    grouped.set(key, current);
  });
  const values = [...grouped.values()];
  if (!values.length)
    return (
      <div className="ds-surface">
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No completed work"
          description="Completed shoots in the selected date range will appear here."
        />
      </div>
    );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border p-4">
        <p className="font-semibold">{dealershipName}</p>
        <p className="text-xs text-muted-foreground">Durable completed-shoot totals</p>
      </div>
      {values.map((row) => (
        <div
          key={row.employee}
          className="grid gap-3 border-b border-border p-4 last:border-b-0 sm:grid-cols-5"
        >
          <ReportFact label="Photographer" value={row.employee} />
          <ReportFact label="Vehicles" value={String(row.vehicles)} />
          <ReportFact label="Photos" value={String(row.photos)} />
          <ReportFact label="Videos" value={String(row.videos)} />
          <ReportFact
            label="Average shoot"
            value={duration(row.vehicles ? Math.round(row.duration / row.vehicles) : null)}
          />
        </div>
      ))}
    </div>
  );
}

function ReportNav({
  value,
  onChange,
}: {
  value: ReportView;
  onChange: (value: ReportView) => void;
}) {
  const items: Array<[ReportView, string]> = [
    ["payouts", "Production & Payouts"],
    ["daily", "Daily Activity"],
    ["no_photos", "No Photos"],
    ["short_shoot", "Short Shoot"],
    ["processing", "Processing"],
    ["attention", "Inventory Attention"],
  ];
  return (
    <nav
      aria-label="Reports"
      className="mb-5 flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 print:hidden"
    >
      {items.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`min-h-10 shrink-0 rounded-md px-3 text-xs font-semibold ${value === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function reportDefinition(view: Exclude<ReportView, "payouts">) {
  if (view === "daily")
    return {
      title: "Daily Activity",
      description:
        "Completed vehicles and media output by photographer, derived from durable shoot records.",
      icon: <Activity className="size-5" />,
    };
  if (view === "no_photos")
    return {
      title: "No Photos",
      description: "Inventory with no registered retail photos.",
      icon: <CameraOff className="size-5" />,
    };
  if (view === "short_shoot")
    return {
      title: "Short Shoot",
      description: "Vehicles missing configured photo counts or required shot labels.",
      icon: <AlertTriangle className="size-5" />,
    };
  if (view === "processing")
    return {
      title: "Processing",
      description: "Media queued, processing, awaiting review, or failed.",
      icon: <TimerReset className="size-5" />,
    };
  return {
    title: "Inventory Attention",
    description:
      "Non-retail-ready inventory, including missing data, media, documents, and aging units.",
    icon: <AlertTriangle className="size-5" />,
  };
}

const inventoryAge = (arrival: string | null) => {
  if (!arrival) return "Unknown";
  const days = Math.max(0, Math.floor((Date.now() - new Date(arrival).getTime()) / 86400000));
  return days <= 15
    ? `${days}d · 0–15`
    : days <= 30
      ? `${days}d · 16–30`
      : days <= 60
        ? `${days}d · 31–60`
        : days <= 90
          ? `${days}d · 61–90`
          : `${days}d · 90+`;
};
const processingSummary = (states: string[], readiness: string) => {
  const failed = states.filter((state) => state === "failed").length;
  const active = states.filter((state) => state === "queued" || state === "processing").length;
  return failed
    ? `${failed} failed — retry required`
    : active
      ? `${active} queued or processing`
      : readiness === "awaiting_review"
        ? "Prepared media awaits review"
        : "No active processing";
};

function ReportFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

const humanize = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const currency = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const dateTime = (value: string) =>
  value
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";
const duration = (seconds: number | null) =>
  seconds === null ? "—" : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
