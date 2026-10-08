# Local background removal

`removeBackgroundAi(blob, { signal, onProgress })` returns a transparent PNG at the
decoded source dimensions. A dedicated, disposable Web Worker handles decoding,
download, model inference, and output encoding. Aborting terminates the worker,
including an in-progress inference. The source image stays in the browser.

## Model and runtime

- **U²-Net**, full general-purpose salient-object model by Xuebin Qin et al.
  Original project: <https://github.com/xuebinqin/U-2-Net> (Apache-2.0).
- ONNX conversion distributed by rembg:
  <https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx>.
- CORS-enabled mirror pinned at revision `b8b2ea0e632dadabd925c166c39b8f06be0a5031`:
  <https://huggingface.co/jellybox/u2net> (Apache-2.0).
- Model size: **175,997,641 bytes**. Verified against rembg's published MD5:
  `60024c5c889badc19c04ad937298a77b`.
- SHA-256, checked before every inference session:
  `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`.
- **ONNX Runtime Web 1.22.0**, Microsoft (MIT):
  <https://github.com/microsoft/onnxruntime/tree/v1.22.0/js/web>.

Copies of the model and runtime licenses ship in `public/licenses/`. The model is
downloaded only after the user clicks removal. Four bounded range downloads allow
failed segments to resume. The verified model is saved in Cache Storage when the
browser has space; processing also works when persistent storage is unavailable.
Downloading the model initially needs internet access. Cache eviction can require
another download. There are no API keys, paid service calls, or image uploads.

## Hosting and behavior

The worker and WASM assets use Vite asset URLs so the `/Mm-Cnc/` GitHub Pages base
path works. WASM is set to **one thread**, inside the dedicated worker; SharedArrayBuffer
and COOP/COEP response headers are unnecessary. Modern browsers must provide
WebAssembly SIMD, Web Workers, OffscreenCanvas and createImageBitmap.

The 320×320 input preparation follows U²-Net/rembg normalization. The original
image is never resized for export: the model's soft mask is enlarged and multiplied
by the original alpha. Existing transparent areas remain transparent. Salient-object
segmentation can miss thin details or merge nearby subjects. Preview the result;
the app's separate color removal method is also useful for flat graphics. The
model does not guarantee perfect hair or transparent-object matting.
