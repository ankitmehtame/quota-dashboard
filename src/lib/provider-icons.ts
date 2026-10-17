import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SaxesParser } from "saxes";

// Sources: https://selfh.st/icons/ and https://thesvg.org/.
// Per-asset licenses and modifications: public/icons/ATTRIBUTION.md.
export const ICON_SOURCES = {
  claude: "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/claude.svg",
  openai: "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/openai-light.svg",
  openrouter: "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/openrouter-light.svg",
  ollama: "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/ollama.svg",
  hermes: "https://thesvg.org/icons/nousresearch-hermes/default.svg",
  antigravity: "https://thesvg.org/icons/google-antigravity/default.svg",
  opencode: "https://thesvg.org/icons/opencode/default.svg",
} as const;
export type IconId = keyof typeof ICON_SOURCES;
export const ICON_REFRESH_MS = 24 * 60 * 60 * 1000;
export const ICON_TIMEOUT_MS = 10_000;
export const MAX_ICON_BYTES = 128 * 1024;

export function isIconId(value: string): value is IconId {
  return Object.hasOwn(ICON_SOURCES, value);
}

const elements = new Set("svg g path circle ellipse rect line polyline polygon defs clipPath mask filter feBlend feFlood feGaussianBlur feComposite feOffset feColorMatrix linearGradient radialGradient stop use title desc".split(" "));
const attributes = new Set("viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points id fill stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset fill-rule clip-rule opacity fill-opacity stroke-opacity transform clip-path clipPathUnits mask maskUnits maskContentUnits filter filterUnits primitiveUnits color-interpolation-filters flood-color flood-opacity in in2 mode result stdDeviation operator k1 k2 k3 k4 dx dy type values offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr preserveAspectRatio color overflow mask-type".split(" "));
const styleProperties = new Set("fill stroke stroke-width fill-rule clip-rule opacity fill-opacity stroke-opacity clip-path overflow mask-type".split(" "));
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Parse XML, then serialize an allowlisted static SVG subset. Never trust SVG as text/HTML. */
export function validateIconSvg(input: string): string {
  if (Buffer.byteLength(input) > MAX_ICON_BYTES) throw new Error("SVG exceeds size limit");
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  const ids = new Set<string>();
  const references: string[] = [];
  const stack: string[] = [];
  let nodes = 0;
  let root = false;
  const safeValue = (value: string): string => {
    if (!/^[\w\s#.,%+():/\-]*$/.test(value)) throw new Error("Unsafe SVG attribute value");
    const withoutReferences = value.replace(/url\(\s*#([\w.:-]+)\s*\)/gi, (_, id: string) => { references.push(id); return ""; });
    if (/url\s*\(|:|\/\//i.test(withoutReferences)) throw new Error("External SVG reference");
    return value.replace(/\bcurrentColor\b/gi, "#f0f5f1");
  };
  parser.on("doctype", () => { throw new Error("SVG doctype is forbidden"); });
  parser.on("processinginstruction", () => { throw new Error("SVG processing instruction is forbidden"); });
  parser.on("opentag", (tag) => {
    if (++nodes > 2048 || stack.length >= 32 || !elements.has(tag.local) || tag.uri !== "http://www.w3.org/2000/svg") throw new Error("Unsupported SVG element");
    if (!root) {
      if (tag.local !== "svg") throw new Error("Expected SVG root");
      root = true;
    } else if (tag.local === "svg") throw new Error("Nested SVG is forbidden");
    const serialized: string[] = [];
    for (const attr of Object.values(tag.attributes)) {
      if (attr.uri === "http://www.w3.org/2000/xmlns/") {
        if (!["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"].includes(attr.value)) throw new Error("Unsupported SVG namespace");
        continue;
      }
      if (attr.name === "xml:space" && ["preserve", "default"].includes(attr.value)) continue;
      let name = attr.local;
      let value = attr.value;
      if (name === "href" && (!attr.uri || attr.uri === "http://www.w3.org/1999/xlink")) {
        if (!/^#[\w.:-]+$/.test(value)) throw new Error("External SVG href");
        references.push(value.slice(1));
      } else if (attr.uri) throw new Error("Unsupported SVG attribute namespace");
      else if (name === "style") {
        value = value.split(";").filter((part) => part.trim()).map((part) => {
          const colon = part.indexOf(":");
          const property = part.slice(0, colon).trim();
          if (colon < 0 || !styleProperties.has(property)) throw new Error("Unsupported SVG style");
          return `${property}:${safeValue(part.slice(colon + 1).trim())}`;
        }).join(";");
      } else {
        if (!attributes.has(name)) throw new Error("Unsupported SVG attribute");
        if (name === "id") {
          if (!/^[\w.-]+$/.test(value) || ids.has(value)) throw new Error("Invalid SVG id");
          ids.add(value);
        }
        value = safeValue(value);
      }
      serialized.push(`${name}="${escapeXml(value)}"`);
    }
    if (!stack.length) {
      serialized.push('xmlns="http://www.w3.org/2000/svg"');
    }
    if (new Set(serialized.map((attribute) => attribute.split("=")[0])).size !== serialized.length) throw new Error("Duplicate SVG attribute");
    output.push(`<${tag.local}${serialized.length ? " " + serialized.sort().join(" ") : ""}>`);
    stack.push(tag.local);
  });
  parser.on("closetag", () => { output.push(`</${stack.pop()}>`); });
  parser.on("text", (text) => {
    if (text.trim() && !["title", "desc"].includes(stack.at(-1) || "")) throw new Error("Unexpected SVG text");
    output.push(escapeXml(text));
  });
  parser.on("cdata", () => { throw new Error("SVG CDATA is forbidden"); });
  parser.write(input).close();
  if (!root || references.some((id) => !ids.has(id))) throw new Error("Invalid SVG references");
  return output.join("");
}

export function iconRevision(svg: string): string {
  return createHash("sha256").update(svg).digest("hex");
}

type IconState = { svg: string; revision: string; attemptedAt?: number; etag?: string; modified?: string };
type IconCacheOptions = { directory: string; bundledDirectory: string; fetch?: typeof fetch; now?: () => number; log?: (message: string) => void };

export function createIconCache(options: IconCacheOptions) {
  const fetchIcon = options.fetch || fetch;
  const now = options.now || Date.now;
  const states = new Map<IconId, Promise<IconState>>();
  let refreshing: Promise<void> | undefined;

  async function state(id: IconId): Promise<IconState> {
    let pending = states.get(id);
    if (!pending) {
      pending = (async () => {
        try {
          const cached = JSON.parse(await readFile(join(options.directory, `${id}.json`), "utf8"));
          if (cached.source !== ICON_SOURCES[id]) throw new Error("Icon source changed");
          const svg = validateIconSvg(cached.svg);
          return { svg, revision: iconRevision(svg), attemptedAt: typeof cached.attemptedAt === "number" && cached.attemptedAt <= now() ? cached.attemptedAt : undefined,
            etag: typeof cached.etag === "string" ? cached.etag : undefined, modified: typeof cached.modified === "string" ? cached.modified : undefined };
        } catch {
          const svg = validateIconSvg(await readFile(join(options.bundledDirectory, `${id}.svg`), "utf8"));
          return { svg, revision: iconRevision(svg) };
        }
      })();
      states.set(id, pending);
      void pending.catch(() => { if (states.get(id) === pending) states.delete(id); });
    }
    return pending;
  }

  async function persist(id: IconId, value: IconState): Promise<void> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const temporary = join(options.directory, `.${id}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ ...value, source: ICON_SOURCES[id] }), { mode: 0o600 });
      await rename(temporary, join(options.directory, `${id}.json`));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function update(id: IconId): Promise<void> {
    try {
      const current = await state(id);
      if (current.attemptedAt !== undefined && now() - current.attemptedAt < ICON_REFRESH_MS) return;
      current.attemptedAt = now();
      // Persist the attempt before networking, including failures, to bound retries across restarts.
      await persist(id, current);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS);
      try {
        const response = await fetchIcon(ICON_SOURCES[id], { redirect: "error", signal: controller.signal, headers: {
          Accept: "image/svg+xml", ...(current.etag ? { "If-None-Match": current.etag } : {}), ...(current.modified ? { "If-Modified-Since": current.modified } : {}),
        } });
        if (response.status === 304) return;
        if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim() !== "image/svg+xml" || Number(response.headers.get("content-length")) > MAX_ICON_BYTES || !response.body) {
          await response.body?.cancel();
          throw new Error("Invalid icon response");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_ICON_BYTES) throw new Error("Icon exceeds size limit");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const svg = validateIconSvg(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        const next = { svg, revision: iconRevision(svg), attemptedAt: current.attemptedAt, etag: response.headers.get("etag") || undefined, modified: response.headers.get("last-modified") || undefined };
        await persist(id, next);
        states.set(id, Promise.resolve(next));
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      options.log?.(`icon refresh failed id=${id}`);
    }
  }

  return {
    get: state,
    async manifest(): Promise<Record<string, string>> {
      return Object.fromEntries(await Promise.all((Object.keys(ICON_SOURCES) as IconId[]).map(async (id) => [id, (await state(id)).revision])));
    },
    refresh(): Promise<void> {
      if (!refreshing) refreshing = Promise.all((Object.keys(ICON_SOURCES) as IconId[]).map(update)).then(() => {}).finally(() => { refreshing = undefined; });
      return refreshing;
    },
  };
}
