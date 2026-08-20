import { ArrowDown, ArrowRight, ArrowUp, ImagePlus, RotateCcw, Star, Trash2 } from "lucide-react";

import { SHOT_TYPES } from "@/components/VehiclePhotos";
import { ProductSelect, StatusBadge } from "@/components/product-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { queueableReviewPhotoIds } from "@/lib/background-removal-queue";

export type ReviewProcessingState =
  | "original"
  | "queued"
  | "processing"
  | "ready"
  | "needs_review"
  | "failed";

export type ReviewPhotoItem = {
  id: string;
  image_url: string;
  media_asset_id: string;
  shot_type: string | null;
  media_category: string;
  sort_order: number;
  is_main: boolean;
  created_at: string;
  processing_state?: ReviewProcessingState;
};

export function VehiclePhotoReviewStage({
  items,
  selected,
  selectedId,
  pending,
  failed,
  busy,
  onSelect,
  onAddMore,
  onRetry,
  onRetake,
  onRemove,
  onClassify,
  onSetMain,
  onMove,
  onNext,
  hasVehicle,
  failedUploadContent,
}: {
  items: ReviewPhotoItem[];
  selected: ReviewPhotoItem | null;
  selectedId: string | null;
  pending: number;
  failed: number;
  busy: string | null;
  onSelect: (id: string) => void;
  onAddMore?: () => void;
  onRetry?: () => void;
  onRetake: (item: ReviewPhotoItem) => void;
  onRemove: (item: ReviewPhotoItem) => void;
  onClassify: (item: ReviewPhotoItem, value: string | null) => void;
  onSetMain: (item: ReviewPhotoItem) => void;
  onMove: (item: ReviewPhotoItem, direction: -1 | 1) => void;
  onNext: () => void;
  hasVehicle: boolean;
  failedUploadContent?: React.ReactNode;
}) {
  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Review photos</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Remove accidents or retake a selected photo without restarting the vehicle.
            </p>
          </div>
          {onAddMore && (
            <Button variant="outline" onClick={onAddMore}>
              <ImagePlus className="size-4" /> Add more
            </Button>
          )}
        </div>
        {failed > 1 && onRetry && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{failed} uploads failed. Successful photos are still safe.</span>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry all
            </Button>
          </div>
        )}
        {failedUploadContent}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item, index) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`overflow-hidden rounded-lg border bg-card text-left ${
                selectedId === item.id ? "border-primary ring-2 ring-primary/25" : "border-border"
              }`}
            >
              <div className="relative aspect-square bg-secondary">
                <img
                  src={item.image_url}
                  alt={`Vehicle photo ${index + 1}`}
                  className="h-full w-full object-cover"
                />
                {item.is_main && (
                  <span className="absolute left-2 top-2 rounded bg-primary px-2 py-1 text-[10px] font-bold text-primary-foreground">
                    MAIN
                  </span>
                )}
                <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">
                  {index + 1}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 p-2 text-xs font-medium">
                <span className="truncate">{item.shot_type || "Unclassified"}</span>
                {item.processing_state && item.processing_state !== "original" && (
                  <ProcessingStatus state={item.processing_state} />
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
      <aside className="ds-surface h-fit p-4 xl:sticky xl:top-20">
        {selected ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border border-border bg-secondary">
              <img
                src={selected.image_url}
                alt="Selected vehicle photo preview"
                className="aspect-[4/3] h-auto w-full object-contain"
              />
            </div>
            <p className="text-sm font-semibold">Selected photo</p>
            <ProductSelect
              value={selected.shot_type ?? ""}
              onValueChange={(value) => onClassify(selected, value || null)}
              ariaLabel="Optional photo classification"
              emptyLabel="Unclassified"
              options={SHOT_TYPES.map((shot) => ({ value: shot.name, label: shot.name }))}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => onMove(selected, -1)}
                disabled={items[0]?.id === selected.id}
              >
                <ArrowUp className="size-4" /> Earlier
              </Button>
              <Button
                variant="outline"
                onClick={() => onMove(selected, 1)}
                disabled={items.at(-1)?.id === selected.id}
              >
                <ArrowDown className="size-4" /> Later
              </Button>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => onSetMain(selected)}
              disabled={selected.is_main}
            >
              <Star className="size-4" /> Mark main
            </Button>
            <Button variant="outline" className="w-full" onClick={() => onRetake(selected)}>
              <RotateCcw className="size-4" /> Retake / replace
            </Button>
            <Button
              variant="outline"
              className="w-full text-destructive hover:text-destructive"
              onClick={() => onRemove(selected)}
              disabled={busy !== null}
            >
              <Trash2 className="size-4" /> Remove photo
            </Button>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Select a photo to review.
          </p>
        )}
        <Button
          className="mt-5 min-h-12 w-full"
          onClick={onNext}
          disabled={busy !== null || pending > 0 || failed > 0 || items.length === 0 || !hasVehicle}
        >
          {busy === "next" ? "Preparing…" : "Next"} <ArrowRight className="size-4" />
        </Button>
        {!hasVehicle && (
          <p className="mt-2 text-xs text-muted-foreground">
            This legacy package must first be associated by an office administrator.
          </p>
        )}
      </aside>
    </section>
  );
}

