import * as fs from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Extension, ToolError, insideFolders, s, tool, trustedPath, type Infer } from "@nexora/extension-sdk";
import exifr from "exifr";
import { Jimp, initCodecs, readHeic, type JimpImage } from "./codecs.js";

interface ImagesSettings {
  [key: string]: unknown;
  folders: string[];
  jpegQuality: number;
  showLocation: boolean;
}

/** Formats Images can write. HEIC/HEIF can only be read. */
type Format = "png" | "jpeg" | "bmp" | "gif" | "tiff" | "webp" | "avif";
type InputFormat = Format | "heic";
const MIME = {
  png: "image/png", jpeg: "image/jpeg", bmp: "image/bmp", gif: "image/gif", tiff: "image/tiff",
  webp: "image/webp", avif: "image/avif",
} as const;
const FORMATS = ["jpeg", "png", "webp", "avif", "gif", "bmp", "tiff"] as const;
/** Formats with no transparency: alpha is flattened onto white. */
const OPAQUE = new Set<Format>(["jpeg", "bmp"]);
const EXT: Record<string, Format> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".bmp": "bmp", ".gif": "gif", ".tif": "tiff", ".tiff": "tiff",
  ".webp": "webp", ".avif": "avif",
};
const IMAGE_EXTS = new Set([...Object.keys(EXT), ".heic", ".heif"]);

const MAX_FILE = 60 * 1024 * 1024;
const MAX_PIXELS = 80_000_000; // ~80 MP: enough for phone and camera photos
const MAX_BATCH = 500;

const path = s.string("Absolute path to an image, or relative to the first trusted folder");
const format = s.optional(s.enum(FORMATS, "Output format (default: same as the input; HEIC becomes jpeg)"));
const out = {
  to: s.optional(s.string("Output path (default: a new file next to the original, e.g. photo-edited.jpg)")),
  overwrite: s.optional(s.boolean("Allow replacing an existing file, including the original. Default false")),
  format,
  quality: s.optional(s.integer("JPEG quality 1-100 (default from settings)")),
};

const op = s.object({
  op: s.enum(["resize", "fit", "cover", "crop", "rotate", "flip", "greyscale", "brightness", "contrast", "blur"],
    "resize: to width and/or height (aspect kept if one is omitted) · fit: shrink to fit inside width×height · " +
    "cover: fill width×height, cropping the overflow · crop: x, y, width, height · rotate: degrees clockwise · " +
    "flip: horizontal/vertical · brightness/contrast: value from -1 to 1 · blur: radius in pixels"),
  width: s.optional(s.integer()),
  height: s.optional(s.integer()),
  x: s.optional(s.integer()),
  y: s.optional(s.integer()),
  degrees: s.optional(s.number()),
  horizontal: s.optional(s.boolean()),
  vertical: s.optional(s.boolean()),
  value: s.optional(s.number()),
  radius: s.optional(s.integer()),
});

const InfoInput = s.object({ path });
const EditInput = s.object({ path, ops: s.optional(s.array(op, "Applied in order. Omit to just convert or re-save.")), ...out });
const ConvertInput = s.object({
  path: s.optional(s.string("An image or a folder of images")),
  paths: s.optional(s.array(s.string(), "Several images and/or folders")),
  to: s.enum(FORMATS, "Target format"),
  quality: s.optional(s.integer("1-100 for JPEG, WebP and AVIF (default from settings)")),
  maxSize: s.optional(s.integer("Also shrink so the longest side is at most this many pixels")),
  outDir: s.optional(s.string("Folder for the converted copies (default: next to each original)")),
  recursive: s.optional(s.boolean("Include images in subfolders. Default false")),
  overwrite: s.optional(s.boolean("Replace existing files that have the target name (never the original). Default false")),
});
const ThumbsInput = s.object({
  folder: s.string("Folder of images (not searched recursively)"),
  size: s.optional(s.integer("Longest side in pixels (default 320)")),
  to: s.optional(s.string("Output folder (default: <folder>/thumbnails)")),
  format: s.optional(s.enum(["jpeg", "png"], "Default jpeg")),
});
const CleanInput = s.object({ path, to: out.to, overwrite: out.overwrite });
const FindInput = s.object({
  folder: s.optional(s.string("Folder to search recursively (default: every trusted folder)")),
  orientation: s.optional(s.enum(["landscape", "portrait", "square"])),
  minWidth: s.optional(s.integer()),
  minHeight: s.optional(s.integer()),
  takenAfter: s.optional(s.string("ISO date, e.g. 2026-01-01 (uses the photo's EXIF date)")),
  takenBefore: s.optional(s.string("ISO date")),
  withLocation: s.optional(s.boolean("Only photos that have GPS data")),
  maxResults: s.optional(s.integer("Default 100, max 1000")),
});

