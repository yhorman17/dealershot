"""Export pinned MobileSAM encoder and prompt decoder ONNX assets for the V3 experiment.

This script intentionally requires an explicit checkout and checkpoint. It is not part of
the normal DealerShot build and never downloads or writes production assets implicitly.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import warnings

import torch


class ImageEncoder(torch.nn.Module):
    def __init__(self, encoder: torch.nn.Module) -> None:
        super().__init__()
        self.encoder = encoder

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.encoder(image)


def export(args: argparse.Namespace) -> None:
    source = pathlib.Path(args.mobile_sam_source).resolve()
    checkpoint = pathlib.Path(args.checkpoint).resolve()
    output = pathlib.Path(args.output_directory).resolve()
    if not (source / "mobile_sam" / "__init__.py").is_file():
        raise SystemExit("MobileSAM source checkout is missing mobile_sam/__init__.py")
    if not checkpoint.is_file():
        raise SystemExit("MobileSAM checkpoint does not exist")

    sys.path.insert(0, str(source))
    from mobile_sam import sam_model_registry  # pylint: disable=import-outside-toplevel
    from mobile_sam.utils.onnx import SamOnnxModel  # pylint: disable=import-outside-toplevel

    output.mkdir(parents=True, exist_ok=True)
    encoder_path = output / "mobile-sam-vit-t-encoder.onnx"
    decoder_path = output / "mobile-sam-vit-t-decoder.onnx"

    torch.set_grad_enabled(False)
    sam = sam_model_registry["vit_t"](checkpoint=str(checkpoint)).eval()
    encoder = ImageEncoder(sam.image_encoder).eval()
    encoder_input = torch.zeros(1, 3, 1024, 1024, dtype=torch.float32)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        torch.onnx.export(
            encoder,
            (encoder_input,),
            str(encoder_path),
            export_params=True,
            opset_version=17,
            do_constant_folding=True,
            input_names=["image"],
            output_names=["image_embeddings"],
            dynamo=False,
        )

    decoder = SamOnnxModel(model=sam, return_single_mask=False).eval()
    embed_dim = sam.prompt_encoder.embed_dim
    embed_size = sam.prompt_encoder.image_embedding_size
    mask_input_size = [4 * value for value in embed_size]
    decoder_inputs = {
        "image_embeddings": torch.zeros(1, embed_dim, *embed_size, dtype=torch.float32),
        "point_coords": torch.zeros(1, 2, 2, dtype=torch.float32),
        "point_labels": torch.tensor([[2.0, 3.0]], dtype=torch.float32),
        "mask_input": torch.zeros(1, 1, *mask_input_size, dtype=torch.float32),
        "has_mask_input": torch.zeros(1, dtype=torch.float32),
        "orig_im_size": torch.tensor([1024.0, 1024.0], dtype=torch.float32),
    }
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        torch.onnx.export(
            decoder,
            tuple(decoder_inputs.values()),
            str(decoder_path),
            export_params=True,
            opset_version=17,
            do_constant_folding=True,
            input_names=list(decoder_inputs),
            output_names=["masks", "iou_predictions", "low_res_masks"],
            dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
            dynamo=False,
        )

    print(f"encoder={encoder_path} bytes={encoder_path.stat().st_size}")
    print(f"decoder={decoder_path} bytes={decoder_path.stat().st_size}")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mobile-sam-source", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output-directory", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    export(arguments())
