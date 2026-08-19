import { createHash } from "node:crypto";

export const VEHICLE_SEGMENTATION_V3_PROVENANCE = Object.freeze({
  detector: {
    model: "RT-DETRv2 R18vd COCO",
    codeLicense: "Apache-2.0",
    weightsLicense: "Apache-2.0",
    sourceRepository: "https://github.com/lyuwenyu/RT-DETR",
    sourceCommit: "068dfde65f2667ad6555883c69d73de886518cad",
    checkpoint:
      "https://github.com/lyuwenyu/storage/releases/download/v0.2/rtdetrv2_r18vd_120e_coco_rerun_48.1.pth",
    checkpointBytes: 81_198_974,
    checkpointSha256: "2ace52184b620204004509b72752ac7bfe64aadaf7fc1d076b18df8ab5a5c77e",
  },
  segmenter: {
    model: "MobileSAM ViT-T",
    codeLicense: "Apache-2.0",
    weightsLicense: "Apache-2.0",
    sourceRepository: "https://github.com/ChaoningZhang/MobileSAM",
    sourceCommit: "f706ad9c4eb7f219c00d9050e46328518ffb65d2",
    checkpoint:
      "https://github.com/ChaoningZhang/MobileSAM/raw/f706ad9c4eb7f219c00d9050e46328518ffb65d2/weights/mobile_sam.pt",
    checkpointBytes: 40_728_226,
    checkpointSha256: "6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f",
  },
});

export const VEHICLE_SEGMENTATION_V3_ASSETS = Object.freeze([
  {
    filename: "rtdetrv2-r18vd-coco.onnx",
    bytes: 1_619_790,
    sha256: "4e5ee00e43abe7fe348f4b0cc5d1f454946acd47ed148d415bc6c87a70c5d1c0",
  },
  {
    filename: "rtdetrv2-r18vd-coco.onnx.data",
    bytes: 80_216_064,
    sha256: "7005ecdc4639f1bdc816dc2951b0f06619e44aacec012010726490e7f81d248e",
  },
  {
    filename: "mobile-sam-vit-t-encoder.onnx",
    bytes: 27_996_236,
    sha256: "92e0631a1e575d3764c0432d921f1b83802b7a2412fab4848d3bc6178523d3a6",
  },
  {
    filename: "mobile-sam-vit-t-decoder.onnx",
    bytes: 16_496_934,
    sha256: "a21b65b6e1b75e2c6265b36835747a0ab9169ec1ed725139a78ce90297f95126",
  },
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyVehicleSegmentationV3Asset(asset, bytes) {
  if (bytes.length !== asset.bytes) {
    throw new Error(`V3 asset ${asset.filename} has an unexpected byte length.`);
  }
  if (sha256(bytes) !== asset.sha256) {
    throw new Error(`V3 asset ${asset.filename} failed SHA-256 verification.`);
  }
}
