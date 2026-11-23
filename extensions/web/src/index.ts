import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Extension, ToolError, s, tool, type Infer } from "@nexora/extension-sdk";

interface WebSettings {
  [key: string]: unknown;
  allowedSites: string;
  maxKB: number;
}

const url = s.string("http(s) URL");
const headers = s.optional(s.any("Extra request headers, e.g. { \"Accept-Language\": \"en\" }"));
const GetInput = s.object({ url, headers });
const PostInput = s.object({
  url,
  body: s.any("JSON value to send (or a string)"),
  headers,
  method: s.optional(s.enum(["POST", "PUT", "PATCH", "DELETE"], "Default POST")),
});

/** Addresses an AI must never reach through this extension: this machine,
 *  the LAN, link-local/cloud metadata and the CGNAT range Tailscale uses. */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

function isBlockedAddress(addr: string): boolean {
  const v4mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4mapped) return blocked.check(v4mapped, "ipv4");
  return blocked.check(addr, isIP(addr) === 6 ? "ipv6" : "ipv4");
}

const MAX_REDIRECTS = 5;

class Web extends Extension<WebSettings> {
  @tool({ description: "Fetch a URL and return its status, content type and body as text (truncated to the size limit).",
    input: GetInput, readOnly: true })
  async get({ url, headers }: Infer<typeof GetInput>) {
    const res = await this.fetch(url, { headers: headers as Record<string, string> | undefined });
    return { status: res.status, url: res.url, contentType: res.contentType, body: res.text, truncated: res.truncated };
  }

  @tool({ description: "Fetch a URL and parse the response as JSON.", input: GetInput, readOnly: true })
  async getJSON({ url, headers }: Infer<typeof GetInput>) {
    const res = await this.fetch(url, { headers: { Accept: "application/json", ...(headers as object) } });
    if (res.truncated) throw new ToolError("The JSON response is larger than the size limit.");
    try {
      return { status: res.status, data: JSON.parse(res.text) };
    } catch {
      throw new ToolError(`Response (HTTP ${res.status}) is not JSON: ${res.text.slice(0, 200)}`);
    }
  }

  @tool({ description: "Read a web page as plain text: its title and readable content without scripts, styles or markup.",
    input: s.object({ url }), readOnly: true,
    output: s.object({ title: s.string(), text: s.string(), url: s.string(), truncated: s.boolean() }) })
  async readPage({ url }: { url: string }) {
    const res = await this.fetch(url, { headers: { Accept: "text/html,*/*;q=0.8" } });
    if (!/html|xml|text/i.test(res.contentType)) {
      throw new ToolError(`${url} is ${res.contentType || "not a web page"}; use get for raw content.`);
    }
    return { title: decode(res.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim(), text: htmlToText(res.text), url: res.url, truncated: res.truncated };
  }

  @tool({ description: "Send data to a URL (POST by default; PUT, PATCH or DELETE). Use for APIs that change something.", input: PostInput })
  async post({ url, body, headers, method = "POST" }: Infer<typeof PostInput>) {
    const isString = typeof body === "string";
    const res = await this.fetch(url, {
      method,
      headers: { "Content-Type": isString ? "text/plain" : "application/json", ...(headers as object) },
      body: isString ? body : JSON.stringify(body),
    });
    let data: unknown = res.text;
    try {
      data = JSON.parse(res.text);
    } catch {
      // keep text
    }
    return { status: res.status, data };
  }

  /** fetch with SSRF protection: every hop is checked, redirects are followed
   *  by hand so a public URL can't bounce to a private address. */
  private async fetch(raw: string, init: RequestInit) {
    let target = this.check(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.checkAddress(target);
      const res = await fetch(target, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        target = this.check(new URL(location, target).toString());
        if (res.status === 303) init = { ...init, method: "GET", body: undefined };
        continue;
      }
      const { text, truncated } = await readCapped(res, Math.max(1, this.settings.maxKB || 1024) * 1024);
      return { status: res.status, url: target.toString(), contentType: res.headers.get("content-type") ?? "", text, truncated };
    }
    throw new ToolError("Too many redirects.");
  }

  private check(raw: string): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ToolError(`Not a valid URL: ${raw}`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ToolError("Only http and https URLs are allowed.");
    if (u.username || u.password) throw new ToolError("URLs with embedded credentials are not allowed.");
    const allowed = (this.settings.allowedSites ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean);
    const host = u.hostname.toLowerCase();
    if (allowed.length && !allowed.some((d) => host === d || host.endsWith("." + d))) {
      throw new ToolError(`${host} is not in Web's allowed sites (${allowed.join(", ")}). Ask the user to add it in Nexora (Web → Settings).`);
    }
    return u;
  }

  private async checkAddress(u: URL) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => {
      throw new ToolError(`Can't resolve ${host}.`);
    })).map((a) => a.address);
    if (host.toLowerCase() === "localhost" || host.endsWith(".local") || addrs.some(isBlockedAddress)) {
      throw new ToolError(`${host} is a local or private network address, which Web never contacts.`);
    }
  }
}

async function readCapped(res: Response, limit: number) {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > limit) {
      chunks.push(value.subarray(0, limit - size));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

function decode(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return named[e.toLowerCase()] ?? m;
  });
}

Web.run();
