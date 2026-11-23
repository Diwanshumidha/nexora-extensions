# Nexora extensions

The extension SDK and the first-party extensions for
[Nexora](../nexora), a plugin-based personal AI assistant. Each extension is a
TypeScript class built on `@nexora/extension-sdk`, bundled into a single file
and run by Nexora in its own sandboxed Node.js process.

```
sdk/extension-sdk/       @nexora/extension-sdk: Extension base class, @tool, schema builder
extensions/<id>/         One folder per extension (nexora.json + src/)
scripts/build-extension.mjs  Bundles an extension into dist/index.js
scripts/release.mjs      Packages every extension + the catalog (index.json)
docs/writing-extensions.md   How to write one
```

## Develop

```sh
pnpm install
pnpm build          # SDK + every extension
```

Clone this repo next to `nexora/`; the app's `wails3 task dev` loads
`extensions/` from here, and its Go tests run the extensions end to end.

## Release

```sh
pnpm release        # build, then write release/: <id>-<version>.zip + index.json
```

Each zip holds only `nexora.json` and the bundled `dist/` (no source maps).
`index.json` lists every extension with its version, protocol, permissions,
size and SHA-256; the URLs in it are relative to the index, so the folder can
be served from anywhere. Nexora reads the catalog from `NEXORA_REGISTRY_URL`
(or its built-in default) and verifies every download against it.

Pushing a tag `v*` runs `.github/workflows/release.yml`, which attaches the
`release/` files to a GitHub release. The stable catalog URL is then

```
https://github.com/<owner>/nexora-extensions/releases/latest/download/index.json
```

Bump an extension's `version` in `nexora.json` to ship an update; users get
an **Update** button in the app's **+** panel and keep their settings and data.

## Extensions

| Extension | Tools | Access |
| --------- | ----- | ------ |
| **Files** | `roots` `list` `info` `tree` `find` `readText` `size` `hash` (read) · `writeText` `appendText` `mkdir` `copy` `move` `rename` `delete` `restore` `emptyTrash` (write) · `listTrash` | Only its *Trusted folders*. Deletes and overwrites go to a Nexora trash (`restore` undoes them). Never overwrites unless asked, never touches a trusted folder's root. |
| **Web** | `get` `getJSON` `readPage` (read) · `post` (write) | Public sites only: localhost, LAN, tailnet (100.64/10), link-local and metadata addresses are refused, re-checked on every redirect. Optional *Allowed sites*. |
| **Notes** | `list` `read` `search` (read) · `create` `append` `update` `delete` (write) | Its own private folder only. |
| **PDF** | `info` `readText` (by page) `search` (across a folder) | Its *Trusted folders*, read-only. |
| **CSV** | `read` `query` (filter / group / aggregate / sort) `stats` (read) · `write` | Its *Trusted folders*. |
| **Archive** | `list` (read) · `create` `extract` (write) | Its *Trusted folders*. Refuses entries escaping the destination (zip-slip) and archives over the size limit (zip bombs, counted while unpacking). |
| **Images** | `info` `exif` `find` (read) · `convert` (files or folders, any format to JPEG/PNG/WebP/AVIF/GIF/BMP/TIFF) `edit` (resize, fit, cover, crop, rotate, flip, greyscale, brightness, contrast, blur) `thumbnails` `removeMetadata` (write) | Its *Trusted folders*. Reads JPEG, PNG, WebP, AVIF, HEIC/HEIF, GIF, BMP, TIFF (codecs are embedded WebAssembly). Never replaces an original; saved images carry no metadata; GPS is hidden from the AI unless allowed. |
| **System** | `info` `usage` `now` | No file or network access. |
| **Excel** | `listSheets` `readSheet` (read) · `writeSheet` (write) | Only its *Trusted folders*. |
| **Word** | `createDocument` (write) | Only its *Save folder*. |
| **Hello** | `greet` `add` `stats` | Example extension. |


## Compatibility

`nexora.json` declares `"protocol": 1`. Nexora refuses an extension whose
protocol is newer than it supports, so bump it only together with an SDK change
the host must understand.
