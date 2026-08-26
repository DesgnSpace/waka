import { expect, test } from "bun:test";
import { htmlToText } from "./html-to-text";

test("decodes named and numeric HTML entities", () => {
  expect(htmlToText("<p>Fish &amp; Chips &copy; 2026 &#8212; caf&#xe9;</p>")).toBe(
    "Fish & Chips © 2026 — café",
  );
  expect(htmlToText("a&nbsp;b&#x27;s &#999999999; ok")).toBe("a b's ok");
});

test("drops head, style, and script content entirely", () => {
  expect(
    htmlToText(
      '<html><head><title>Newsletter</title><style>body { color: red }</style></head><body><script>track()</script><h1>Hello</h1></body></html>',
    ),
  ).toBe("Hello");
});

test("turns nested block elements into separate lines and paragraphs", () => {
  expect(
    htmlToText("<div><h1>Title</h1><div><p>Para one.</p><p>Para two.</p></div></div>"),
  ).toBe("Title\n\nPara one.\n\nPara two.");
});

test("converts br tags to line breaks", () => {
  expect(htmlToText("Line one<br>Line two<br />Line three")).toBe(
    "Line one\nLine two\nLine three",
  );
});

test("appends link targets in parentheses unless the text already has them", () => {
  expect(
    htmlToText('<p>See <a href="https://example.com/docs?x=1">the docs</a>.</p>'),
  ).toBe("See the docs (https://example.com/docs?x=1).");
  expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
    "https://example.com",
  );
  expect(htmlToText('<a href="#top">Back to top</a>')).toBe("Back to top");
});

test("keeps image alt text and drops unlabelled images", () => {
  expect(htmlToText('<p>Logo:</p><img src="logo.png" alt="ACME logo">')).toBe(
    "Logo:\nACME logo",
  );
  expect(htmlToText('Hi<img src="https://t.example/pixel" width="1" height="1">')).toBe(
    "Hi",
  );
});

test("lays out simple tables as rows of cells", () => {
  expect(
    htmlToText("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>"),
  ).toBe("A B\nC D");
});

test("returns empty output for empty and non-textual bodies", () => {
  expect(htmlToText("")).toBe("");
  expect(
    htmlToText('<img src="https://t.example/open?id=1" width="1" height="1" alt="">'),
  ).toBe("");
});