class Images extends Extension<ImagesSettings> {
  /* ----------------------------------------------------------- reading */

  @tool({ description: "Image details: format, dimensions, file size, and photo metadata (camera, lens, date taken, whether it has a GPS location).",
    input: InfoInput, readOnly: true })
  async info({ path: p }: Infer<typeof InfoInput>) {
    const file = this.path(p);
    const buf = await readImage(file);
    const dims = dimensions(buf) ?? (await decode(buf)).dims;
    const meta = await this.readMeta(buf);
    return {
      path: file,
      format: sniff(buf) ?? extname(file).slice(1).toLowerCase(),
      width: dims.width,
      height: dims.height,
      megapixels: Math.round((dims.width * dims.height) / 1e5) / 10,
      bytes: buf.length,
      camera: join2(meta?.Make, meta?.Model),
      lens: meta?.LensModel,
      takenAt: isoDate(meta?.DateTimeOriginal ?? meta?.CreateDate),
      exposure: meta?.ExposureTime ? { shutter: shutter(meta.ExposureTime), aperture: meta.FNumber, iso: meta.ISO, focalLength: meta.FocalLength } : undefined,
      ...this.location(meta),
    };
  }

  @tool({ description: "All photo metadata (EXIF/IPTC/XMP) as key/value pairs. GPS is included only if the user allows it in settings.",
    input: InfoInput, readOnly: true })
  async exif({ path: p }: Infer<typeof InfoInput>) {
    const meta = await this.readMeta(await readImage(this.path(p)), true);
    if (!meta) return { metadata: {} };
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v instanceof Uint8Array || (typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v))) continue;
      if (/^GPS|latitude|longitude/i.test(k) && !this.settings.showLocation) continue;
      clean[k] = v instanceof Date ? v.toISOString() : v;
    }
    return { metadata: clean, ...this.location(meta) };
  }

  @tool({ description: "Find images in a folder (recursively) by orientation, minimum size, date taken, or whether they have a location.",
    input: FindInput, readOnly: true })
  async find({ folder, orientation, minWidth, minHeight, takenAfter, takenBefore, withLocation, maxResults = 100 }: Infer<typeof FindInput>) {
    const roots = folder ? [this.path(folder)] : this.folders();
    const after = takenAfter ? Date.parse(takenAfter) : null;
    const before = takenBefore ? Date.parse(takenBefore) : null;
    if ((takenAfter && Number.isNaN(after)) || (takenBefore && Number.isNaN(before))) throw new ToolError("Dates must look like 2026-01-31.");
    const max = Math.min(Math.max(maxResults, 1), 1000);
    const needsExif = after !== null || before !== null || withLocation !== undefined;
    const files: string[] = [];
    for (const r of roots) await collect(r, files, 5000);

    const results = [];
    for (const file of files) {
      if (results.length >= max) break;
      let head: Buffer;
      try {
        head = await readHead(file);
      } catch {
        continue;
      }
      const dims = dimensions(head);
      if (orientation || minWidth || minHeight) {
        if (!dims) continue;
        const o = dims.width > dims.height ? "landscape" : dims.width < dims.height ? "portrait" : "square";
        if (orientation && o !== orientation) continue;
        if ((minWidth && dims.width < minWidth) || (minHeight && dims.height < minHeight)) continue;
      }
      let taken: string | undefined;
      let hasLocation: boolean | undefined;
      if (needsExif) {
        const meta = await this.readMeta(await fs.readFile(file).catch(() => Buffer.alloc(0)));
        taken = isoDate(meta?.DateTimeOriginal ?? meta?.CreateDate);
        hasLocation = meta?.latitude !== undefined;
        const t = taken ? Date.parse(taken) : null;
        if ((after !== null || before !== null) && t === null) continue;
        if (after !== null && t! < after) continue;
        if (before !== null && t! > before) continue;
        if (withLocation !== undefined && hasLocation !== withLocation) continue;
      }
      results.push({ path: file, width: dims?.width, height: dims?.height, takenAt: taken, hasLocation });
    }
    return { results, scanned: files.length, truncated: results.length >= max };
  }

  /* ----------------------------------------------------------- writing */

  @tool({
    description: "Edit an image with a list of operations (resize, fit, cover, crop, rotate, flip, greyscale, brightness, contrast, blur) " +
      "and/or convert its format. Writes a new file next to the original unless 'to' is given; never replaces a file unless overwrite is true. " +
      "Saving removes photo metadata.",
    input: EditInput,
    output: s.object({ path: s.string(), width: s.integer(), height: s.integer(), bytes: s.integer() }),
  })
  async edit({ path: p, ops = [], to, overwrite = false, format: fmt, quality }: Infer<typeof EditInput>) {
    const src = this.path(p);
    const { img } = await decode(await readImage(src));
    for (const o of ops) apply(img, o);
    const outFmt = fmt ?? formatOf(src);
    const dest = await this.output(src, to, overwrite, "edited", outFmt);
    return this.save(img, dest, outFmt, quality);
  }

  @tool({
    description: "Convert images to another format (JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF), from any readable format including HEIC/HEIF " +
      "(iPhone photos). Accepts files and folders. Originals are kept; each copy gets the new extension next to it (or in outDir), " +
      "with a numbered name if that file exists. Transparency is flattened onto white for JPEG/BMP. Metadata is not carried over.",
    input: ConvertInput,
    output: s.object({
      converted: s.array(s.object({ from: s.string(), to: s.string(), bytesBefore: s.integer(), bytesAfter: s.integer() })),
      skipped: s.array(s.object({ path: s.string(), reason: s.string() })),
      bytesBefore: s.integer(),
      bytesAfter: s.integer(),
    }),
  })
  async convert({ path: one, paths = [], to, quality, maxSize, outDir, recursive = false, overwrite = false }: Infer<typeof ConvertInput>) {
    const inputs = [...(one ? [one] : []), ...paths];
    if (!inputs.length) throw new ToolError("Give a path or paths to convert.");
    const dest = outDir ? this.path(outDir) : null;

    // Expand folders into the images they contain.
    const files: string[] = [];
    for (const p of inputs) {
      const full = this.path(p);
      const st = await fs.stat(full).catch(() => null);
      if (!st) throw new ToolError(`${p} doesn't exist`);
      if (st.isDirectory()) {
        if (recursive) await collect(full, files, MAX_BATCH + 1);
        else {
          for (const n of await fs.readdir(full)) {
            if (IMAGE_EXTS.has(extname(n).toLowerCase())) files.push(join(full, n));
          }
        }
      } else {
        files.push(full);
      }
    }
    if (files.length > MAX_BATCH) throw new ToolError(`That is more than ${MAX_BATCH} images; convert a smaller set at a time.`);

    const converted = [];
    const skipped = [];
    let before = 0, after = 0;
    for (const src of files) {
      try {
        const buf = await readImage(src);
        const from = sniff(buf);
        if (from === to && !maxSize) {
          skipped.push({ path: src, reason: `already ${to}` });
          continue;
        }
        const { img } = await decode(buf);
        if (maxSize && Math.max(img.bitmap.width, img.bitmap.height) > maxSize) img.scaleToFit({ w: maxSize, h: maxSize });
        const target = await this.convertTarget(src, dest ?? dirname(src), to, overwrite);
        const data = await encode(img, to, quality ?? this.settings.jpegQuality);
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, data);
        converted.push({ from: src, to: target, bytesBefore: buf.length, bytesAfter: data.length });
        before += buf.length;
        after += data.length;
      } catch (err) {
        skipped.push({ path: src, reason: (err as Error).message });
      }
    }
    return { converted, skipped, bytesBefore: before, bytesAfter: after };
  }

  /** <dir>/<name><ext>, numbered if taken (unless overwrite); never the
   *  source file itself. */
  private async convertTarget(src: string, dir: string, fmt: Format, overwrite: boolean) {
    const base = join(dir, basename(src, extname(src)));
    for (let i = 1; i < 1000; i++) {
      const target = `${base}${i > 1 ? `-${i}` : ""}${extFor(fmt)}`;
      if (resolve(target) === resolve(src)) continue;
      if (!insideFolders(target, this.settings.folders)) throw new ToolError("Output would land outside the trusted folders.");
      if (overwrite || !(await exists(target))) return target;
    }
    throw new ToolError("Too many files with that name already exist.");
  }

  @tool({ description: "Make thumbnails of every image in a folder (longest side = size), saved into a thumbnails folder.",
    input: ThumbsInput, output: s.object({ to: s.string(), created: s.integer(), skipped: s.array(s.string()) }) })
  async thumbnails({ folder, size = 320, to, format: fmt = "jpeg" }: Infer<typeof ThumbsInput>) {
    const dir = this.path(folder);
    const dest = this.path(to ?? join(dir, "thumbnails"));
    const names = (await fs.readdir(dir)).filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase())).slice(0, MAX_BATCH);
    await fs.mkdir(dest, { recursive: true });
    let created = 0;
    const skipped: string[] = [];
    for (const name of names) {
      try {
        const { img } = await decode(await readImage(join(dir, name)));
        img.scaleToFit({ w: size, h: size });
        const out = join(dest, `${basename(name, extname(name))}.${fmt === "jpeg" ? "jpg" : "png"}`);
        await fs.writeFile(out, await encode(img, fmt, this.settings.jpegQuality));
        created++;
      } catch (err) {
        skipped.push(`${name}: ${(err as Error).message}`);
      }
    }
    return { to: dest, created, skipped };
  }

  @tool({ description: "Save a copy of an image without its metadata (camera, date, GPS location), e.g. before sharing it.",
    input: CleanInput, output: s.object({ path: s.string(), width: s.integer(), height: s.integer(), bytes: s.integer() }) })
  async removeMetadata({ path: p, to, overwrite = false }: Infer<typeof CleanInput>) {
    const src = this.path(p);
    const { img } = await decode(await readImage(src));
    const fmt = formatOf(src);
    const dest = await this.output(src, to, overwrite, "clean", fmt);
    // Re-encoding writes pixels only: EXIF, XMP and GPS are not carried over.
    return this.save(img, dest, fmt, 95);
  }

  /* ----------------------------------------------------------- helpers */

  private folders() {
    const f = this.settings.folders ?? [];
    if (!f.length) trustedPath("", f, "Images"); // throws the "add a folder" message
    return f;
  }

  private path(p: string) {
    return trustedPath(p, this.settings.folders, "Images");
  }

  private async readMeta(buf: Buffer, everything = false): Promise<Record<string, any> | undefined> {
    try {
      return await exifr.parse(buf, everything ? { tiff: true, exif: true, gps: true, iptc: true, xmp: true } : { gps: true });
    } catch {
      return undefined;
    }
  }

  private location(meta: Record<string, any> | undefined) {
    const has = typeof meta?.latitude === "number" && typeof meta?.longitude === "number";
    if (!has) return { hasLocation: false };
    if (!this.settings.showLocation) return { hasLocation: true };
    return { hasLocation: true, location: { latitude: meta!.latitude, longitude: meta!.longitude } };
  }

  /** Where to write: `to`, or "<name>-<suffix>.<ext>" next to the source,
   *  numbered so it never collides. */
  private async output(src: string, to: string | undefined, overwrite: boolean, suffix: string, fmt: Format) {
    const ext = fmt === "jpeg" && /\.jpe?g$/i.test(src) ? extname(src) : extFor(fmt);
    if (to) {
      const dest = this.path(to);
      if (!overwrite && (await exists(dest))) throw new ToolError(`${to} already exists; pass overwrite: true to replace it.`);
      return dest;
    }
    const base = join(dirname(src), basename(src, extname(src)));
    for (let i = 1; i < 1000; i++) {
      const dest = `${base}-${suffix}${i > 1 ? `-${i}` : ""}${ext}`;
      if (!(await exists(dest))) {
        if (!insideFolders(dest, this.settings.folders)) throw new ToolError("Output would land outside the trusted folders.");
        return dest;
      }
    }
    throw new ToolError("Too many edited copies already exist; pass 'to'.");
  }

  private async save(img: JimpImage, dest: string, fmt: Format, quality?: number) {
    const data = await encode(img, fmt, quality ?? this.settings.jpegQuality);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    return { path: dest, width: img.bitmap.width, height: img.bitmap.height, bytes: data.length };
  }
}


