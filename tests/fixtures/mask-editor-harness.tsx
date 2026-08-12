import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MaskEditor } from "../../src/components/MaskEditor";
import "../../src/styles.css";

function createFixtures() {
  const width = 1200;
  const height = 800;
  const original = document.createElement("canvas");
  original.width = width;
  original.height = height;
  const source = original.getContext("2d")!;
  source.fillStyle = "#a7c9df";
  source.fillRect(0, 0, width, 470);
  source.fillStyle = "#6f786d";
  source.fillRect(0, 470, width, 330);

  // CASE A: a green retained background object behind the vehicle.
  source.fillStyle = "#2f684c";
  source.fillRect(925, 230, 120, 310);

  // A simple deterministic vehicle silhouette.
  source.fillStyle = "#b21f2d";
  source.beginPath();
  source.moveTo(180, 535);
  source.lineTo(290, 390);
  source.lineTo(720, 360);
  source.lineTo(895, 525);
  source.lineTo(920, 620);
  source.lineTo(160, 620);
  source.closePath();
  source.fill();
  source.fillStyle = "#2e3947";
  source.fillRect(350, 410, 320, 105);
  source.fillStyle = "#1f252c";
  source.beginPath();
  source.arc(315, 620, 78, 0, Math.PI * 2);
  source.arc(770, 620, 78, 0, Math.PI * 2);
  source.fill();

  const cutout = document.createElement("canvas");
  cutout.width = width;
  cutout.height = height;
  const mask = cutout.getContext("2d")!;
  mask.clearRect(0, 0, width, height);
  mask.fillStyle = "#fff";
  mask.beginPath();
  mask.moveTo(180, 535);
  mask.lineTo(290, 390);
  mask.lineTo(720, 360);
  mask.lineTo(895, 525);
  mask.lineTo(920, 620);
  mask.lineTo(160, 620);
  mask.closePath();
  mask.fill();
  mask.beginPath();
  mask.arc(315, 620, 78, 0, Math.PI * 2);
  mask.arc(770, 620, 78, 0, Math.PI * 2);
  mask.fill();
  mask.fillRect(925, 230, 120, 310);

  // CASE B: the mask incorrectly removes part of the vehicle roof.
  mask.globalCompositeOperation = "destination-out";
  mask.fillRect(620, 350, 105, 95);
  mask.globalCompositeOperation = "source-over";

  // CASE C is the transparent border surrounding the silhouette.
  return { originalUrl: original.toDataURL("image/png"), cutoutUrl: cutout.toDataURL("image/png") };
}

export function Harness() {
  const fixtures = useMemo(createFixtures, []);
  const [open, setOpen] = useState(true);
  const [appliedBytes, setAppliedBytes] = useState(0);
  return (
    <main className="min-h-dvh bg-background p-6 text-foreground">
      <h1 className="text-xl font-semibold">Mask editor visual fixture</h1>
      <p data-testid="harness-status" className="mt-2 text-sm text-muted-foreground">
        {appliedBytes ? `Applied ${appliedBytes} bytes` : "Waiting for mask application"}
      </p>
      <button
        className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground"
        onClick={() => setOpen(true)}
      >
        Reopen Fix Cutout
      </button>
      <MaskEditor
        {...fixtures}
        open={open}
        onOpenChange={setOpen}
        onApply={(blob) => setAppliedBytes(blob.size)}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
