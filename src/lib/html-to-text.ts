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

// Scans for each opener and locates its closer with indexOf, so a document full
// of unclosed tags costs one pass rather than one scan per opener. An opener
// with no closer is left in place for the generic tag stripper to remove; once a
// closer is missing from a position it is missing from every later one, so that
// closer is not searched for again.
function replaceRegions(
  html: string,
  open: RegExp,
  closerFor: (match: RegExpExecArray) => string,
  render: (match: RegExpExecArray, inner: string) => string,
): string {
  const lower = html.toLowerCase();
  const exhausted = new Set<string>();
  let out = "";
  let cursor = 0;
  open.lastIndex = 0;

  for (let match = open.exec(html); match; match = open.exec(html)) {
    const contentStart = match.index + match[0].length;
    const closer = closerFor(match);
    const end = exhausted.has(closer) ? -1 : lower.indexOf(closer, contentStart);
    if (end === -1) {
      exhausted.add(closer);
      open.lastIndex = contentStart;
      continue;
    }
    out += html.slice(cursor, match.index) + render(match, html.slice(contentStart, end));
    cursor = end + closer.length;
    open.lastIndex = cursor;
  }

  return out + html.slice(cursor);
}

function tagName(tag: string): string {
  return /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1].toLowerCase() ?? "";
}

function tagText(tag: string): string {
  const name = tagName(tag);
  const closing = tag[1] === "/";
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
  const withoutComments = replaceRegions(
    html,
    /<!--/g,
    () => "-->",
    () => "",
  );
  const withoutHiddenTags = replaceRegions(
    withoutComments,
    /<(head|script|style)\b[^>]*>/gi,
    (match) => `</${match[1].toLowerCase()}>`,
    () => "",
  );
  const withAnchors = replaceRegions(
    withoutHiddenTags.replace(/<br\s*\/?\s*>/gi, "\n"),
    /<a\b([^>]*)>/gi,
    () => "</a>",
    (match, inner) => convertAnchor(match[1], inner),
  );
  return decodeEntities(renderTags(withAnchors, tagText))
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
