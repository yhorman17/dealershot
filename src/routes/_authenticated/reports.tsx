import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Download, Printer, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  }, [fromDate, selectedDealership?.name, selectedDealershipId, status, toDate]);

  const employees = useMemo(() => [...new Set(rows.map((row) => row.employee))].sort(), [rows]);
  const filteredRows = employee === "all" ? rows : rows.filter((row) => row.employee === employee);
  const summary = summarizeAccounting(filteredRows);

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
