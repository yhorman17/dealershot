# Vehicle Segmentation V2 Experiment

This directory contains the reproducible, non-production benchmark output for DealerShot's second vehicle-cutout experiment.

## Status

- **Promotion decision:** failed; keep behind `VEHICLE_SEGMENTATION_V2=0`.
- **Production behavior:** unchanged. V2 is not imported by the normal worker and its model is not copied by the production build.
- **V1 behavior:** unchanged and disabled with `VEHICLE_AWARE_BACKGROUND_REMOVAL=0`.

## Candidate

The experiment evaluates the ONNX Model Zoo `MaskRCNN-12-int8.onnx` COCO instance-segmentation artifact. The model card and artifact declare MIT licensing. The asset manifest pins the source URL, byte length, and SHA-256 checksum; the 43.6 MB model is downloaded only by the explicit experiment command and is not committed.

## Dataset

The checked-in contact sheet and JSON contain 16 controlled COCO validation fixtures. They contain no private DealerShot media.

No active vehicle media was available in the hosted acceptance ledger during this run (`media_assets = 0`, `media_variants = 0`), and no authenticated browser session was available. The required real black Volkswagen/showroom case therefore remains untested. This alone prevents promotion.

## Results

| Gate                                            |    Required |                                                 Observed |
| ----------------------------------------------- | ----------: | -------------------------------------------------------: |
| Primary complete-vehicle selection              |      >= 95% |                                                      80% |
| Exact full/partial/non/ambiguous classification |      >= 95% |                                                      75% |
| Automatic full-vs-not-full gate                 |      >= 95% |                                                   81.25% |
| Good eligible cutouts                           |      >= 80% |                                               10% (1/10) |
| Needs Review eligible cutouts                   |      <= 15% |                                               60% (6/10) |
| Bad eligible cutouts                            |       <= 5% |                                               30% (3/10) |
| Preferred incremental RSS                       |   < 400 MiB | ~444 MiB isolated; higher in combined comparison process |
| Preferred CPU latency                           | < 3 seconds |                               0.87 seconds mean V2 stage |

The raw V2 mask improved mean IoU and missing geometry over current ISNet on these fixtures, but contamination remained worse than current and the automotive refinement damaged mask geometry. Dark-vehicle selection, multiple-vehicle ambiguity, a normal red vehicle, and several complete exterior views were not reliable enough for use.

## Reproduction

Prepare the pinned model explicitly, then run the benchmark with local COCO 2017 validation image and annotation directories:

```powershell
npm run prepare:vehicle-segmentation-v2
npm run verify:vehicle-segmentation-v2
node --expose-gc scripts/benchmark-vehicle-segmentation-v2.mjs --images <coco-images> --annotations <instances_val2017.json> --output-directory artifacts/vehicle-segmentation-v2
```

The benchmark intentionally compares current ISNet, V1 YOLOX plus ISNet, V2 raw instance segmentation, and V2 automotive refinement. Do not use these artifacts as a product-quality claim; the dataset is controlled rather than real dealership imagery.
