// Bounded HTML-to-text conversion for email bodies: structural tags become
// line breaks, non-visible content is dropped, and entities are decoded. Not
// a parser — operates on the well-formed HTML this API accepts.

const BLOCK_TAGS =
  "address|article|aside|blockquote|body|caption|center|div|dd|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|li|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|ul";

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

function convertAnchor(attrs: string, inner: string): string {
  const href = attributeValue(attrs, "href");
  const label = inner.replace(/<[^>]*>/g, "");
  if (!href || href.startsWith("#") || label.includes(href)) return inner;
  return `${inner} (${href})`;
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:head|script|style)\b[^>]*>[\s\S]*?<\/(?:head|script|style)>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs: string, inner: string) =>
      convertAnchor(attrs, inner),
    )
    .replace(/<img\b[^>]*>/gi, (tag) => attributeValue(tag, "alt")?.trim() ?? "")
    .replace(/<\/?t[dh]\b[^>]*>/gi, " ")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<\/tr\s*>/gi, "")
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*/?>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