export function VehiclePhotoProcessingStage({
  items,
  selected,
  busy,
  onChange,
  onDone,
}: {
  items: ReviewPhotoItem[];
  selected: Set<string>;
  busy: string | null;
  onChange: (value: Set<string>) => void;
  onDone: () => void;
}) {
  const choose = (ids: string[]) => onChange(new Set(ids));
  return (
    <section className="ds-surface p-4 sm:p-6">
      <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            Optional background work
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
            Select photos to process
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Jobs run privately in the background. Ready or currently processing photos are not
            queued again.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => choose(queueableReviewPhotoIds(items, true))}
          >
            Select exterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => choose(queueableReviewPhotoIds(items))}
          >
            Select all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => choose([])}>
            Clear
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 py-5 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => {
          const checked = selected.has(item.id);
          const disabled =
            item.processing_state === "queued" ||
            item.processing_state === "processing" ||
            item.processing_state === "ready";
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                const next = new Set(selected);
                if (checked) next.delete(item.id);
                else next.add(item.id);
                onChange(next);
              }}
              className={`overflow-hidden rounded-lg border text-left disabled:cursor-not-allowed disabled:opacity-65 ${
                checked ? "border-primary ring-2 ring-primary/25" : "border-border"
              }`}
            >
              <div className="relative aspect-square bg-secondary">
                <img src={item.image_url} alt="" className="h-full w-full object-cover" />
                {!disabled && (
                  <Checkbox
                    checked={checked}
                    className="pointer-events-none absolute left-2 top-2 bg-background"
                  />
                )}
              </div>
              <div className="flex items-center justify-between gap-2 p-2 text-xs font-medium">
                <span className="truncate">{item.shot_type || "Photo"}</span>
                <ProcessingStatus state={item.processing_state ?? "original"} />
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {selected.size} selected · processing continues in the background
        </p>
        <Button className="min-h-12" onClick={onDone} disabled={busy !== null}>
          {busy === "processing" ? "Queueing…" : "Done"}
        </Button>
      </div>
    </section>
  );
}

function ProcessingStatus({ state }: { state: ReviewProcessingState }) {
  const value = {
    original: { label: "Original", tone: "neutral" as const },
    queued: { label: "Queued", tone: "info" as const },
    processing: { label: "Processing", tone: "info" as const },
    ready: { label: "Ready", tone: "success" as const },
    needs_review: { label: "Needs review", tone: "warning" as const },
    failed: { label: "Failed", tone: "danger" as const },
  }[state];
  return (
    <StatusBadge dot={false} tone={value.tone} className="shrink-0 px-1.5 py-0.5 text-[9px]">
      {value.label}
    </StatusBadge>
  );
}
