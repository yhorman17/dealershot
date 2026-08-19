import { createHash } from "node:crypto";

export const VEHICLE_SEGMENTATION_V2_MODEL = Object.freeze({
  filename: "MaskRCNN-12-int8.onnx",
  model: "Mask R-CNN R-50-FPN INT8",
  version: "ONNX Model Zoo opset-12 int8",
  codeLicense: "MIT",
  weightsLicense: "MIT (ONNX Model Zoo model card)",
  trainingDataset: "COCO 2017",
  source:
    "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/object_detection_segmentation/mask-rcnn/model/MaskRCNN-12-int8.onnx",
  modelCard:
    "https://github.com/onnx/models/tree/main/validated/vision/object_detection_segmentation/mask-rcnn",
  bytes: 45_769_352,
  sha256: "4409935e855719fd6cd986f7ec2a3de840d0bd9c9cf7a0cba84ce95377f5b476",
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyVehicleSegmentationV2Bytes(bytes) {
  if (bytes.length !== VEHICLE_SEGMENTATION_V2_MODEL.bytes) {
    throw new Error("V2 vehicle segmentation model size does not match the pinned asset.");
  }
  if (sha256(bytes) !== VEHICLE_SEGMENTATION_V2_MODEL.sha256) {
    throw new Error("V2 vehicle segmentation model checksum does not match the pinned asset.");
  }
  return bytes.length;
}