async function readImage(file: string): Promise<Buffer> {
  const st = await fs.stat(file).catch(() => {
    throw new ToolError(`${file} doesn't exist`);
  });
  if (!st.isFile()) throw new ToolError(`${file} is not a file`);
  if (st.size > MAX_FILE) throw new ToolError(`${basename(file)} is larger than 60 MB`);
  return fs.readFile(file);
}

async function readHead(file: string, n = 128 * 1024): Promise<Buffer> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function decode(buf: Buffer) {
  const dims = dimensions(buf);
  if (dims && dims.width * dims.height > MAX_PIXELS) {
    throw new ToolError(`The image is ${dims.width}×${dims.height}, over the ${MAX_PIXELS / 1e6} MP limit.`);
  }
  const fmt = sniff(buf);
  if (!fmt) {
    throw new ToolError("Unsupported image format. Images reads PNG, JPEG, WebP, AVIF, HEIC/HEIF, GIF, BMP and TIFF.");
  }
  try {
    await initCodecs();
    const img = fmt === "heic" ? await readHeic(buf) : await Jimp.read(buf);
    if (img.bitmap.width * img.bitmap.height > MAX_PIXELS) {
      throw new ToolError(`The image is ${img.bitmap.width}×${img.bitmap.height}, over the ${MAX_PIXELS / 1e6} MP limit.`);
    }
    return { img, dims: { width: img.bitmap.width, height: img.bitmap.height } };
  } catch (err) {
    throw new ToolError(`Can't decode the image: ${(err as Error).message}`);
  }
}

