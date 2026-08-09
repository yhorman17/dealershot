import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type MediaAsset = {
  name: string;
  image_url: string;
};

export function MediaPreviewDialog({
  asset,
  kind,
  onClose,
}: {
  asset: MediaAsset | null;
  kind: "overlay" | "backdrop";
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>{asset?.name}</DialogTitle>
          <DialogDescription>
            {kind === "overlay"
              ? "Transparent areas are shown against a dark preview surface."
              : "Preview the approved backdrop at its natural proportions."}
          </DialogDescription>
        </DialogHeader>
        <div
          className={
            kind === "overlay"
              ? "flex min-h-72 items-center justify-center bg-[conic-gradient(at_top_left,_#1a1a2e,_#0f0f1a)] p-4 sm:p-8"
              : "flex min-h-72 items-center justify-center bg-secondary p-4 sm:p-8"
          }
        >
          {asset && (
            <img
              src={asset.image_url}
              alt={asset.name}
              className="max-h-[68dvh] max-w-full object-contain"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RenameMediaDialog({
  asset,
  kind,
  onClose,
  onSave,
}: {
  asset: MediaAsset | null;
  kind: "overlay" | "backdrop";
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(asset?.name ?? "");
    setError(null);
  }, [asset]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(nextName);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not rename this ${kind}.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename {kind}</DialogTitle>
          <DialogDescription>
            Update the label staff see when choosing this {kind}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`rename-${kind}`}>Name</Label>
            <Input
              id={`rename-${kind}`}
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
