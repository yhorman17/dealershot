import { useState, useRef, useEffect, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CONDITIONS, STATUSES } from "@/lib/vehicle-options";
import { VinScannerModal } from "@/components/VinScannerModal";
import { toast } from "sonner";

export type VehicleFormValues = {
  vin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  body_class: string;
  engine: string;
  cylinders: string;
  transmission: string;
  drivetrain: string;
  fuel_type: string;
  exterior_color: string;
  interior_color: string;
  odometer: string;
  price: string;
  stock_number: string;
  condition: string;
  status: string;
};

export const emptyVehicleValues: VehicleFormValues = {
  vin: "",
  year: "",
  make: "",
  model: "",
  trim: "",
  body_class: "",
  engine: "",
  cylinders: "",
  transmission: "",
  drivetrain: "",
  fuel_type: "",
  exterior_color: "",
  interior_color: "",
  odometer: "",
  price: "",
  stock_number: "",
  condition: "Used",
  status: "Available",
};

export function VehicleForm({
  initial,
  dealershipId,
  vehicleId,
  onSaved,
  onCancel,
}: {
  initial?: VehicleFormValues;
  dealershipId: string;
  vehicleId?: string;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const isEdit = Boolean(vehicleId);
  const [values, setValues] = useState<VehicleFormValues>(initial || emptyVehicleValues);
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
    setValues((p) => ({ ...p, [k]: v }));

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
      setValues((p) => ({
        ...p,
        year: r.ModelYear || p.year,
        make: r.Make || p.make,
        model: r.Model || p.model,
        trim: r.Trim || p.trim,
        body_class: r.BodyClass || p.body_class,
        engine: r.EngineModel || r.DisplacementL || p.engine,
        cylinders: r.EngineCylinders || p.cylinders,
        transmission: r.TransmissionStyle || p.transmission,
        drivetrain: r.DriveType || p.drivetrain,
        fuel_type: r.FuelTypePrimary || p.fuel_type,
      }));
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
    if (values.odometer.trim() === "" || isNaN(Number(values.odometer)))
      fe.odometer = "Enter a valid number";
    if (values.price.trim() === "" || isNaN(Number(values.price)))
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
        stock_number: values.stock_number.trim() || null,
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
        onSaved(vehicleId);
      } else {
        const { data, error: insErr } = await supabase
          .from("vehicles")
          .insert({ ...basePayload, dealership_id: dealershipId, vin: values.vin.trim() || null })
          .select("id")
          .single();
        if (insErr) throw insErr;
        onSaved(data.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Section title="Vehicle identification">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-card-foreground mb-1.5">VIN</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              ref={vinInputRef}
              value={values.vin}
              onChange={(e) => set("vin", e.target.value.toUpperCase())}
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
          onChange={(v) => set("stock_number", v)}
        />
      </Section>

      {scannerOpen && (
        <VinScannerModal
          onClose={() => setScannerOpen(false)}
          onDetected={(vin) => {
            set("vin", vin);
            setScannerOpen(false);
            setVinPulse(true);
            setTimeout(() => vinInputRef.current?.focus(), 0);
          }}
        />
      )}

      <Section title="Specs">
        <Input label="Year" type="number" value={values.year} onChange={(v) => set("year", v)} />
        <Input label="Make" value={values.make} onChange={(v) => set("make", v)} />
        <Input label="Model" value={values.model} onChange={(v) => set("model", v)} />
        <Input label="Trim" value={values.trim} onChange={(v) => set("trim", v)} />
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
          label="Price (USD)"
          type="number"
          value={values.price}
          onChange={(v) => set("price", v)}
          error={fieldErrors.price}
        />
      </Section>

      <Section title="Status">
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Condition</label>
          <select
            value={values.condition}
            onChange={(e) => set("condition", e.target.value)}
            className="form-input"
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-card-foreground mb-1.5">Status</label>
          <select
            value={values.status}
            onChange={(e) => set("status", e.target.value)}
            className="form-input"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
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
          {saving ? "Saving…" : vehicleId ? "Save changes" : "Create vehicle"}
        </button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-3">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{children}</div>
    </div>
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
  return (
    <div>
      <label className="block text-xs font-medium text-card-foreground mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`form-input ${error ? "border-destructive" : ""}`}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
