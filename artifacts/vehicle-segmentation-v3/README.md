# DealerShot vehicle segmentation V3 experiment

This artifact is an internal controlled benchmark. It contains no private DealerShot media.
The hosted media-ledger audit found zero active media assets/variants and zero photo rows, so
the mandatory real DealerShot portion of the promotion gate could not be run.

## Candidate decision

V3 uses an Apache-2.0 RT-DETRv2 R18vd COCO detector to choose a vehicle box and an
Apache-2.0 MobileSAM ViT-T model to create a 256 x 256 box-prompted mask. The model is run
only in a bounded, short-lived child process. Exact repositories, commits, source checkpoint
hashes, exported asset hashes, and byte lengths are pinned in
`scripts/vehicle-segmentation-v3-assets.mjs`.

Candidates rejected before implementation:

- RTMDet-Ins: preferred family, but the official toolchain did not provide a reproducible
  pre-exported ONNX artifact for this Windows experiment environment.
- DETR ResNet-50 panoptic: Apache-2.0 but its exported masks were only 16 x 16.
- Mask2Former: model-zoo weights are CC BY-NC / commercially ambiguous even though the code
  is permissively licensed.
- YOLOv8 segmentation: weights are GPL/AGPL-family and unsuitable for DealerShot's closed
  production use.

## Dataset

- 16 COCO 2017 controlled fixtures with segmentation ground truth: 10 full vehicle, one
  ambiguous multi-vehicle, one interior negative, and four partial/detail negatives.
- 20 independently licensed Wikimedia Commons fixtures across 20 manufacturers: six sedans,
  five SUVs, three coupes, two minivans, two wagons, and two trucks.
- Brand maximum: 1/20 (5%).
- Real DealerShot fixtures: 0 (hosted staging has no ledger-backed vehicle media).

The complete public-source attribution and license manifest is
`controlled-fixture-manifest.json`. The images themselves are not committed separately; the
contact sheet is retained solely as the internal comparison artifact.

## Benchmark summary

| Metric                           | Current ISNet | V1 YOLOX + ISNet | V2 Mask R-CNN | V3 RT-DETRv2 + MobileSAM |
| -------------------------------- | ------------: | ---------------: | ------------: | -----------------------: |
| Mean mask IoU                    |        0.0429 |           0.1284 |        0.2651 |               **0.7888** |
| Background contamination         |        0.4063 |           0.6048 |        0.5214 |               **0.1488** |
| Missing geometry                 |        0.9066 |           0.8370 |        0.6432 |               **0.1780** |
| Mean V3 end-to-end time          |             - |                - |             - |                  1.393 s |
| V3 isolated mean incremental RSS |             - |                - |             - |        200,195,641 bytes |
| V3 isolated maximum snapshot     |             - |                - |             - |        232,542,208 bytes |
| V3 model assets                  |             - |                - |             - |        126,329,024 bytes |

Refinement was not selected by the pipeline for any case. Across COCO ground truth it changed
IoU only from 0.7888 to 0.7913 and did not materially change contamination, so the raw
MobileSAM mask remains the conservative output.

## Gate results

| Promotion gate                                  |            Required |                                 Measured | Result      |
| ----------------------------------------------- | ------------------: | ---------------------------------------: | ----------- |
| Primary selection                               |               >=95% |                                    80.0% | FAIL        |
| Exact full/partial/non/ambiguous classification |               >=95% |                                   91.67% | FAIL        |
| Automatic full-vehicle gate                     |               >=95% |                                   94.44% | FAIL        |
| Good eligible cutouts                           |               >=80% |                                   93.33% | PASS        |
| Needs Review                                    |               <=15% |                                    3.33% | PASS        |
| Bad                                             |                <=5% |                                    3.33% | PASS        |
| Dark/night vehicle                              |          acceptable |       selected wrong region and rejected | FAIL        |
| Side profile                                    |          acceptable |                               IoU 0.8827 | PASS        |
| Multi-vehicle ambiguity                         |        conservative |             ambiguous case auto-accepted | FAIL        |
| Glass/body coherence                            |          acceptable | visually coherent on controlled fixtures | CONDITIONAL |
| Incremental memory                              | preferably <300 MiB |               max snapshot about 222 MiB | PASS        |
| CPU latency                                     |     preferably <3 s |                             1.393 s mean | PASS        |
| Real DealerShot imagery                         |            required |                              unavailable | FAIL        |

## Manual visual review

The contact sheet was reviewed at full resolution. The controlled full-vehicle cases were
scored consistently on a 1-5 scale:

| Case group                  | Completeness | Edge | Glass | Isolation | Observation                                                       |
| --------------------------- | -----------: | ---: | ----: | --------: | ----------------------------------------------------------------- |
| Side profiles               |            5 |    4 |     4 |         5 | Mirrors, wheels, and body geometry retained.                      |
| Light/outdoor 3/4           |            5 |    4 |     4 |         5 | Large improvement over every baseline.                            |
| Controlled dark coupe/sedan |            5 |    4 |     4 |         5 | Good visual masks, but no ground-truth DealerShot dark image.     |
| Person-near-vehicle         |            5 |    4 |     4 |         5 | Person excluded.                                                  |
| Rear vehicle with dog       |            4 |    4 |     3 |         2 | Dog remained with the vehicle mask; quality gate missed it.       |
| Dark/night COCO             |            1 |    1 |     1 |         1 | Detector selected the wrong bus-like region and rejected the car. |
| Similar multi-vehicle       |            5 |    4 |     4 |         5 | Mask itself is clean, but ambiguity was not detected.             |

The clean-looking controlled results do not override the failed detector/classifier gates.

## Isolation and production impact

- `VEHICLE_SEGMENTATION_V3=0` remains the default.
- V1 and V2 remain disabled.
- The normal web build, capture path, production background remover, and normal worker entry
  do not import V3.
- Explicit V3 inference starts a child process with concurrency one and a 45-second timeout.
- The child releases ONNX sessions and then exits, so retained allocator memory does not grow
  in the durable worker.
- The explicit production child bundle is about 29 KiB; native ONNX Runtime and Sharp remain
  external runtime dependencies.
- No V3 model file is part of the hosted build or production artifact.

## Decision

Keep V3 behind flag for more real-image testing.

The segmentation architecture is materially better than V1/V2 and worth preserving, but it
must not be promoted until the dark-vehicle detector failure, multi-vehicle ambiguity failure,
and real DealerShot benchmark gap are closed with structural evidence rather than threshold
tuning.
