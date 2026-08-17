import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Plus, Save, Settings2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, ProductSelect, StatusBadge } from "@/components/product-ui";
import { useAccessibleDealerships } from "@/hooks/use-accessible-dealerships";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Store settings — DealerShot" }] }),
  component: SettingsPage,
});

type ReadinessRule = Database["public"]["Tables"]["readiness_rules"]["Row"];
type ShotRequirement = Database["public"]["Tables"]["photo_shot_requirements"]["Row"];
type ProcessingRule = Database["public"]["Tables"]["media_processing_rules"]["Row"];
type DocumentRequirement = Database["public"]["Tables"]["document_requirements"]["Row"];
type PayoutRule = Database["public"]["Tables"]["payout_rules"]["Row"];

const VEHICLE_TYPES = ["new", "used", "certified"];
const PROCESSING_CATEGORIES = [
  "exterior",
  "interior",
  "detail",
  "odometer",
  "vin",
  "document",
  "misc",
] as const;

function SettingsPage() {
  const { profile } = useAuth();
  const { dealerships, selectedDealership, selectedDealershipId, setSelectedDealershipId } =
    useAccessibleDealerships();
  const [loadingAccess, setLoadingAccess] = useState(profile?.role === "staff");
  const [canManageSettings, setCanManageSettings] = useState(profile?.role !== "staff");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessRule[]>([]);
  const [shots, setShots] = useState<ShotRequirement[]>([]);
  const [completionPolicy, setCompletionPolicy] = useState<"block" | "warn">("warn");
  const [processing, setProcessing] = useState<ProcessingRule[]>([]);
  const [documents, setDocuments] = useState<DocumentRequirement[]>([]);
  const [payoutRules, setPayoutRules] = useState<PayoutRule[]>([]);

  useEffect(() => {
    if (!profile) {
      setCanManageSettings(false);
      setLoadingAccess(false);
      return;
    }
    if (profile.role !== "staff") {
      setCanManageSettings(true);
      setLoadingAccess(false);
      return;
    }
    if (!selectedDealershipId) {
      setCanManageSettings(false);
      setLoadingAccess(false);
      return;
    }

    let cancelled = false;
    setLoadingAccess(true);
    void supabase
      .from("profile_dealerships")
      .select("access_role")
      .eq("profile_id", profile.id)
      .eq("dealership_id", selectedDealershipId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setCanManageSettings(data?.access_role === "store_manager");
        setLoadingAccess(false);
      });

    return () => {
      cancelled = true;
    };
  }, [profile, selectedDealershipId]);

  const load = useCallback(async () => {
    if (!selectedDealershipId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [
      readinessResult,
      shotResult,
      photoSettingsResult,
      processingResult,
      documentResult,
      payoutResult,
    ] = await Promise.all([
      supabase
        .from("readiness_rules")
        .select("*")
        .eq("dealership_id", selectedDealershipId)
        .order("sort_order"),
      supabase
        .from("photo_shot_requirements")
        .select("*")
        .eq("dealership_id", selectedDealershipId)
        .order("sort_order"),
      supabase
        .from("photography_settings")
        .select("completion_policy")
        .eq("dealership_id", selectedDealershipId)
        .maybeSingle(),
      supabase
        .from("media_processing_rules")
        .select("*")
        .eq("dealership_id", selectedDealershipId)
        .order("media_category"),
      supabase
        .from("document_requirements")
        .select("*")
        .eq("dealership_id", selectedDealershipId)
        .order("document_type"),
      supabase
        .from("payout_rules")
        .select("*")
        .eq("dealership_id", selectedDealershipId)
        .order("created_at", { ascending: false }),
    ]);
    const error = [
      readinessResult,
      shotResult,
      photoSettingsResult,
      processingResult,
      documentResult,
      payoutResult,
    ]
      .map((result) => result.error)
      .find(Boolean);
    if (error) {
      toast.error("Store settings could not be loaded", { description: error.message });
    } else {
      setReadiness(readinessResult.data ?? []);
      setShots(shotResult.data ?? []);
      setCompletionPolicy(photoSettingsResult.data?.completion_policy ?? "warn");
      setProcessing(processingResult.data ?? []);
      setDocuments(documentResult.data ?? []);
      setPayoutRules(payoutResult.data ?? []);
    }
    setLoading(false);
  }, [selectedDealershipId]);

  useEffect(() => void load(), [load]);

  const runSave = async (
    section: string,
    request: () => PromiseLike<{ error: { message: string } | null }>,
  ) => {
    setSaving(section);
    const { error } = await request();
    setSaving(null);
    if (error) {
      toast.error(`${section} settings were not saved`, { description: error.message });
      return false;
    }
    toast.success(`${section} settings saved`, {
      description: "Affected inventory is being evaluated with the new store rules.",
    });
    await load();
    return true;
  };

  const storePicker = (
    <ProductSelect
      value={selectedDealershipId ?? ""}
      onValueChange={setSelectedDealershipId}
      options={dealerships.map((item) => ({ value: item.id, label: item.name }))}
      placeholder="Select a store"
      className="w-full sm:w-64"
      ariaLabel="Store to configure"
    />
  );

  if (loadingAccess) {
    return (
      <main className="ds-page-gutter">
        <div className="ds-surface p-8 text-sm text-muted-foreground" aria-busy="true">
          Checking store-settings access…
        </div>
      </main>
    );
  }

  if (!canManageSettings) {
    return (
      <main className="ds-page-gutter">
        <PageHeader
          eyebrow="Store configuration"
          title="Settings access required"
          description="Your dealership role does not include permission to change store configuration."
          actions={
            <Button asChild variant="outline">
              <Link to="/dashboard">Back to overview</Link>
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <main className="ds-page-gutter">
      <PageHeader
        eyebrow="Store configuration"
        title="Operational settings"
        description="Define what Retail Ready means for this rooftop, what photographers must capture, and how completed work is paid."
        actions={storePicker}
      />

      {!selectedDealershipId ? (
        <div className="ds-surface p-8 text-sm text-muted-foreground">
          No configurable store is available for this account.
        </div>
      ) : loading ? (
        <div className="ds-surface p-8 text-sm text-muted-foreground" aria-busy="true">
          Loading {selectedDealership?.name ?? "store"} settings…
        </div>
      ) : (
        <Tabs defaultValue="readiness" className="space-y-5">
          <TabsList className="h-auto w-full justify-start overflow-x-auto bg-secondary p-1">
            <TabsTrigger value="readiness" className="min-h-10">
              Retail Readiness
            </TabsTrigger>
            <TabsTrigger value="photography" className="min-h-10">
              Photography
            </TabsTrigger>
            <TabsTrigger value="processing" className="min-h-10">
              Media Processing
            </TabsTrigger>
            <TabsTrigger value="documents" className="min-h-10">
              Documents
            </TabsTrigger>
            <TabsTrigger value="payouts" className="min-h-10">
              Payout Rules
            </TabsTrigger>
          </TabsList>

          <TabsContent value="readiness">
            <SettingsCard
              title="Retail Ready requirements"
              description="Turn checks on only when this store requires them before a vehicle can be fully merchandised."
            >
              <div className="divide-y divide-border">
                {readiness.map((rule) => (
                  <RuleToggle
                    key={rule.id}
                    label={readinessCopy(rule.rule_key, rule.label)}
                    description={readinessDescription(rule.rule_key)}
                    checked={rule.enabled}
                    onCheckedChange={(enabled) =>
                      setReadiness((items) =>
                        items.map((item) => (item.id === rule.id ? { ...item, enabled } : item)),
                      )
                    }
                  >
                    {rule.rule_key === "media.minimum_photos" ? (
                      <div className="flex items-center gap-2">
                        <Label htmlFor="minimum-photos" className="text-xs text-muted-foreground">
                          Minimum photos
                        </Label>
                        <Input
                          id="minimum-photos"
                          type="number"
                          min={0}
                          max={200}
                          value={Number(asObject(rule.config).minimum ?? 1)}
                          onChange={(event) =>
                            setReadiness((items) =>
                              items.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      config: {
                                        ...asObject(item.config),
                                        minimum: Number(event.target.value),
                                      },
                                    }
                                  : item,
                              ),
                            )
                          }
                          className="h-10 w-24"
                        />
                      </div>
                    ) : null}
                  </RuleToggle>
                ))}
              </div>
              <SaveBar
                saving={saving === "Retail Readiness"}
                onSave={() =>
                  void runSave("Retail Readiness", () =>
                    supabase.rpc("save_readiness_configuration", {
                      _dealership_id: selectedDealershipId,
                      _rules: readiness.map((rule) => ({
                        key: rule.rule_key,
                        label: rule.label,
                        severity: rule.severity,
                        enabled: rule.enabled,
                        applies_to: rule.applies_to,
                        config: rule.config,
                        sort_order: rule.sort_order,
                      })) as unknown as Json,
                    }),
                  )
                }
              />
            </SettingsCard>
          </TabsContent>

          <TabsContent value="photography">
            <SettingsCard
              title="Required shot list"
              description="This ordered checklist is shown during guided capture. Existing shoots keep the snapshot they started with."
            >
              <div className="border-b border-border p-4 sm:flex sm:items-center sm:justify-between">
                <div>
                  <Label htmlFor="completion-policy">When required shots are missing</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose whether Finish Photos is blocked or allowed with a clear warning.
                  </p>
                </div>
                <ProductSelect
                  id="completion-policy"
                  value={completionPolicy}
                  onValueChange={(value) => setCompletionPolicy(value as "block" | "warn")}
                  options={[
                    { value: "block", label: "Block completion" },
                    { value: "warn", label: "Allow with warning" },
                  ]}
                  className="mt-3 sm:mt-0 sm:w-56"
                />
              </div>
              <div className="divide-y divide-border">
                {shots.map((shot, index) => (
                  <div
                    key={shot.id}
                    className="grid gap-3 p-4 lg:grid-cols-[6rem_minmax(12rem,1fr)_11rem_7rem_7rem_auto] lg:items-center"
                  >
                    <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                      Shot {index + 1}
                    </span>
                    <div>
                      <Input
                        aria-label={`Name for shot ${index + 1}`}
                        value={shot.label}
                        onChange={(event) =>
                          setShots((items) =>
                            items.map((item) =>
                              item.id === shot.id ? { ...item, label: event.target.value } : item,
                            ),
                          )
                        }
                        className="h-10"
                      />
                      <Input
                        aria-label={`Guidance for ${shot.label}`}
                        value={shot.guidance ?? ""}
                        onChange={(event) =>
                          setShots((items) =>
                            items.map((item) =>
                              item.id === shot.id
                                ? { ...item, guidance: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="Optional photographer guidance"
                        className="mt-2 h-9 text-xs"
                      />
                    </div>
                    <ProductSelect
                      value={shot.category}
                      onValueChange={(category) =>
                        setShots((items) =>
                          items.map((item) =>
                            item.id === shot.id
                              ? { ...item, category: category as ShotRequirement["category"] }
                              : item,
                          ),
                        )
                      }
                      options={["exterior", "interior", "detail", "odometer", "vin"].map(
                        (value) => ({ value, label: title(value) }),
                      )}
                      ariaLabel={`Category for ${shot.label}`}
                    />
                    <ToggleCompact
                      label="Enabled"
                      checked={shot.enabled}
                      onChange={(enabled) =>
                        setShots((items) =>
                          items.map((item) => (item.id === shot.id ? { ...item, enabled } : item)),
                        )
                      }
                    />
                    <ToggleCompact
                      label="Required"
                      checked={shot.required}
                      onChange={(required) =>
                        setShots((items) =>
                          items.map((item) => (item.id === shot.id ? { ...item, required } : item)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${shot.label}`}
                      onClick={() =>
                        setShots((items) => items.filter((item) => item.id !== shot.id))
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-3 border-t border-border p-4 sm:flex-row sm:justify-between">
                <Button
                  variant="outline"
                  onClick={() =>
                    setShots((items) => [...items, newShot(selectedDealershipId, items.length)])
                  }
                >
                  <Plus className="size-4" /> Add shot
                </Button>
                <Button
                  disabled={saving === "Photography" || shots.some((shot) => !shot.label.trim())}
                  onClick={() =>
                    void runSave("Photography", () =>
                      supabase.rpc("save_photography_configuration", {
                        _dealership_id: selectedDealershipId,
                        _completion_policy: completionPolicy,
                        _shots: shots.map((shot, index) => ({
                          shot_key: shot.shot_key,
                          label: shot.label.trim(),
                          guidance: shot.guidance,
                          category: shot.category,
                          required: shot.required,
                          enabled: shot.enabled,
                          minimum_count: shot.minimum_count,
                          applies_to: shot.applies_to,
                          sort_order: (index + 1) * 10,
                        })) as unknown as Json,
                      }),
                    )
                  }
                >
                  <Save className="size-4" />{" "}
                  {saving === "Photography" ? "Saving…" : "Save photography"}
                </Button>
              </div>
            </SettingsCard>
          </TabsContent>

          <TabsContent value="processing">
            <SettingsCard
              title="Media processing"
              description="Rules apply to newly captured media. Changing them does not silently reprocess existing inventory."
            >
              <div className="divide-y divide-border">
                {PROCESSING_CATEGORIES.map((category) => {
                  const rule = processing.find((item) => item.media_category === category);
                  if (!rule) return null;
                  return (
                    <div
                      key={category}
                      className="grid gap-3 p-4 sm:grid-cols-[minmax(10rem,1fr)_16rem_7rem] sm:items-center"
                    >
                      <div>
                        <p className="text-sm font-semibold">{title(category)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {processingDescription(category)}
                        </p>
                      </div>
                      <ProductSelect
                        value={rule.action}
                        onValueChange={(action) =>
                          setProcessing((items) =>
                            items.map((item) =>
                              item.id === rule.id
                                ? { ...item, action: action as ProcessingRule["action"] }
                                : item,
                            ),
                          )
                        }
                        options={processingOptions(category)}
                        ariaLabel={`Processing for ${category}`}
                      />
                      <ToggleCompact
                        label="Enabled"
                        checked={rule.enabled}
                        onChange={(enabled) =>
                          setProcessing((items) =>
                            items.map((item) =>
                              item.id === rule.id ? { ...item, enabled } : item,
                            ),
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-border bg-secondary/35 p-4 text-xs leading-5 text-muted-foreground">
                Enhancement and automated background workflows remain unavailable until a durable
                processing provider is configured. DealerShot will not pretend those modes are live.
              </div>
              <SaveBar
                saving={saving === "Media Processing"}
                onSave={() =>
                  void runSave("Media Processing", () =>
                    supabase.rpc("save_media_processing_configuration", {
                      _dealership_id: selectedDealershipId,
                      _rules: processing.map((rule) => ({
                        media_category: rule.media_category,
                        action: rule.action,
                        enabled: rule.enabled,
                        priority: rule.priority,
                        config: rule.config,
                      })) as unknown as Json,
                    }),
                  )
                }
              />
            </SettingsCard>
          </TabsContent>

          <TabsContent value="documents">
            <SettingsCard
              title="Document requirements"
              description="New, used, and certified vehicles are configured separately. Technical templates still require dealership and legal approval before production use."
            >
              <div className="divide-y divide-border">
                {documents.map((document) => (
                  <div
                    key={document.document_type}
                    className="grid gap-4 p-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(15rem,1fr)_7rem_7rem] lg:items-center"
                  >
                    <div>
                      <p className="text-sm font-semibold">
                        {documentName(document.document_type)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Store-specific printable document.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {VEHICLE_TYPES.map((vehicleType) => (
                        <button
                          key={vehicleType}
                          type="button"
                          onClick={() =>
                            setDocuments((items) =>
                              items.map((item) =>
                                item.document_type === document.document_type
                                  ? {
                                      ...item,
                                      applies_to: toggleArray(item.applies_to, vehicleType),
                                    }
                                  : item,
                              ),
                            )
                          }
                          className={`min-h-9 rounded-md border px-3 text-xs font-semibold ${document.applies_to.includes(vehicleType) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                        >
                          {title(vehicleType)}
                        </button>
                      ))}
                    </div>
                    <ToggleCompact
                      label="Enabled"
                      checked={document.enabled}
                      onChange={(enabled) =>
                        setDocuments((items) =>
                          items.map((item) =>
                            item.document_type === document.document_type
                              ? { ...item, enabled }
                              : item,
                          ),
                        )
                      }
                    />
                    <ToggleCompact
                      label="Required"
                      checked={document.required}
                      onChange={(required) =>
                        setDocuments((items) =>
                          items.map((item) =>
                            item.document_type === document.document_type
                              ? { ...item, required }
                              : item,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
              </div>
              <SaveBar
                saving={saving === "Documents"}
                onSave={() =>
                  void runSave("Documents", () =>
                    supabase.rpc("save_document_requirements", {
                      _dealership_id: selectedDealershipId,
                      _requirements: documents.map((item) => ({
                        document_type: item.document_type,
                        enabled: item.enabled,
                        required: item.required,
                        applies_to: item.applies_to.length ? item.applies_to : ["used"],
                      })) as unknown as Json,
                    }),
                  )
                }
              />
            </SettingsCard>
          </TabsContent>

          <TabsContent value="payouts">
            <PayoutSettings
              dealershipId={selectedDealershipId}
              rules={payoutRules}
              saving={saving}
              setSaving={setSaving}
              onChanged={load}
            />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

function PayoutSettings({
  dealershipId,
  rules,
  saving,
  setSaving,
  onChanged,
}: {
  dealershipId: string;
  rules: PayoutRule[];
  saving: string | null;
  setSaving: (value: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("Standard completed shoot");
  const [taskType, setTaskType] = useState<PayoutRule["task_type"]>("photo_shoot");
  const [amount, setAmount] = useState("0.00");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const active = useMemo(() => rules.filter((rule) => rule.active), [rules]);

  const create = async () => {
    setSaving("Payout Rules");
    const { error } = await supabase.rpc("create_payout_rule", {
      _dealership_id: dealershipId,
      _name: name.trim(),
      _task_type: taskType,
      _amount: Number(amount),
      _effective_from: effectiveFrom,
      _config: {},
    });
    setSaving(null);
    if (error)
      return toast.error("Payout rule could not be created", { description: error.message });
    toast.success("Payout rule version created", {
      description: "Historical payout snapshots will not be changed.",
    });
    await onChanged();
  };
  const disable = async (ruleId: string) => {
    setSaving(ruleId);
    const { error } = await supabase.rpc("disable_payout_rule", { _rule_id: ruleId });
    setSaving(null);
    if (error)
      return toast.error("Payout rule could not be disabled", { description: error.message });
    toast.success("Payout rule disabled");
    await onChanged();
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(28rem,1.2fr)]">
      <SettingsCard
        title="Create a payout rule"
        description="A new version applies going forward. Existing and paid entries retain their original rule snapshot."
      >
        <div className="grid gap-4 p-4">
          <div>
            <Label htmlFor="payout-name">Rule name</Label>
            <Input
              id="payout-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1.5 h-11"
            />
          </div>
          <div>
            <Label htmlFor="payout-task">Completed work</Label>
            <ProductSelect
              id="payout-task"
              value={taskType}
              onValueChange={(value) => setTaskType(value as PayoutRule["task_type"])}
              options={[
                "photo_shoot",
                "video",
                "exterior_360",
                "interior_360",
                "reshoot",
                "audit",
              ].map((value) => ({ value, label: title(value) }))}
              className="mt-1.5"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="payout-amount">Amount</Label>
              <Input
                id="payout-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="mt-1.5 h-11"
              />
            </div>
            <div>
              <Label htmlFor="payout-effective">Effective date</Label>
              <Input
                id="payout-effective"
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                className="mt-1.5 h-11"
              />
            </div>
          </div>
          <Button
            disabled={saving === "Payout Rules" || !name.trim() || Number(amount) < 0}
            onClick={() => void create()}
          >
            <Plus className="size-4" /> Create rule version
          </Button>
        </div>
      </SettingsCard>
      <SettingsCard
        title="Rule history"
        description="Only active rules are used for new qualifying work. Versions remain visible for accounting traceability."
      >
        {rules.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No payout rules are configured. Payout generation remains disabled.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">{rule.name}</p>
                    <StatusBadge tone={rule.active ? "success" : "neutral"}>
                      {rule.active ? "Active" : "Inactive"}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {title(rule.task_type)} · ${Number(rule.amount).toFixed(2)} · version{" "}
                    {rule.version} · effective {rule.effective_from}
                  </p>
                </div>
                {rule.active ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving === rule.id}
                    onClick={() => void disable(rule.id)}
                  >
                    Disable
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {active.length === 0 ? (
          <div className="flex items-start gap-2 border-t border-warning/25 bg-warning/10 p-4 text-xs text-warning-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            No active payout rule. Completed work will still be recorded but no automatic payout
            will be created.
          </div>
        ) : null}
      </SettingsCard>
    </div>
  );
}

function SettingsCard({
  title: heading,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ds-surface overflow-hidden">
      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Settings2 className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold">{heading}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function RuleToggle({
  label,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-2xl">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {children}
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={`${label}: ${checked ? "required" : "not required"}`}
        />
      </div>
    </div>
  );
}

function ToggleCompact({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-2 text-xs font-medium text-muted-foreground sm:justify-start">
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
      {label}
    </label>
  );
}

function SaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <div className="flex justify-end border-t border-border p-4">
      <Button disabled={saving} onClick={onSave}>
        <Save className="size-4" />
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}

function newShot(dealershipId: string, index: number): ShotRequirement {
  const suffix = `${Date.now()}_${index}`;
  return {
    id: `new-${suffix}`,
    dealership_id: dealershipId,
    shot_key: `custom_${suffix}`,
    label: "",
    guidance: null,
    category: "detail",
    required: false,
    enabled: true,
    minimum_count: 1,
    applies_to: ["new", "used", "certified"],
    sort_order: (index + 1) * 10,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toggleArray(values: string[], value: string) {
  const next = values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
  return next.length ? next : values;
}

function processingOptions(category: string) {
  const options = [{ value: "keep_original", label: "Keep original" }];
  if (category === "exterior" || category === "interior")
    options.push({ value: "manual_review", label: "Manual review" });
  return options;
}

const readinessCopy = (key: string, fallback: string) =>
  ({
    "vehicle.vin": "Require a VIN",
    "vehicle.stock_number": "Require a stock number",
    "vehicle.price": "Require a retail price",
    "vehicle.comments": "Require merchandising comments",
    "vehicle.specifications": "Require verified vehicle specifications",
    "media.minimum_photos": "Require vehicle photos",
    "media.odometer": "Require an odometer photo",
    "media.vin": "Require a VIN photo",
    "media.video": "Require a vehicle video",
    "media.exterior_360": "Require an exterior 360",
    "media.interior_360": "Require an interior 360",
    "processing.completed": "Require configured media processing to finish",
    "processing.review_approved": "Require processed media approval",
    "processing.no_failures": "Block Retail Ready when processing fails",
  })[key] ?? fallback;

const readinessDescription = (key: string) =>
  ({
    "vehicle.vin": "Vehicle identity must be available before the unit is Retail Ready.",
    "vehicle.stock_number": "The store stock number must be present.",
    "vehicle.price": "A vehicle without a price remains in Needs Attention.",
    "vehicle.comments":
      "Used and certified inventory must have consumer-facing merchandising copy.",
    "vehicle.specifications":
      "At least one verified equipment or specification record is required.",
    "media.minimum_photos":
      "Set a conservative minimum; the required shot list provides the detailed completeness check.",
    "processing.no_failures":
      "A visible failed job blocks readiness until it is retried or resolved.",
  })[key] ?? "Apply this store requirement during the shared Retail Ready evaluation.";

const processingDescription = (category: string) =>
  category === "exterior"
    ? "Choose original preservation or send new exterior media to the manual preparation queue."
    : "Originals remain immutable; unsupported automated modes are unavailable.";
const documentName = (value: string) => (value === "buyers_guide" ? "Buyer’s Guide" : title(value));
const title = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
