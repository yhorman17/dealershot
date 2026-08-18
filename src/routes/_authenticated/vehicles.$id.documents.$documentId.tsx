import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/product-ui";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { formatMiles, formatPrice } from "@/lib/vehicle-options";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";

export const Route = createFileRoute("/_authenticated/vehicles/$id/documents/$documentId")({
  head: () => ({ meta: [{ title: "Print vehicle document — DealerShot" }] }),
  component: PrintableVehicleDocument,
});

type GeneratedDocument = Database["public"]["Tables"]["generated_documents"]["Row"];

function PrintableVehicleDocument() {
  const { id, documentId } = Route.useParams();
  const { setSelectedDealershipId } = useAccessibleDealerships();
  const [document, setDocument] = useState<GeneratedDocument | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void supabase
      .from("generated_documents")
      .select("*")
      .eq("id", documentId)
      .eq("vehicle_id", id)
      .maybeSingle()
      .then(({ data }) => {
        setDocument(data);
        setLoading(false);
      });
  }, [documentId, id]);
  useEffect(() => {
    if (document?.dealership_id) setSelectedDealershipId(document.dealership_id);
  }, [document?.dealership_id, setSelectedDealershipId]);
  if (loading) return <main className="ds-page-gutter">Loading document…</main>;
  if (!document)
    return (
      <main className="ds-page-gutter">
        <EmptyState
          title="Document not found"
          description="It may have been superseded or you may not have access to this vehicle."
        />
      </main>
    );
  const snapshot = object(document.vehicle_snapshot);
  const vehicle = object(snapshot.vehicle);
  const dealership = object(snapshot.dealership);
  const equipment = Array.isArray(snapshot.equipment) ? snapshot.equipment.map(object) : [];
  const warranty = object(snapshot.warranty);
  return (
    <main className="print-document mx-auto max-w-[8.5in] p-4 sm:p-8 print:max-w-none print:p-0">
      <div className="mb-5 flex items-center justify-between gap-3 print:hidden">
        <Button variant="outline" asChild>
          <Link to="/vehicles/$id" params={{ id }}>
            <ArrowLeft className="size-4" /> Vehicle workspace
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" /> Print
        </Button>
      </div>
      {document.stale_at ? (
        <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:hidden">
          <strong>This version is outdated.</strong> Vehicle or store data changed after it was
          generated. Return to the vehicle workspace and regenerate before printing.
        </div>
      ) : null}
      <article className="min-h-[10in] border border-border bg-white p-8 text-slate-950 shadow-sm print:min-h-0 print:border-0 print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-4 border-slate-900 pb-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em]">
              {text(dealership.name) || "DealerShot dealership"}
            </p>
            <h1 className="mt-2 text-4xl font-black tracking-tight">
              {title(document.document_type)}
            </h1>
          </div>
          <div className="text-right text-xs leading-5">
            <p>{text(dealership.address)}</p>
            <p>{text(dealership.phone)}</p>
            <p>{text(dealership.website)}</p>
          </div>
        </header>
        {document.document_type === "buyers_guide" ? (
          <BuyerGuide vehicle={vehicle} dealership={dealership} />
        ) : (
          <VehicleSheet vehicle={vehicle} equipment={equipment} warranty={warranty} />
        )}
        <footer className="mt-8 border-t border-slate-300 pt-3 text-[10px] text-slate-600">
          Generated {new Date(document.generated_at).toLocaleString()} · Template version{" "}
          {document.template_version} · Vehicle data snapshot
          {document.document_type === "buyers_guide" &&
            " · Technical template requires final legal/FTC validation before production use"}
        </footer>
      </article>
    </main>
  );
}

