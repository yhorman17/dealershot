export type AccountingRow = {
  employee: string;
  workDate: string;
  dealership: string;
  stockNumber: string;
  vin: string;
  vehicle: string;
  taskType: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number | null;
  photoCount: number;
  videoCount: number;
  amount: number;
  payoutStatus: string;
  reviewStatus: string;
};

export function summarizeAccounting(rows: AccountingRow[]) {
  return rows.reduce(
    (summary, row) => ({
      vehiclesCompleted: summary.vehiclesCompleted + 1,
      photos: summary.photos + row.photoCount,
      videos: summary.videos + row.videoCount,
      payout: summary.payout + row.amount,
      durationSeconds: summary.durationSeconds + (row.durationSeconds ?? 0),
    }),
    { vehiclesCompleted: 0, photos: 0, videos: 0, payout: 0, durationSeconds: 0 },
  );
}

export function accountingRowsToCsv(rows: AccountingRow[]): string {
  const headers: Array<keyof AccountingRow> = [
    "employee",
    "workDate",
    "dealership",
    "stockNumber",
    "vin",
    "vehicle",
    "taskType",
    "startedAt",
    "completedAt",
    "durationSeconds",
    "photoCount",
    "videoCount",
    "amount",
    "payoutStatus",
    "reviewStatus",
  ];
  const lines = [headers.map(humanize).map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}
