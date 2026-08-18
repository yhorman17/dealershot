import { lazy, Suspense, useReducer, useState, useRef, useEffect, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CONDITIONS, STATUSES } from "@/lib/vehicle-options";
import { toast } from "sonner";
import { ProductSelect } from "@/components/product-ui";
import {
  createVehicleFormState,
  vehicleFormReducer,
  type VehicleFormValues,
} from "@/lib/vehicle-form-state";

const VinScannerModal = lazy(() =>
  import("@/components/VinScannerModal").then((module) => ({ default: module.VinScannerModal })),
);

export function VehicleForm({
  initial,
  dealershipId,
  vehicleId,
  onSaved,
  onCancel,
  submitLabel,
}: {
  initial?: VehicleFormValues;
  dealershipId: string;
  vehicleId?: string;
  onSaved: (id: string) => void | Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const isEdit = Boolean(vehicleId);
  const [formState, dispatch] = useReducer(vehicleFormReducer, initial, createVehicleFormState);
  const values = formState.values;
  const [decoding, setDecoding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decodeMsg, setDecodeMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ odometer?: string; price?: string }>({});
  const [scannerOpen, setScannerOpen] = useState(false);
  const [vinPulse, setVinPulse] = useState(false);
  const vinInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!vinPulse) return;
    const t = setTimeout(() => setVinPulse(false), 1000);
    return () => clearTimeout(t);
  }, [vinPulse]);

  const set = <K extends keyof VehicleFormValues>(k: K, v: VehicleFormValues[K]) =>
    dispatch({ type: "field", field: k, value: v });

  const decodeVin = async () => {
    if (!values.vin.trim()) return;
    setDecoding(true);
    setDecodeMsg(null);
    setError(null);
    try {
      const res = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(values.vin.trim())}?format=json`,
      );
      const json = await res.json();
      const r = json?.Results?.[0];
      if (!r) throw new Error("No data returned");
      dispatch({
        type: "patch",
        values: {
          year: r.ModelYear || values.year,
          make: r.Make || values.make,
          model: r.Model || values.model,
          trim: r.Trim || values.trim,
          body_class: r.BodyClass || values.body_class,
          engine: r.EngineModel || r.DisplacementL || values.engine,
          cylinders: r.EngineCylinders || values.cylinders,
          transmission: r.TransmissionStyle || values.transmission,
          drivetrain: r.DriveType || values.drivetrain,
          fuel_type: r.FuelTypePrimary || values.fuel_type,
        },
      });
      setDecodeMsg("VIN decoded — review and edit as needed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "VIN decode failed");
    } finally {
      setDecoding(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fe: { odometer?: string; price?: string } = {};
    if (values.odometer.trim() !== "" && isNaN(Number(values.odometer)))
      fe.odometer = "Enter a valid number";
    if (values.price.trim() !== "" && isNaN(Number(values.price)))
      fe.price = "Enter a valid number";
    setFieldErrors(fe);
    if (fe.odometer || fe.price) return;
    setSaving(true);
    try {
      const basePayload = {
        year: values.year ? parseInt(values.year, 10) : null,
        make: values.make.trim() || null,
        model: values.model.trim() || null,
        trim: values.trim.trim() || null,
        series: values.series.trim() || null,
        body_class: values.body_class.trim() || null,
        engine: values.engine.trim() || null,
        cylinders: values.cylinders ? parseInt(values.cylinders, 10) : null,
        transmission: values.transmission.trim() || null,
        drivetrain: values.drivetrain.trim() || null,
        fuel_type: values.fuel_type.trim() || null,
        exterior_color: values.exterior_color.trim() || null,
        interior_color: values.interior_color.trim() || null,
        odometer: values.odometer ? parseInt(values.odometer, 10) : null,
        price: values.price ? parseFloat(values.price) : null,
        internet_price: values.price ? parseFloat(values.price) : null,
        msrp: values.msrp ? parseFloat(values.msrp) : null,
        sale_price: values.sale_price ? parseFloat(values.sale_price) : null,
        price_description: values.price_description.trim() || null,
        stock_number: values.stock_number.trim() || null,
        inventory_type: values.inventory_type,
        inventory_arrival_date: values.inventory_arrival_date || null,
        category: values.category.trim() || null,
        warranty_type: values.warranty_type.trim() || null,
        comments: values.comments.trim() || null,
        custom_comments: values.custom_comments.trim() || null,
        tagline: values.tagline.trim() || null,
        publication_description: values.publication_description.trim() || null,
        internal_notes: values.internal_notes.trim() || null,
        condition: values.condition || null,
        status: values.status || null,
      };

      if (vehicleId) {
        const { error: upErr } = await supabase
          .from("vehicles")
          .update(basePayload)
          .eq("id", vehicleId);
        if (upErr) throw upErr;
        toast.success("Vehicle updated.");
        await onSaved(vehicleId);
      } else {
        const { data, error: insErr } = await supabase
          .from("vehicles")
          .insert({ ...basePayload, dealership_id: dealershipId, vin: values.vin.trim() || null })
          .select("id")
          .single();
        if (insErr) throw insErr;
        await onSaved(data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Section
        title="Vehicle identification"
        description="Start with the VIN and dealership stock reference."
      >
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-card-foreground mb-1.5">VIN</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              ref={vinInputRef}
              value={values.vin}
              onChange={(e) => dispatch({ type: "vin", value: e.target.value })}
              readOnly={isEdit}
              className={`form-input flex-1 transition-shadow ${vinPulse ? "ring-2 ring-primary border-primary" : ""} ${isEdit ? "opacity-70 cursor-not-allowed" : ""}`}
              placeholder="17-character VIN"
            />
            {!isEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setScannerOpen(true)}
                  className="md:hidden inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-sm text-secondary-foreground hover:bg-secondary/80 whitespace-nowrap"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  Scan VIN
                </button>
                <button
                  type="button"
                  onClick={() => void decodeVin()}
                  disabled={decoding || !values.vin.trim()}
                  className="rounded-md border border-border bg-secondary px-3 py-2 min-h-[44px] text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-60 whitespace-nowrap"
                >
                  {decoding ? "Decoding…" : "Decode VIN"}
                </button>
              </>
            )}
          </div>
          {isEdit && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              VIN cannot be changed after creation
            </p>
          )}
          {!isEdit && decodeMsg && <p className="mt-1.5 text-xs text-primary">{decodeMsg}</p>}
        </div>
        <Input
          label="Stock number"
          value={values.stock_number}
          onChange={(v) => dispatch({ type: "stock", value: v })}
        />
      </Section>

      {scannerOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 grid place-items-center bg-background/80">
              <div className="ds-surface p-4 text-sm font-medium">Opening VIN scanner…</div>
            </div>
          }
        >
          <VinScannerModal
            onClose={() => setScannerOpen(false)}
            onDetected={(vin) => {
              dispatch({ type: "vin", value: vin });
              setScannerOpen(false);
              setVinPulse(true);
              setTimeout(() => vinInputRef.current?.focus(), 0);
            }}
          />
        </Suspense>
      )}

      <Section
        title="Specifications"
        description="Review decoded details and fill in any gaps before saving."
      >
        <Input label="Year" type="number" value={values.year} onChange={(v) => set("year", v)} />
        <Input label="Make" value={values.make} onChange={(v) => set("make", v)} />
        <Input label="Model" value={values.model} onChange={(v) => set("model", v)} />
        <Input label="Trim" value={values.trim} onChange={(v) => set("trim", v)} />
        <Input label="Series" value={values.series} onChange={(v) => set("series", v)} />
        <Input
          label="Body class"
          value={values.body_class}
          onChange={(v) => set("body_class", v)}
        />
        <Input label="Engine" value={values.engine} onChange={(v) => set("engine", v)} />
        <Input
          label="Cylinders"
          type="number"
          value={values.cylinders}
          onChange={(v) => set("cylinders", v)}
        />
        <Input
          label="Transmission"
          value={values.transmission}
          onChange={(v) => set("transmission", v)}
        />
        <Input
          label="Drivetrain"
          value={values.drivetrain}
          onChange={(v) => set("drivetrain", v)}
        />
        <Input label="Fuel type" value={values.fuel_type} onChange={(v) => set("fuel_type", v)} />
        <Input
          label="Exterior color"
          value={values.exterior_color}
          onChange={(v) => set("exterior_color", v)}
        />
        <Input
          label="Interior color"
          value={values.interior_color}
          onChange={(v) => set("interior_color", v)}
        />
        <Input
          label="Odometer (mi)"
          type="number"
          value={values.odometer}
          onChange={(v) => set("odometer", v)}
          error={fieldErrors.odometer}
        />
        <Input
          label="Internet price (USD)"
          type="number"
          value={values.price}
          onChange={(v) => set("price", v)}
          error={fieldErrors.price}
        />
      </Section>

      <Section
        title="Merchandising & pricing"
        description="Keep consumer-facing copy separate from internal operating notes."
      >
        <Input
          label="MSRP (USD)"
          type="number"
          value={values.msrp}
          onChange={(v) => set("msrp", v)}
        />
        <Input
          label="Sale price (USD)"
          type="number"
          value={values.sale_price}
          onChange={(v) => set("sale_price", v)}
        />
        <Input
          label="Price description"
          value={values.price_description}
          onChange={(v) => set("price_description", v)}
        />
        <Input label="Category" value={values.category} onChange={(v) => set("category", v)} />
        <Input
          label="Warranty type"
          value={values.warranty_type}
          onChange={(v) => set("warranty_type", v)}
        />
        <Input label="Tagline" value={values.tagline} onChange={(v) => set("tagline", v)} />
        <TextArea label="Comments" value={values.comments} onChange={(v) => set("comments", v)} />
        <TextArea
          label="Custom comments"
          value={values.custom_comments}
          onChange={(v) => set("custom_comments", v)}
        />
        <TextArea
          label="Publication description"
          value={values.publication_description}
          onChange={(v) => set("publication_description", v)}
        />
        <TextArea
          label="Internal notes — never published"
          value={values.internal_notes}
          onChange={(v) => set("internal_notes", v)}
        />
      </Section>

      <Section
        title="Retail status"
        description="Set the sales condition and current inventory state."
      >
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">
            Inventory type
          </label>
          <ProductSelect
            value={values.inventory_type}
            onValueChange={(value) =>
              set("inventory_type", value as VehicleFormValues["inventory_type"])
            }
            ariaLabel="Inventory type"
            options={[
              { value: "new", label: "New" },
              { value: "used", label: "Used" },
              { value: "certified", label: "Certified" },
            ]}
          />
        </div>
        <Input
          label="Inventory arrival date"
          type="date"
          value={values.inventory_arrival_date}
          onChange={(value) => set("inventory_arrival_date", value)}
        />
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Condition</label>
          <ProductSelect
            value={values.condition}
            onValueChange={(value) => set("condition", value)}
            ariaLabel="Condition"
            options={CONDITIONS.map((condition) => ({ value: condition, label: condition }))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Status</label>
          <ProductSelect
            value={values.status}
            onValueChange={(value) => set("status", value)}
            ariaLabel="Status"
            options={STATUSES.map((status) => ({ value: status, label: status }))}
          />
        </div>
      </Section>

      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-border pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="w-full sm:w-auto px-4 py-2 min-h-[44px] text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="w-full sm:w-auto rounded-md bg-primary px-4 py-2 min-h-[44px] text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : vehicleId ? "Save changes" : (submitLabel ?? "Create vehicle")}
        </button>
      </div>
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="rounded-lg border border-border bg-secondary/20 p-4 sm:p-5">
      <legend className="px-1 text-sm font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </legend>
      {description && <p className="mb-4 text-xs leading-5 text-muted-foreground">{description}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  error?: string;
}) {
  const id = `vehicle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-card-foreground mb-1.5">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`form-input bg-card ${error ? "border-destructive" : ""}`}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `vehicle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="sm:col-span-2 lg:col-span-3">
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-card-foreground">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="form-input resize-y bg-card"
      />
    </div>
  );
}
