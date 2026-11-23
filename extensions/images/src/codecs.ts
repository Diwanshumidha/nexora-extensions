// Image codecs beyond Jimp's built-ins: WebP and AVIF (read and write) and
// HEIC/HEIF (read). All are WebAssembly, embedded in the bundle and compiled
// in-process: no native addons and no files loaded at runtime, so they work
// in the Node permission sandbox.
//
// WebP/AVIF are registered as our own Jimp formats rather than via
// @jimp/wasm-webp / @jimp/wasm-avif: those call the codec's init() with no
// arguments on every use, which discards the embedded module and makes the
// codec try to fetch its .wasm file.
import { createJimp } from "@jimp/core";
import decodeAvif, { init as initAvifDec } from "@jsquash/avif/decode.js";
import encodeAvif, { init as initAvifEnc } from "@jsquash/avif/encode.js";
import decodeWebp, { init as initWebpDec } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import avifDecWasm from "@jsquash/avif/codec/dec/avif_dec.wasm";
import avifEncWasm from "@jsquash/avif/codec/enc/avif_enc.wasm";
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import decodeHeic from "heic-decode";
import { defaultFormats, defaultPlugins } from "jimp";

interface Bitmap {
  data: Buffer;
  width: number;
  height: number;
}

let ready: Promise<void> | undefined;

/** Compiles the embedded codecs once. Must run before any WebP/AVIF use. */
export function initCodecs(): Promise<void> {
  ready ??= (async () => {
    const compile = (bytes: Uint8Array) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    await Promise.all([
      initWebpDec(await compile(webpDecWasm)),
      initWebpEnc(await compile(webpEncWasm)),
      initAvifDec(await compile(avifDecWasm)),
      initAvifEnc(await compile(avifEncWasm)),
    ]);
  })();
  return ready;
}

const toBitmap = (img: ImageData): Bitmap => ({
  data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
  width: img.width,
  height: img.height,
});
/** A copy of the pixels in a fresh, unshared buffer, as the codecs expect. */
const toImageData = (b: Bitmap) =>
  ({ data: new Uint8ClampedArray(b.data), width: b.width, height: b.height, colorSpace: "srgb" }) as unknown as ImageData;
const exact = (buf: Buffer) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

const webp = () => ({
  mime: "image/webp" as const,
  hasAlpha: true,
  encode: async (bitmap: Bitmap, options: { quality?: number } = {}) => {
    await initCodecs();
    return Buffer.from(await encodeWebp(toImageData(bitmap), { quality: options.quality ?? 85 }));
  },
  decode: async (data: Buffer) => {
    await initCodecs();
    return toBitmap(await decodeWebp(exact(data)));
  },
});

const avif = () => ({
  mime: "image/avif" as const,
  hasAlpha: true,
  // cqLevel: 0 (best) to 63 (smallest). speed: 0 (slowest) to 10.
  encode: async (bitmap: Bitmap, options: { cqLevel?: number; speed?: number } = {}) => {
    await initCodecs();
    return Buffer.from(await encodeAvif(toImageData(bitmap), { cqLevel: options.cqLevel ?? 24, speed: options.speed ?? 6 }));
  },
  decode: async (data: Buffer) => {
    await initCodecs();
    const img = await decodeAvif(exact(data));
    if (!img) throw new Error("not a decodable AVIF");
    return toBitmap(img);
  },
});

/** Jimp with WebP and AVIF registered next to PNG/JPEG/BMP/GIF/TIFF. */
export const Jimp = createJimp({ formats: [...defaultFormats, webp, avif], plugins: defaultPlugins });
export type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/** Decodes HEIC/HEIF (e.g. iPhone photos) into a Jimp image. libheif applies
 *  the photo's rotation, so the result is upright. */
export async function readHeic(buf: Buffer): Promise<JimpImage> {
  const { width, height, data } = await decodeHeic({ buffer: new Uint8Array(buf) });
  return Jimp.fromBitmap({ width, height, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }) as JimpImage;
}
