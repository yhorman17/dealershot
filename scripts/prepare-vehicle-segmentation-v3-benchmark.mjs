import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const definitions = [
  ["toyota_camry", "Toyota Camry", "Toyota", "sedan", "outdoor", "day"],
  ["honda_odyssey", "Honda Odyssey", "Honda", "minivan", "outdoor", "day"],
  ["ford_f150", "Ford F-150", "Ford", "truck", "outdoor", "day"],
  ["chevrolet_tahoe", "Chevrolet Tahoe", "Chevrolet", "SUV", "outdoor", "day"],
  ["volkswagen_tiguan", "Volkswagen Tiguan", "Volkswagen", "SUV", "showroom", "indoor"],
  ["bmw_3_series", "BMW 3 Series sedan", "BMW", "sedan", "showroom", "indoor"],
  ["mercedes_c_class", "Mercedes C-Class coupe", "Mercedes-Benz", "coupe", "showroom", "indoor"],
  ["audi_a4", "Audi A4 sedan", "Audi", "sedan", "outdoor", "overcast"],
  ["hyundai_sonata", "Hyundai Sonata", "Hyundai", "sedan", "outdoor", "day"],
  ["kia_carnival", "Kia Carnival", "Kia", "minivan", "outdoor", "day"],
  ["subaru_outback", "Subaru Outback", "Subaru", "wagon", "outdoor", "overcast"],
  ["nissan_370z", "Nissan 370Z", "Nissan", "coupe", "outdoor", "day"],
  ["jeep_grand_cherokee", "Jeep Grand Cherokee", "Jeep", "SUV", "outdoor", "day"],
  ["mazda_cx5", "Mazda CX-5", "Mazda", "SUV", "outdoor", "day"],
  ["porsche_911", "Porsche 911", "Porsche", "coupe", "showroom", "indoor"],
  ["tesla_model_3", "Tesla Model 3", "Tesla", "sedan", "outdoor", "day"],
  ["lexus_es", "Lexus ES sedan", "Lexus", "sedan", "showroom", "indoor"],
  ["volvo_v60", "Volvo V60 wagon", "Volvo", "wagon", "outdoor", "overcast"],
  ["land_rover_defender", "Land Rover Defender", "Land Rover", "SUV", "outdoor", "day"],
  ["gmc_sierra", "GMC Sierra", "GMC", "truck", "outdoor", "day"],
].map(([id, query, brand, bodyStyle, scene, lighting]) => ({
  id,
  query,
  brand,
  bodyStyle,
  scene,
  lighting,
  expectedEligibility: "FULL_VEHICLE",
}));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const outputDirectory = path.resolve(
  argument("--output-directory") ?? "vehicle-segmentation-v3-controlled-benchmark",
);
await mkdir(outputDirectory, { recursive: true });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, {
      headers: { "user-agent": "DealerShot-V3-benchmark/1.0 (controlled engineering experiment)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return response;
    if (response.status !== 429 || attempt === 5) return response;
    await wait(attempt * 2_000);
  }
  throw new Error("unreachable");
}

async function resolveFixture(definition) {
  const parameters = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "16",
    gsrsearch: `${definition.query} filetype:bitmap`,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1280",
  });
  const response = await fetchWithRetry(`https://commons.wikimedia.org/w/api.php?${parameters}`);
  if (!response.ok) throw new Error(`Wikimedia query failed for ${definition.id}.`);
  const payload = await response.json();
  const candidates = Object.values(payload.query?.pages ?? {})
    .map((page) => ({ page, image: page.imageinfo?.[0] }))
    .filter(({ page }) =>
      page.title.toLowerCase().includes(definition.brand.toLowerCase().split(/[ -]/)[0]),
    )
    .filter(({ image }) => {
      if (!image?.thumburl || !["image/jpeg", "image/png"].includes(image.mime)) return false;
      const ratio = image.width / Math.max(1, image.height);
      const license = image.extmetadata?.LicenseShortName?.value ?? "";
      return (
        image.width >= 900 && ratio >= 1.15 && ratio <= 2.35 && /CC|Public domain/i.test(license)
      );
    })
    .sort((left, right) => (left.page.index ?? 0) - (right.page.index ?? 0));
  let selected = null;
  let bytes = null;
  for (const candidate of candidates) {
    const imageResponse = await fetchWithRetry(candidate.image.thumburl);
    if (!imageResponse.ok) continue;
    selected = candidate;
    bytes = Buffer.from(await imageResponse.arrayBuffer());
    break;
  }
  if (!selected || !bytes)
    throw new Error(`No downloadable licensed fixture found for ${definition.id}.`);
  const normalized = await sharp(bytes).rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const filename = `${definition.id}.jpg`;
  await writeFile(path.join(outputDirectory, filename), normalized);
  return {
    ...definition,
    sourceType: "CONTROLLED_TEST_FIXTURE",
    filename,
    sourceTitle: selected.page.title,
    sourcePage: selected.image.descriptionurl,
    author: selected.image.extmetadata?.Artist?.value ?? "Wikimedia contributor",
    license: selected.image.extmetadata?.LicenseShortName?.value ?? "unknown",
    licenseUrl: selected.image.extmetadata?.LicenseUrl?.value ?? null,
    sourceWidth: selected.image.width,
    sourceHeight: selected.image.height,
  };
}

let existingFixtures = [];
try {
  existingFixtures = JSON.parse(
    await readFile(path.join(outputDirectory, "controlled-fixture-manifest.json"), "utf8"),
  ).fixtures;
} catch {
  // First preparation has no manifest to reuse.
}
const fixtures = [];
for (const definition of definitions) {
  const reusable = existingFixtures.find(
    (fixture) =>
      fixture.id === definition.id &&
      fixture.sourceTitle.toLowerCase().includes(definition.brand.toLowerCase().split(/[ -]/)[0]),
  );
  if (reusable) {
    try {
      await access(path.join(outputDirectory, reusable.filename));
      fixtures.push(reusable);
      console.log(`[vehicle-segmentation-v3] ${reusable.id}: reused ${reusable.sourceTitle}`);
      continue;
    } catch {
      // Re-resolve a missing cached fixture.
    }
  }
  const fixture = await resolveFixture(definition);
  fixtures.push(fixture);
  console.log(`[vehicle-segmentation-v3] ${fixture.id}: ${fixture.sourceTitle}`);
  await wait(12_000);
}
await writeFile(
  path.join(outputDirectory, "controlled-fixture-manifest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), fixtures }, null, 2),
);
console.log(`[vehicle-segmentation-v3] prepared ${fixtures.length} licensed controlled fixtures`);
