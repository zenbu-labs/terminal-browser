import type { Element, ElementContent, Root } from "hast";
import type { Options as SanitizeSchema } from "rehype-sanitize" with { "resolution-mode": "import" };

import type { Theme } from "../ui/theme";
import { escape, pageColors } from "./scheme";

export const MARKDOWN_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' https: http: data:",
  "media-src 'self' https: http: data:",
  "font-src 'self' data:",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const VIDEO = /\.(?:mp4|m4v|webm|mov|ogv)$/i;
const AUDIO = /\.(?:mp3|m4a|wav|ogg|oga|flac|aac)$/i;
const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*/i;
// fixme: placeholder copy
const ALERT_TITLES: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};
const BODY_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const MONO_FONT = `ui-monospace, SFMono-Regular, Menlo, monospace`;

const SVG_TAGS = [
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "marker", "pattern", "clipPath", "mask",
  "linearGradient", "radialGradient", "stop", "image",
];

const SVG_ATTRIBUTES = [
  "className", "id", "viewBox", "preserveAspectRatio", "xmlns", "width", "height", "transform",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "d", "points",
  "fill", "fillOpacity", "fillRule", "clipRule", "stroke", "strokeWidth", "strokeOpacity",
  "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
  "opacity", "clipPath", "mask", "markerStart", "markerMid", "markerEnd",
  "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "textAnchor", "dominantBaseline", "letterSpacing",
  "offset", "stopColor", "stopOpacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy",
  "patternUnits", "patternTransform", "patternContentUnits", "clipPathUnits", "maskUnits", "maskContentUnits",
  "href", "xLinkHref", "visibility", "display", "vectorEffect", "pathLength",
];

const pipeline = buildPipeline();

