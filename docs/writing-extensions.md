# Writing an extension

Extensions are TypeScript classes built on `@nexora/extension-sdk`.

## 1. Create the folder

```
extensions/my-ext/
  nexora.json
  package.json
  tsconfig.json
  src/index.ts
```

`nexora.json`:

```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "0.1.0",
  "protocol": 1,
  "description": "What it does, shown to users and to the AI",
  "namespace": "myExt",
  "runtime": "node",
  "main": "dist/index.js",
  "permissions": {
    "network": false,
    "childProcess": false
  },
  "settings": []
}
```

- `id`: lowercase, `a-z0-9-`, unique.
- `protocol`: the Nexora extension protocol it was built for (currently `1`).
  Nexora refuses an extension that needs a newer protocol than it supports.
- `namespace`: the JS identifier the AI uses, as in `tools.myExt.*`. Defaults to `id`.
- `permissions`: anything not listed is denied. Prefer folder **settings** with
  `grant` (below) over fixed `fsRead`/`fsWrite` paths, so the user chooses.

Copy `package.json` and `tsconfig.json` from `extensions/hello`.

## 2. Write the class

```ts
import { Extension, ToolError, s, tool, type Infer } from "@nexora/extension-sdk";

const SearchInput = s.object({
  query: s.string("Text to search for"),
  limit: s.optional(s.integer("Max results (default 10)")),
});

class MyExt extends Extension {
  private cache = new Map<string, string[]>();

  protected override async onStart() {
    this.log.info(`storing data in ${this.dataDir}`);
  }

  protected override async onStop() {
    this.cache.clear();
  }

  @tool({ description: "Search notes", input: SearchInput, output: s.array(s.string()), readOnly: true })
  async search({ query, limit = 10 }: Infer<typeof SearchInput>): Promise<string[]> {
    if (!query.trim()) throw new ToolError("query must not be empty");
    return [];
  }

  // Undecorated methods are private helpers, never exposed to the AI.
  private normalise(text: string) {
    return text.toLowerCase();
  }
}

MyExt.run();
```

### API reference

| API                         | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `class X extends Extension` | Base class. One instance lives for the life of the process.        |
| `@tool({...})`              | Exposes a method as `tools.<namespace>.<name>()`. Options: `description`, `input`, `output`, `name`, `readOnly`. |
| `X.run()`                   | Instantiates the class and starts serving the protocol on stdio.   |
| `onStart()` / `onStop()`    | Lifecycle hooks. `context`, `dataDir` and `log` are ready in `onStart`. |
| `this.context`              | `{ extensionId, hostVersion, dataDir }`                            |
| `this.log`                  | `debug/info/warn/error`, forwarded to the host log.                |
| `ToolError`                 | Throw it to return a clean error message (plus optional `data`) to the AI. |
| `s.*` / `Infer<>`           | JSON Schema builder with inferred TS types (`string`, `number`, `integer`, `boolean`, `any`, `enum`, `array`, `object`, `optional`). |

Mark every tool that only reads with `readOnly: true`. Users control each
extension's trust level: **Trusted** runs every tool, **Ask first** (the
default) runs read-only tools and asks before anything else, **Read only**
blocks everything else. A tool without `readOnly` is always treated as a
write, so an honest flag means fewer prompts for your users.

Write descriptions for the AI. They become JSDoc comments in the generated
`tools` declaration that the model reads.

Do not write to stdout: it carries protocol frames. `console.log` is
redirected to stderr automatically, but prefer `this.log`.

## Settings

Declare user settings in `nexora.json`. Nexora renders them on the
extension's panel, validates them, stores them per extension, and passes
them to your class:

```json
"settings": [
  { "key": "folders", "type": "folders", "label": "Trusted folders", "grant": "readwrite",
    "description": "Excel can open and edit workbooks only inside these folders." },
  { "key": "maxRows", "type": "number", "label": "Max rows per read", "default": 5000 }
]
```

| Type | UI | Value |
| ---- | -- | ----- |
| `string`, `number`, `boolean` | text, number, toggle | as typed |
| `select` (+ `choices`) | choice chips | one of `choices` |
| `secret` | password field (never shown again) | string |
| `folder`, `folders` | native folder picker | absolute path(s) |

**Folder access comes from settings, not the manifest.** A folder setting
with `"grant": "read"` or `"readwrite"` adds the user's chosen folders to the
extension's Node sandbox, so it can only touch what the user picked. Nexora
refuses to grant `/` or any folder containing its own data (and therefore the
whole home folder). Changing a granted folder restarts the extension; other
settings arrive live.

```ts
import { Extension, ToolError, insideFolders } from "@nexora/extension-sdk";

class Excel extends Extension<{ [k: string]: unknown; folders: string[]; maxRows: number }> {
  protected override onSettingsChanged(next, prev) { this.log.info(`maxRows is now ${next.maxRows}`); }

  private check(path: string) {
    // A clear message for the AI before the sandbox would refuse access.
    if (!insideFolders(path, this.settings.folders))
      throw new ToolError(`${path} is outside Excel's trusted folders`);
  }
}
```

## 3. Build and run

```sh
pnpm install
pnpm --filter @nexora-ext/my-ext build   # -> dist/index.js (single bundled file)
```

Then run the app from its repo (`wails3 task dev` in `../nexora`), which
loads this repo's `extensions/` folder automatically.

Try it in the **Code Mode** page:

```js
return await tools.myExt.search({ query: "invoice" })
```

To install a built extension outside the repo, click **+** in the orbit and
use *Install from a folder*. It is copied to `~/.config/nexora/extensions/<id>`.

## 4. Publish

Bump `version` in `nexora.json`, then `pnpm release` (see the README). Users
see the new version as an **Update** in the **+** panel.