function VehicleSheet({
  vehicle,
  equipment,
  warranty,
}: {
  vehicle: Record<string, Json | undefined>;
  equipment: Array<Record<string, Json | undefined>>;
  warranty: Record<string, Json | undefined>;
}) {
  const titleText = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(" ");
  const facts = [
    ["VIN", vehicle.vin],
    ["Stock #", vehicle.stock_number],
    ["Mileage", number(vehicle.odometer) ? formatMiles(number(vehicle.odometer)) : "—"],
    ["Engine", vehicle.engine],
    ["Transmission", vehicle.transmission],
    ["Drivetrain", vehicle.drivetrain],
    ["Exterior", vehicle.exterior_color],
    ["Interior", vehicle.interior_color],
  ];
  return (
    <>
      <section className="py-8 text-center">
        <h2 className="text-3xl font-black tracking-tight">{titleText || "Vehicle information"}</h2>
        <p className="mt-3 text-4xl font-black">
          {formatPrice(
            number(vehicle.sale_price) ||
              number(vehicle.internet_price) ||
              number(vehicle.price) ||
              number(vehicle.msrp),
          )}
        </p>
        <p className="mt-2 text-sm text-slate-600">{text(vehicle.price_description)}</p>
      </section>
      <dl className="grid grid-cols-2 border border-slate-300 sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={String(label)} className="border-b border-r border-slate-300 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {String(label)}
            </dt>
            <dd className="mt-1 text-sm font-semibold">{text(value) || "—"}</dd>
          </div>
        ))}
      </dl>
      <section className="mt-7">
        <h3 className="border-b-2 border-slate-900 pb-2 text-lg font-black">
          Equipment & features
        </h3>
        {equipment.length ? (
          <div className="mt-4 columns-2 gap-8 text-sm sm:columns-3">
            {equipment.map((item, index) => (
              <p key={`${text(item.label)}-${index}`} className="mb-2 break-inside-avoid">
                • {text(item.label)}
                {item.value ? ` — ${text(item.value)}` : ""}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            No verified structured equipment is stored for this vehicle.
          </p>
        )}
      </section>
      {Object.keys(warranty).length > 0 && (
        <section className="mt-7">
          <h3 className="border-b-2 border-slate-900 pb-2 text-lg font-black">Warranty</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <p>
              Basic: {text(warranty.basic_years) || "—"} years / {text(warranty.basic_miles) || "—"}{" "}
              miles
            </p>
            <p>
              Drivetrain: {text(warranty.drivetrain_years) || "—"} years /{" "}
              {text(warranty.drivetrain_miles) || "—"} miles
            </p>
          </div>
        </section>
      )}
    </>
  );
}

function BuyerGuide({
  vehicle,
  dealership,
}: {
  vehicle: Record<string, Json | undefined>;
  dealership: Record<string, Json | undefined>;
}) {
  const hasDealerWarranty = text(vehicle.warranty_type).toLowerCase().includes("dealer");
  return (
    <div className="py-7">
      <p className="text-center text-sm font-bold uppercase">
        Important: Spoken promises are difficult to enforce. Ask the dealer to put all promises in
        writing.
      </p>
      <div className="mt-8 border-4 border-slate-950 p-6">
        <h2 className="text-2xl font-black">Warranty disclosure</h2>
        <div className="mt-5 space-y-5 text-lg">
          <p className="flex gap-3">
            <span className="text-2xl">{hasDealerWarranty ? "☐" : "☒"}</span>
            <span>
              <strong>AS IS — NO DEALER WARRANTY</strong>
              <br />
              <span className="text-sm">
                The dealer does not provide a warranty unless a completed, compliance-validated
                guide states otherwise.
              </span>
            </span>
          </p>
          <p className="flex gap-3">
            <span className="text-2xl">{hasDealerWarranty ? "☒" : "☐"}</span>
            <span>
              <strong>DEALER WARRANTY</strong>
              <br />
              <span className="text-sm">
                Terms must be completed and validated by the dealership before use.
              </span>
            </span>
          </p>
        </div>
      </div>
      <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
        <Fact
          label="Vehicle"
          value={[vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
            .filter(Boolean)
            .join(" ")}
        />
        <Fact label="VIN" value={text(vehicle.vin)} />
        <Fact label="Stock #" value={text(vehicle.stock_number)} />
        <Fact label="Dealer" value={text(dealership.name)} />
      </dl>
      <div className="mt-10 rounded border-2 border-dashed border-slate-400 p-4 text-sm">
        <strong>Compliance notice:</strong> DealerShot currently provides the technical
        data/template workflow only. Dealership counsel or the responsible compliance team must
        validate the final Buyer’s Guide wording, selections, language, and printing process.
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 font-semibold">{value || "—"}</dd>
    </div>
  );
}
function object(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value: Json | undefined): string {
  return value === null || value === undefined || typeof value === "object" ? "" : String(value);
}
function number(value: Json | undefined): number {
  return typeof value === "number" ? value : Number(value) || 0;
}
function title(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
