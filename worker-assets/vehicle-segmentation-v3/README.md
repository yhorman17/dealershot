# DealerShot vehicle segmentation V3 runtime assets

These pinned ONNX artifacts are loaded lazily by the background-processing worker only.
They are not part of the browser or capture bundles.

- RT-DETRv2 R18vd COCO: Apache-2.0 code and weights
- MobileSAM ViT-T: Apache-2.0 code and weights

Exact upstream commits, checksums, byte lengths, and source URLs are recorded in
`scripts/vehicle-segmentation-v3-assets.mjs`. The production build verifies every
artifact before it can be deployed.