// look into me: why can't we import esm packages (this is why we are forcing through dynamic import)
async function buildPipeline() {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const { default: remarkFrontmatter } = await import("remark-frontmatter");
  const { default: remarkGfm } = await import("remark-gfm");
  const { default: remarkMath } = await import("remark-math");
  const { default: remarkRehype } = await import("remark-rehype");
  const { default: rehypeRaw } = await import("rehype-raw");
  const { default: rehypeSanitize, defaultSchema } = await import("rehype-sanitize");
  const { default: rehypeSlug } = await import("rehype-slug");
  const { default: rehypeKatex } = await import("rehype-katex");
  const { default: rehypeHighlight } = await import("rehype-highlight");
  const { default: rehypeStringify } = await import("rehype-stringify");
  const pele = await import("pele");

  const base = defaultSchema.attributes ?? {};
  const schema: SanitizeSchema = {
    ...defaultSchema,
    // the page cannot run scripts, so nothing can be confused by ids that
    // collide with globals; keeping them intact makes #anchors work
    clobber: [],
    strip: ["script", "style", "template", "noscript"],
    tagNames: [
      ...(defaultSchema.tagNames ?? []),
      "video", "audio", "source", "track", "picture", "figure", "figcaption",
      "mark", "abbr", "u", "small", "center",
      ...SVG_TAGS,
    ],
    attributes: {
      ...base,
      "*": [...(base["*"] ?? []), "className"],
      a: [...(base.a ?? []), "target"],
      code: [["className", /^language-./, "math-inline", "math-display"]],
      img: [...(base.img ?? []), "loading"],
      video: ["src", "poster", "controls", "loop", "muted", "autoPlay", "playsInline", "preload"],
      audio: ["src", "controls", "loop", "muted", "preload"],
      source: ["src", "srcSet", "type", "media", "sizes"],
      track: ["src", "kind", "srcLang", "label", "default"],
      ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, SVG_ATTRIBUTES])),
    },
    protocols: {
      ...defaultSchema.protocols,
      src: ["http", "https", "data"],
      poster: ["http", "https", "data"],
      xLinkHref: ["http", "https"],
    },
  };

  const transform = () => (tree: Root) => {
    let diagrams = 0;
    const walk = (parent: Root | Element) =>
      parent.children.forEach((node, index) => {
        if (node.type !== "element") return;
        const replacement = mermaid(node, () => `diagram-${++diagrams}-`) ?? media(node) ?? alert(node);
        if (replacement) parent.children[index] = replacement;
        walk(node);
      });
    walk(tree);
  };

  function mermaid(node: Element, idPrefix: () => string): ElementContent | null {
    const code = node.tagName === "pre" ? node.children[0] : null;
    if (code?.type !== "element") return null;
    const language = code.properties.className;
    if (!Array.isArray(language) || !language.includes("language-mermaid")) return null;
    const source = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    try {
      const { svg } = pele.render(source, {
        idPrefix: idPrefix(),
        fontFamily: BODY_FONT,
        fontFamilyMono: MONO_FONT,
        links: false,
        images: false,
      });
      return element("div", { className: ["diagram"] }, [{ type: "raw", value: svg }]);
    } catch (error) {
      return element("div", { className: ["diagram-error"] }, [
        // fixme: placeholder copy
        element("p", {}, [text(`Could not render diagram: ${error instanceof Error ? error.message : String(error)}`)]),
        element("pre", {}, [element("code", {}, [text(source)])]),
      ]);
    }
  }

  function media(node: Element): Element | null {
    if (node.tagName !== "img" || typeof node.properties.src !== "string") return null;
    const src = node.properties.src;
    const path = src.split(/[?#]/)[0];
    const tag = VIDEO.test(path) ? "video" : AUDIO.test(path) ? "audio" : null;
    if (!tag) return null;
    return element(tag, { src, controls: true, preload: "metadata", title: node.properties.alt ?? undefined }, []);
  }

  function alert(node: Element): Element | null {
    if (node.tagName !== "blockquote") return null;
    const paragraph = node.children.find((child): child is Element => child.type === "element");
    const first = paragraph?.tagName === "p" ? paragraph.children[0] : undefined;
    if (first?.type !== "text") return null;
    const match = ALERT.exec(first.value);
    if (!match) return null;
    const kind = match[1].toLowerCase();
    first.value = first.value.slice(match[0].length);
    return element("div", { className: ["alert", `alert-${kind}`] }, [
      element("p", { className: ["alert-title"] }, [text(ALERT_TITLES[kind])]),
      ...node.children,
    ]);
  }

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml", "toml"])
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    // everything after sanitizing builds trusted markup from the cleaned tree
    .use(rehypeSlug)
    .use(transform)
    .use(rehypeKatex, { output: "mathml", trust: false })
    .use(rehypeHighlight, { plainText: ["mermaid"] })
    .use(rehypeStringify, { allowDangerousHtml: true });

  return async (source: string) => String(await processor.process(source));
}

function element(tagName: string, properties: Element["properties"], children: ElementContent[]): Element {
  return { type: "element", tagName, properties, children };
}

function text(value: string): ElementContent {
  return { type: "text", value };
}

export async function renderMarkdown(source: string, title: string, theme: Theme | null): Promise<string> {
  const body = await (await pipeline)(source);
  const { bg, fg, muted, accent, hairline, field, red, green, yellow, magenta, cyan } = pageColors(theme);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  :root { color-scheme: dark light; }
  html, body { margin: 0; background: transparent; color: ${fg}; }
  body { font: 15px/1.65 ${BODY_FONT}; padding: 32px 40px 64px; max-width: 860px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
  h1 { font-size: 1.8em; margin-top: 0; padding-bottom: 0.3em; border-bottom: 1px solid ${hairline}; }
  h2 { font-size: 1.35em; padding-bottom: 0.25em; border-bottom: 1px solid ${hairline}; }
  h3 { font-size: 1.1em; } h4, h5, h6 { font-size: 1em; } h6 { color: ${muted}; }
  p, ul, ol, dl, pre, table, blockquote, details, figure, .diagram, .alert { margin: 0 0 1em; }
  li + li { margin-top: 0.25em; } li > ul, li > ol { margin: 0.25em 0 0; }
  a { color: ${accent}; text-decoration: none; } a:hover { text-decoration: underline; }
  code, pre, kbd { font: 13px/1.5 ${MONO_FONT}; }
  code { background: ${field}; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { background: ${field}; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  kbd { border: 1px solid ${hairline}; border-bottom-width: 2px; border-radius: 4px; padding: 0 0.35em; font-size: 0.85em; }
  mark { background: ${yellow}; color: ${bg}; border-radius: 2px; padding: 0 0.15em; }
  blockquote { color: ${muted}; border-left: 3px solid ${hairline}; margin-left: 0; padding-left: 14px; }
  hr { border: 0; border-top: 1px solid ${hairline}; margin: 2em 0; }
  table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
  th, td { border: 1px solid ${hairline}; padding: 6px 12px; text-align: left; }
  th { font-weight: 600; } tr:nth-child(2n) td { background: ${field}; }
  th[align="center"], td[align="center"] { text-align: center; } th[align="right"], td[align="right"] { text-align: right; }
  img, video, svg { max-width: 100%; height: auto; }
  video { border-radius: 6px; display: block; } audio { width: 100%; max-width: 480px; }
  figcaption { color: ${muted}; font-size: 0.9em; text-align: center; }
  details { border: 1px solid ${hairline}; border-radius: 6px; padding: 8px 12px; }
  summary { cursor: pointer; font-weight: 600; } details[open] > summary { margin-bottom: 0.5em; }
  ul.contains-task-list { list-style: none; padding-left: 0.5em; } .task-list-item input { margin: 0 0.4em 0 0; }
  .footnotes { color: ${muted}; font-size: 0.9em; border-top: 1px solid ${hairline}; margin-top: 2.5em; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  math[display="block"] { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }
  .alert { border-left: 3px solid var(--alert); padding: 4px 0 4px 14px; }
  .alert > :last-child { margin-bottom: 0; }
  .alert-title { color: var(--alert); font-weight: 600; margin-bottom: 0.25em; }
  .alert-note { --alert: ${accent}; } .alert-tip { --alert: ${green}; } .alert-important { --alert: ${magenta}; }
  .alert-warning { --alert: ${yellow}; } .alert-caution { --alert: ${red}; }
  .diagram { overflow-x: auto; }
  .diagram-error { border-left: 3px solid ${red}; padding-left: 14px; } .diagram-error > p { color: ${red}; }
  .pele {
    --pele-bg: ${bg}; --pele-fg: ${fg}; --pele-muted: ${muted}; --pele-line: ${muted};
    --pele-surface: ${field}; --pele-surface-alt: ${hairline}; --pele-border: ${muted}; --pele-accent: ${accent};
    --pele-font: ${BODY_FONT}; --pele-font-mono: ${MONO_FONT};
    --pele-series-1: ${accent}; --pele-series-2: ${green}; --pele-series-3: ${yellow}; --pele-series-4: ${magenta};
    --pele-series-5: ${cyan}; --pele-series-6: ${red}; --pele-series-7: ${muted}; --pele-series-8: ${fg};
  }
  .hljs-comment, .hljs-quote, .hljs-meta { color: ${muted}; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-doctag { color: ${magenta}; }
  .hljs-string, .hljs-regexp, .hljs-addition, .hljs-template-tag { color: ${green}; }
  .hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet { color: ${yellow}; }
  .hljs-title, .hljs-section, .hljs-function .hljs-title { color: ${accent}; }
  .hljs-type, .hljs-class .hljs-title, .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: ${cyan}; }
  .hljs-name, .hljs-tag, .hljs-selector-id, .hljs-selector-class, .hljs-deletion { color: ${red}; }
  .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
</style></head>
<body>${body}</body></html>`;
}
