import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Plus, RadioTower, RefreshCw } from "lucide-react";
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
import { EmptyState, StatusBadge } from "@/components/product-ui";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { formatMiles, formatPrice } from "@/lib/vehicle-options";
import {
  parseReadinessReasons,
  readinessLabel,
  type ReadinessStatus,
} from "@/lib/retail-readiness";

type Vehicle = Database["public"]["Tables"]["vehicles"]["Row"];
type Equipment = Database["public"]["Tables"]["vehicle_equipment"]["Row"];
type GeneratedDocument = Database["public"]["Tables"]["generated_documents"]["Row"];
type Activity = Database["public"]["Tables"]["activity_events"]["Row"];
type Publication = Database["public"]["Tables"]["vehicle_publications"]["Row"];
type Connection = Database["public"]["Tables"]["integration_connections"]["Row"];

export function VehicleOperationsPanel({
  section,
  vehicle,
}: {
  section: "overview" | "equipment" | "pricing" | "documents" | "activity" | "publishing";
  vehicle: Vehicle;
}) {
  if (section === "overview") return <Overview vehicle={vehicle} />;
  if (section === "equipment") return <EquipmentPanel vehicle={vehicle} />;
  if (section === "pricing") return <PricingPanel vehicle={vehicle} />;
  if (section === "documents") return <DocumentsPanel vehicle={vehicle} />;
  if (section === "activity") return <ActivityPanel vehicle={vehicle} />;
  return <PublishingPanel vehicle={vehicle} />;
}

