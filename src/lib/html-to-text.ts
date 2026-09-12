// Bounded HTML-to-text conversion for email bodies: structural tags become
// line breaks, non-visible content is dropped, and entities are decoded. Not
// a parser — operates on the well-formed HTML this API accepts.

const BLOCK_TAGS = new Set(
  "address article aside blockquote body caption center div dd dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html li main nav ol p pre section table tbody tfoot thead ul".split(
    " ",
  ),
);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  sect: "§",
  para: "¶",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (
          Number.isNaN(code) ||
          code < 0x20 ||
          code === 0x7f ||
          (code >= 0x80 && code <= 0x9f) ||
          (code >= 0xd800 && code <= 0xdfff) ||
          code > 0x10ffff
        ) {
          return "";
        }
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

function attributeValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(
    new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

const MAX_TAG_NAME = 24;

// Length-preserving fold, so an index found in the folded copy still addresses
// the same character in the original. String.toLowerCase does not preserve
// length ("\u0130" folds to two characters) and tag names and closers are ASCII.
function asciiLower(html: string): string {
  return html.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function tagName(tag: string): string {
  return /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1].toLowerCase() ?? "";
}

function dropComments(html: string): string {
  let out = "";
  let cursor = 0;

  for (let start = html.indexOf("<!--"); start !== -1; start = html.indexOf("<!--", cursor)) {
    const end = html.indexOf("-->", start + 4);
    if (end === -1) break;
    out += html.slice(cursor, start);
    cursor = end + 3;
  }

  return out + html.slice(cursor);
}

// Locates openers and closers with indexOf only, so unterminated markup costs
// one pass: a "<" with no ">" after it means no complete tag remains, and a
// closer missing from one position is missing from every later one. An opener
// whose closer is absent is left for the tag walk to render.
function replaceRegions(
  html: string,
  opens: (name: string) => boolean,
  closerFor: (name: string) => string,
  render: (attrs: string, inner: string) => string,
): string {
  const lower = asciiLower(html);
  const exhausted = new Set<string>();
  let out = "";
  let cursor = 0;
  let search = 0;
  let openerEnd = -1;

  for (let start = html.indexOf("<", search); start !== -1; start = html.indexOf("<", search)) {
    if (openerEnd <= start) openerEnd = html.indexOf(">", start + 1);
    if (openerEnd === -1) break;

    const name = tagName(html.slice(start, Math.min(openerEnd + 1, start + MAX_TAG_NAME)));
    const closer = opens(name) ? closerFor(name) : "";
    const end =
      closer && !exhausted.has(closer) ? lower.indexOf(closer, openerEnd + 1) : -1;
    if (end === -1) {
      if (closer) exhausted.add(closer);
      search = start + 1;
      continue;
    }

    out +=
      html.slice(cursor, start) +
      render(html.slice(start + 1 + name.length, openerEnd), html.slice(openerEnd + 1, end));
    cursor = end + closer.length;
    search = cursor;
  }

  return out + html.slice(cursor);
}

const HIDDEN_TAGS = new Set(["head", "script", "style"]);

function tagText(tag: string): string {
  const name = tagName(tag);
  const closing = tag[1] === "/";
  if (name === "br") return "\n";
  if (name === "img") return closing ? "" : (attributeValue(tag, "alt")?.trim() ?? "");
  if (name === "td" || name === "th") return " ";
  if (name === "tr") return closing ? "" : "\n";
  return BLOCK_TAGS.has(name) ? "\n" : "";
}

// Walks tag by tag with indexOf so a document of unclosed openers costs one
// pass. A trailing "<" with no ">" is left as plain text.
function renderTags(html: string, render: (tag: string) => string): string {
  let out = "";
  let cursor = 0;

  for (let start = html.indexOf("<"); start !== -1; start = html.indexOf("<", cursor)) {
    const end = html.indexOf(">", start + 1);
    if (end === -1) break;
    out += html.slice(cursor, start) + render(html.slice(start, end + 1));
    cursor = end + 1;
  }

  return out + html.slice(cursor);
}

function stripTags(html: string): string {
  return renderTags(html, () => "");
}

function convertAnchor(attrs: string, inner: string): string {
  const href = attributeValue(attrs, "href");
  const label = stripTags(inner);
  if (!href || href.startsWith("#") || label.includes(href)) return inner;
  return `${inner} (${href})`;
}

export function htmlToText(html: string): string {
  const withoutHiddenTags = replaceRegions(
    dropComments(html),
    (name) => HIDDEN_TAGS.has(name),
    (name) => `</${name}>`,
    () => "",
  );
  const withAnchors = replaceRegions(
    withoutHiddenTags,
    (name) => name === "a",
    () => "</a>",
    convertAnchor,
  );
  return decodeEntities(renderTags(withAnchors, tagText))
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