/** Encodes, then strips metadata from the bytes. Jimp's encoders don't write
 *  metadata today; stripping anyway means a future encoder change can't leak
 *  a photo's camera, date or GPS location. */
async function encode(img: JimpImage, fmt: Format, quality = 85): Promise<Buffer> {
  const q = Math.min(Math.max(Math.round(quality), 1), 100);
  if (OPAQUE.has(fmt)) flattenOnWhite(img);
  switch (fmt) {
    case "jpeg":
      return stripJpeg(await img.getBuffer("image/jpeg", { quality: q }));
    case "png":
      return stripPng(await img.getBuffer("image/png"));
    case "webp":
      return img.getBuffer("image/webp", { quality: q });
    case "avif":
      // AVIF's scale is cqLevel 0 (best) to 63 (smallest).
      return img.getBuffer("image/avif", { cqLevel: Math.round(63 * (1 - q / 100)), speed: 6 });
    default:
      return img.getBuffer(MIME[fmt]);
  }
}

/** Blends transparent pixels onto white, so converting e.g. a PNG logo to
 *  JPEG doesn't turn its background black. */
function flattenOnWhite(img: JimpImage) {
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a === 1) continue;
    d[i] = Math.round(d[i] * a + 255 * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
    d[i + 3] = 255;
  }
}