function Overview({ vehicle }: { vehicle: Vehicle }) {
  const [readiness, setReadiness] = useState<{
    status: ReadinessStatus;
    reasons: unknown;
    photo_count: number;
    video_count: number;
    completed_document_count: number;
    evaluated_at: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void supabase
      .from("vehicle_readiness")
      .select("status, reasons, photo_count, video_count, completed_document_count, evaluated_at")
      .eq("vehicle_id", vehicle.id)
      .maybeSingle()
      .then(({ data }) => {
        setReadiness(data);
        setLoading(false);
      });
  }, [vehicle.id]);

  const reasons = parseReadinessReasons(readiness?.reasons);
  const status = readiness?.status ?? vehicle.retail_readiness_status;
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Retail readiness"
        description="The exact work preventing this vehicle from being fully merchandised."
      />
      <div className="grid gap-5 p-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-secondary/45 p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Current state
          </p>
          <p className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
            {loading ? "Evaluating…" : readinessLabel(status)}
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2 text-center text-xs">
            <Count label="Photos" value={readiness?.photo_count ?? 0} />
            <Count label="Videos" value={readiness?.video_count ?? 0} />
            <Count label="Documents" value={readiness?.completed_document_count ?? 0} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Requirements</h3>
            <StatusBadge tone={readinessTone(status)}>{readinessLabel(status)}</StatusBadge>
          </div>
          {reasons.length === 0 ? (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-success/25 bg-success/10 p-4 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                <p className="font-semibold">Configured requirements satisfied</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  DealerShot will keep evaluating this vehicle as media, documents, pricing, and
                  review state change.
                </p>
              </div>
            </div>
          ) : (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {reasons.map((reason) => (
                <li
                  key={`${reason.key}-${reason.label}`}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
                >
                  <AlertCircle
                    className={
                      reason.severity === "blocked"
                        ? "mt-0.5 size-4 shrink-0 text-destructive"
                        : "mt-0.5 size-4 shrink-0 text-warning-foreground"
                    }
                  />
                  <div>
                    <p className="font-medium">{reason.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {reason.severity === "blocked" ? "Blocks Retail Ready" : "Needs attention"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function EquipmentPanel({ vehicle }: { vehicle: Vehicle }) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [category, setCategory] = useState<Equipment["category"]>("safety");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => {
    void supabase
      .from("vehicle_equipment")
      .select("*")
      .eq("vehicle_id", vehicle.id)
      .order("category")
      .order("sort_order")
      .then(({ data }) => setItems(data ?? []));
  };
  useEffect(load, [vehicle.id]);
  const groups = useMemo(() => {
    const result = new Map<Equipment["category"], Equipment[]>();
    items.forEach((item) => {
      result.set(item.category, [...(result.get(item.category) ?? []), item]);
    });
    return result;
  }, [items]);
  const addFeature = async () => {
    if (!label.trim() || saving) return;
    setSaving(true);
    const { error } = await supabase.from("vehicle_equipment").insert({
      vehicle_id: vehicle.id,
      category,
      label: label.trim(),
      source: "manual",
    });
    setSaving(false);
    if (error) {
      toast.error("Feature could not be added", { description: error.message });
      return;
    }
    setLabel("");
    load();
  };
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Equipment & features"
        description="Provider-independent vehicle specifications grouped for merchandising and documents."
      />
      <div className="border-b border-border p-4 sm:flex sm:items-center sm:gap-2">
        <Select
          value={category}
          onValueChange={(value) => setCategory(value as Equipment["category"])}
        >
          <SelectTrigger className="h-11 sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["safety", "interior", "exterior", "mechanical", "entertainment", "convenience"].map(
              (value) => (
                <SelectItem key={value} value={value}>
                  {title(value)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Add a feature"
          className="mt-2 h-11 sm:mt-0"
          onKeyDown={(event) => {
            if (event.key === "Enter") void addFeature();
          }}
        />
        <Button
          className="mt-2 h-11 w-full sm:mt-0 sm:w-auto"
          disabled={!label.trim() || saving}
          onClick={() => void addFeature()}
        >
          <Plus className="size-4" /> Add
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          title="No structured equipment yet"
          description="Add verified equipment manually now, or populate it later through a configured VehicleDataProvider."
        />
      ) : (
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
          {[...groups.entries()].map(([group, features]) => (
            <div key={group} className="bg-card p-5">
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {title(group)}
              </h3>
              <ul className="mt-3 space-y-2 text-sm">
                {features.map((feature) => (
                  <li key={feature.id} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>
                      {feature.label}
                      {feature.value ? ` — ${feature.value}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PricingPanel({ vehicle }: { vehicle: Vehicle }) {
  const prices = [
    ["MSRP", vehicle.msrp],
    ["Internet price", vehicle.internet_price ?? vehicle.price],
    ["Sale price", vehicle.sale_price],
  ] as const;
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Pricing & merchandising copy"
        description="Consumer-facing values remain separate from internal notes and import metadata."
      />
      <div className="grid gap-px bg-border sm:grid-cols-3">
        {prices.map(([label, value]) => (
          <div key={label} className="bg-card p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{formatPrice(value)}</p>
          </div>
        ))}
      </div>
      <dl className="grid sm:grid-cols-2">
        <TextFact label="Price description" value={vehicle.price_description} />
        <TextFact label="Tagline" value={vehicle.tagline} />
        <TextFact label="Comments" value={vehicle.comments} />
        <TextFact label="Custom comments" value={vehicle.custom_comments} />
        <TextFact label="Publication description" value={vehicle.publication_description} />
        <TextFact label="Internal notes — never published" value={vehicle.internal_notes} />
      </dl>
    </section>
  );
}

function DocumentsPanel({ vehicle }: { vehicle: Vehicle }) {
  const [documents, setDocuments] = useState<GeneratedDocument[]>([]);
  const [generating, setGenerating] = useState<string | null>(null);
  const load = () => {
    void supabase
      .from("generated_documents")
      .select("*")
      .eq("vehicle_id", vehicle.id)
      .eq("status", "generated")
      .order("generated_at", { ascending: false })
      .then(({ data }) => setDocuments(data ?? []));
  };
  useEffect(load, [vehicle.id]);
  const types = ["window_sticker", "buyers_guide", "addendum", "cpo_sheet", "placard"] as const;
  const generate = async (documentType: (typeof types)[number]) => {
    setGenerating(documentType);
    const { error } = await supabase.rpc("generate_vehicle_document", {
      _vehicle_id: vehicle.id,
      _document_type: documentType,
    });
    setGenerating(null);
    if (error) {
      toast.error("Document could not be generated", { description: error.message });
      return;
    }
    toast.success(`${title(documentType)} generated`);
    load();
  };
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Vehicle documents"
        description="Versioned snapshots populate from current vehicle, store, equipment, and warranty data."
      />
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        {types.map((documentType) => {
          const latest = documents.find((item) => item.document_type === documentType);
          const usedOnly = ["window_sticker", "buyers_guide"].includes(documentType);
          const unavailable = usedOnly && vehicle.inventory_type === "new";
          return (
            <article key={documentType} className="bg-card p-5">
              <FileText className="size-5 text-primary" />
              <h3 className="mt-3 font-semibold">{title(documentType)}</h3>
              <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
                {documentType === "buyers_guide"
                  ? "Printable technical template. Final legal/FTC validation remains required."
                  : usedOnly
                    ? "Used and certified inventory document."
                    : "Reusable dealership document type."}
              </p>
              {latest ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Generated {new Date(latest.generated_at).toLocaleString()} · template v
                  {latest.template_version}
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">Not generated</p>
              )}
              <div className="mt-4 flex gap-2">
                {latest && (
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/vehicles/$id/documents/$documentId"
                      params={{ id: vehicle.id, documentId: latest.id }}
                    >
                      View / print
                    </Link>
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={unavailable || generating === documentType}
                  onClick={() => void generate(documentType)}
                >
                  {generating === documentType ? (
                    <RefreshCw className="size-4 animate-spin" />
                  ) : null}
                  {latest ? "Regenerate" : "Generate"}
                </Button>
              </div>
              {unavailable && (
                <p className="mt-2 text-xs text-warning-foreground">
                  Used-only document does not apply to new inventory.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ActivityPanel({ vehicle }: { vehicle: Vehicle }) {
  const [events, setEvents] = useState<Array<Activity & { actor?: string }>>([]);
  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("activity_events")
        .select("*")
        .eq("vehicle_id", vehicle.id)
        .order("occurred_at", { ascending: false })
        .limit(100);
      const base = data ?? [];
      const ids = [
        ...new Set(
          base.flatMap((event) => (event.actor_profile_id ? [event.actor_profile_id] : [])),
        ),
      ];
      const { data: profiles } = ids.length
        ? await supabase.from("profiles").select("id, full_name, email").in("id", ids)
        : { data: [] };
      const names = new Map(
        (profiles ?? []).map((profile) => [profile.id, profile.full_name || profile.email]),
      );
      setEvents(
        base.map((event) => ({
          ...event,
          actor: event.actor_profile_id ? names.get(event.actor_profile_id) : "System",
        })),
      );
    })();
  }, [vehicle.id]);
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Vehicle activity"
        description="Durable operational history for auditing, production, and support."
      />
      {events.length === 0 ? (
        <EmptyState
          title="No durable activity yet"
          description="Material inventory, shoot, document, review, and publication events will appear here."
        />
      ) : (
        <ol className="divide-y divide-border">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 p-4 sm:px-5">
              <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{event.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.actor || "System"} · {new Date(event.occurred_at).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PublishingPanel({ vehicle }: { vehicle: Vehicle }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  useEffect(() => {
    void Promise.all([
      supabase
        .from("integration_connections")
        .select("*")
        .eq("dealership_id", vehicle.dealership_id),
      supabase.from("vehicle_publications").select("*").eq("vehicle_id", vehicle.id),
    ]).then(([connectionsResult, publicationsResult]) => {
      setConnections(connectionsResult.data ?? []);
      setPublications(publicationsResult.data ?? []);
    });
  }, [vehicle.dealership_id, vehicle.id]);
  return (
    <section className="ds-surface overflow-hidden">
      <PanelHeader
        title="Publishing destinations"
        description="Provider-neutral status only. No dealership website API is claimed as connected."
      />
      {connections.length === 0 ? (
        <EmptyState
          icon={<RadioTower className="size-5" />}
          title="No publishing integration configured"
          description="The adapter and status foundation is ready, but dealership-provided API details are still required before inventory or media can publish."
        />
      ) : (
        <div className="divide-y divide-border">
          {connections.map((connection) => {
            const publication = publications.find(
              (item) => item.integration_connection_id === connection.id,
            );
            return (
              <div key={connection.id} className="flex items-center justify-between gap-4 p-5">
                <div>
                  <p className="font-semibold">{connection.display_name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {title(connection.provider_type)} · {connection.provider_key}
                  </p>
                </div>
                <StatusBadge
                  tone={
                    publication?.status === "published"
                      ? "success"
                      : connection.status === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {title(publication?.status ?? connection.status)}
                </StatusBadge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PanelHeader({ title: heading, description }: { title: string; description: string }) {
  return (
    <header className="border-b border-border px-5 py-4">
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </header>
  );
}
function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
function TextFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="border-t border-border p-5 sm:odd:border-r">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-2 whitespace-pre-wrap text-sm leading-6">{value || "—"}</dd>
    </div>
  );
}
const title = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const readinessTone = (status: ReadinessStatus): "success" | "warning" | "danger" | "info" =>
  status === "retail_ready"
    ? "success"
    : status === "blocked"
      ? "danger"
      : status === "processing" || status === "awaiting_review"
        ? "info"
        : "warning";
