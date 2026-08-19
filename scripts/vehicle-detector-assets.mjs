import { createHash } from "node:crypto";

export const VEHICLE_DETECTOR_MODEL = Object.freeze({
  filename: "yolox_nano.onnx",
  model: "YOLOX-Nano",
  version: "0.1.1rc0",
  license: "Apache-2.0",
  source:
    "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx",
  bytes: 3_659_407,
  sha256: "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d",
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyVehicleDetectorBytes(bytes) {
  if (bytes.length !== VEHICLE_DETECTOR_MODEL.bytes) {
    throw new Error("Vehicle detector size does not match the pinned release asset.");
  }
  if (sha256(bytes) !== VEHICLE_DETECTOR_MODEL.sha256) {
    throw new Error("Vehicle detector checksum does not match the pinned release asset.");
  }
  return bytes.length;
}