/** Drops APP1 (EXIF, XMP), APP12/13 (IPTC, Photoshop) and comment segments.
 *  Keeps APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour
 *  transform), which affect how the image looks, not who took it. */
function stripJpeg(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keep: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // start of scan: image data follows
    const end = i + 2 + b.readUInt16BE(i + 2);
    const drop = marker === 0xe1 || marker === 0xec || marker === 0xed || marker === 0xfe;
    if (!drop) keep.push(b.subarray(i, end));
    i = end;
  }
  keep.push(b.subarray(i));
  return Buffer.concat(keep);
}

/** Drops PNG text and EXIF chunks (tEXt, zTXt, iTXt, eXIf, tIME). */
function stripPng(b: Buffer): Buffer {
  if (b.readUInt32BE(0) !== 0x89504e47) return b;
  const keep: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 12 + len;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) keep.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(keep);
}

function apply(img: JimpImage, o: Infer<typeof op>) {
  const need = (...keys: (keyof typeof o)[]) => {
    for (const k of keys) if (o[k] === undefined) throw new ToolError(`${o.op} needs ${keys.join(", ")}`);
  };
  const w = img.bitmap.width, h = img.bitmap.height;
  switch (o.op) {
    case "resize":
      if (!o.width && !o.height) throw new ToolError("resize needs width and/or height");
      img.resize({ w: o.width ?? Math.round((w * o.height!) / h), h: o.height ?? Math.round((h * o.width!) / w) });
      break;
    case "fit":
      need("width", "height");
      img.scaleToFit({ w: o.width!, h: o.height! });
      break;
    case "cover":
      need("width", "height");
      img.cover({ w: o.width!, h: o.height! });
      break;
    case "crop": {
      need("x", "y", "width", "height");
      const x = Math.max(0, o.x!), y = Math.max(0, o.y!);
      if (x >= w || y >= h) throw new ToolError(`crop starts outside the ${w}×${h} image`);
      img.crop({ x, y, w: Math.min(o.width!, w - x), h: Math.min(o.height!, h - y) });
      break;
    }
    case "rotate":
      need("degrees");
      img.rotate({ deg: -o.degrees! }); // Jimp turns counter-clockwise
      break;
    case "flip":
      img.flip({ horizontal: !!o.horizontal, vertical: !!o.vertical });
      break;
    case "greyscale":
      img.greyscale();
      break;
    case "brightness":
    case "contrast": {
      need("value");
      const v = Math.min(Math.max(o.value!, -1), 1);
      if (o.op === "brightness") img.brightness(1 + v);
      else img.contrast(v);
      break;
    }
    case "blur":
      need("radius");
      img.blur(Math.min(Math.max(o.radius!, 1), 100));
      break;
  }
}

