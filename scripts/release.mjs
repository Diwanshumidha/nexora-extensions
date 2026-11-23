// Packages every built extension into release/: one <id>-<version>.zip per
// extension plus index.json, the catalog Nexora downloads from. Zips hold only
// what runs (nexora.json + the bundled dist/ without source maps), and the
// catalog records each zip's SHA-256 so the app can verify the download.
//
// URLs in index.json are relative to the index itself, so the same release
// works from GitHub Releases ("…/releases/latest/download/index.json") or any
// static server.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

// Must match what the Nexora build supports (extension.HostProtocol).
const PROTOCOL = 1;
const root = new URL("..", import.meta.url).pathname;
const out = join(root, "release");

async function files(dir) {
  const found = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...(await files(p)));
    else if (e.isFile() && !e.name.endsWith(".map")) found.push(p);
  }
  return found;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const catalog = [];
for (const id of (await readdir(join(root, "extensions"))).sort()) {
  const dir = join(root, "extensions", id);
  const manifest = JSON.parse(await readFile(join(dir, "nexora.json"), "utf8"));
  if ((manifest.protocol ?? 1) > PROTOCOL) throw new Error(`${id}: protocol ${manifest.protocol} is newer than ${PROTOCOL}`);
  if (manifest.runtime === "node" && !(await stat(join(dir, manifest.main)).catch(() => null))) {
    throw new Error(`${id} is not built (missing ${manifest.main}); run pnpm build`);
  }
  const tree = { "nexora.json": new Uint8Array(await readFile(join(dir, "nexora.json"))) };
  const dist = join(dir, "dist");
  if (await stat(dist).catch(() => null)) {
    for (const f of await files(dist)) tree[relative(dir, f).split(sep).join("/")] = new Uint8Array(await readFile(f));
  }
  const zip = zipSync(tree, { level: 9, mtime: new Date("2020-01-01") }); // fixed mtime: reproducible zips
  const name = `${manifest.id}-${manifest.version}.zip`;
  await writeFile(join(out, name), zip);
  catalog.push({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    protocol: manifest.protocol ?? 1,
    description: manifest.description ?? "",
    author: manifest.author ?? "",
    icon: manifest.icon ?? "",
    permissions: manifest.permissions ?? {},
    url: name,
    size: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  });
  console.log(`${name}  ${(zip.length / 1024).toFixed(0)} KB`);
}

await writeFile(join(out, "index.json"), JSON.stringify({ schema: 1, extensions: catalog }, null, 2) + "\n");
console.log(`release/index.json: ${catalog.length} extensions`);
