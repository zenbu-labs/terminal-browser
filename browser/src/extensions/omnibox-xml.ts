export type DescriptionStyle = "match" | "dim" | "url";

export interface DescriptionRun {
  text: string;
  styles: DescriptionStyle[];
}

const STYLES = new Set<string>(["match", "dim", "url"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Chrome parses omnibox descriptions as XML with libxml; failures read like libxml's.
function invalid(xml: string, message: string): Error {
  return new Error(`Invalid XML: bad content: Entity: line 1: parser error : ${message}\n${xml}`);
}

function lineAt(xml: string, index: number): number {
  return xml.slice(0, index).split("\n").length;
}

function decodeEntities(xml: string, text: string): string {
  return text.replace(/&([^;&<]*)(;?)/g, (_whole, name: string, semicolon: string) => {
    if (!semicolon) throw invalid(xml, "EntityRef: expecting ';'");
    const numeric = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(name);
    if (numeric) {
      const code = numeric[1][0].toLowerCase() === "x" ? parseInt(numeric[1].slice(1), 16) : parseInt(numeric[1], 10);
      return String.fromCodePoint(code);
    }
    const known = ENTITIES[name];
    if (known === undefined) throw invalid(xml, `Entity '${name}' not defined`);
    return known;
  });
}

export function parseDescription(description: string): DescriptionRun[] {
  const xml = `<fragment>${description}</fragment>`;
  const open: { name: string; line: number }[] = [];
  const runs: DescriptionRun[] = [];
  const tag = /<(\/?)([^\s/>]*)[^>]*?(\/?)>/g;
  let at = 0;
  const pushText = (raw: string) => {
    if (!raw) return;
    if (raw.includes("<")) throw invalid(xml, "StartTag: invalid element name");
    const text = decodeEntities(xml, raw);
    const styles = open.map((entry) => entry.name).filter((name): name is DescriptionStyle => STYLES.has(name));
    const last = runs.at(-1);
    if (last && last.styles.join() === styles.join()) last.text += text;
    else runs.push({ text, styles: [...new Set(styles)] });
  };
  for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
    pushText(xml.slice(at, match.index));
    at = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (!name) throw invalid(xml, "StartTag: invalid element name");
    if (selfClosing) continue;
    if (!closing) {
      open.push({ name, line: lineAt(xml, match.index) });
      continue;
    }
    const top = open.pop();
    if (!top) throw invalid(xml, "Extra content at the end of the document");
    if (top.name !== name) {
      throw invalid(xml, `Opening and ending tag mismatch: ${top.name} line ${top.line} and ${name}`);
    }
  }
  if (at < xml.length || open.length > 0) {
    throw invalid(xml, `Premature end of data in tag ${open.at(-1)?.name ?? "fragment"} line 1`);
  }
  return runs;
}

export function plainDescription(runs: DescriptionRun[]): string {
  return runs.map((run) => run.text).join("");
}