/** Format from magic bytes. */
function sniff(b: Buffer): InputFormat | undefined {
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (b.length >= 16 && b.subarray(4, 8).toString("latin1") === "ftyp") {
    // ISO media: the ftyp box lists a major brand and compatible brands.
    const size = Math.min(b.readUInt32BE(0), b.length, 256);
    const brands = [b.subarray(8, 12).toString("latin1")];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(b.subarray(i, i + 4).toString("latin1"));
    if (brands.some((x) => x === "avif" || x === "avis")) return "avif";
    if (brands.some((x) => ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(x))) return "heic";
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  return undefined;
}

/** Output format for a source file: the same, except HEIC (read-only)
 *  becomes JPEG. */
function formatOf(file: string): Format {
  return EXT[extname(file).toLowerCase()] ?? (/\.hei[cf]$/i.test(file) ? "jpeg" : "png");
}

/** File extension for a format. */
function extFor(fmt: Format) {
  return fmt === "jpeg" ? ".jpg" : fmt === "tiff" ? ".tif" : `.${fmt}`;
}

/** Dimensions from file headers, without decoding pixels. */
function dimensions(b: Buffer): { width: number; height: number } | undefined {
  const f = sniff(b);
  if (f === "png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (f === "gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (f === "bmp" && b.length >= 26) return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  if (f === "jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

async function collect(target: string, out: string[], limit: number) {
  if (out.length >= limit) return;
  for (const d of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (d.name.startsWith(".") || d.name === "node_modules" || d.isSymbolicLink()) continue;
    const full = join(target, d.name);
    if (d.isDirectory()) await collect(full, out, limit);
    else if (IMAGE_EXTS.has(extname(d.name).toLowerCase())) out.push(resolve(full));
    if (out.length >= limit) return;
  }
}

async function exists(p: string) {
  return fs.stat(p).then(() => true, () => false);
}

function isoDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

function join2(a?: string, b?: string) {
  const s = [a?.trim(), b?.trim()].filter(Boolean);
  if (s.length === 2 && s[1]!.toLowerCase().startsWith(s[0]!.toLowerCase())) return s[1];
  return s.join(" ") || undefined;
}

function shutter(t: number) {
  return t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
}

Images.run();
