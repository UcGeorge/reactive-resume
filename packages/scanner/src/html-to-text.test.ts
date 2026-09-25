import { describe, expect, it } from "vitest";
import { DESCRIPTION_CAP, decodeEntities, htmlToText } from "./html-to-text";

/** A realistic ATS job-description body, as Greenhouse ships it with content=true: entity-escaped markup. */
const ESCAPED_JD =
	"&lt;div&gt;&lt;h2&gt;Senior Backend Engineer&lt;/h2&gt;" +
	"&lt;p&gt;Build &amp;amp; run our billing platform.&lt;/p&gt;" +
	"&lt;ul&gt;&lt;li&gt;5+ years with Node.js&lt;/li&gt;&lt;li&gt;Fluent Fran&amp;ccedil;ais a plus&lt;/li&gt;&lt;/ul&gt;" +
	"&lt;script&gt;alert(1)&lt;/script&gt;&lt;/div&gt;";

describe("decodeEntities", () => {
	it("decodes the XML five, nbsp, and numeric references in both bases", () => {
		expect(decodeEntities("&amp;")).toBe("&");
		expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
		expect(decodeEntities("&quot;&#39;")).toBe(`"'`);
		expect(decodeEntities("&nbsp;")).toBe(" ");
		expect(decodeEntities("&#252;")).toBe("ü");
		expect(decodeEntities("&#xFC;")).toBe("ü");
	});

	it("is case-sensitive for letter entities and case-insensitive only for the XML five", () => {
		expect(decodeEntities("&Eacute;&eacute;&AMP;")).toBe("Éé&");
	});

	it("leaves unknown and malformed references untouched", () => {
		expect(decodeEntities("&unknown; &#1a2; &#;")).toBe("&unknown; &#1a2; &#;");
	});

	it("refuses to emit non-XML-Char code points (NUL, C0 controls, noncharacters, out of range)", () => {
		expect(decodeEntities("&#0;&#8;&#xFFFF;&#99999999;")).toBe("&#0;&#8;&#xFFFF;&#99999999;");
	});
});

describe("htmlToText", () => {
	it("returns empty for non-string input", () => {
		expect(htmlToText(undefined)).toBe("");
		expect(htmlToText(null)).toBe("");
		expect(htmlToText(42)).toBe("");
		expect(htmlToText("")).toBe("");
	});

	it("strips plain markup and collapses whitespace", () => {
		expect(htmlToText("<p>Hello   <b>world</b></p>\n<p>again</p>")).toBe("Hello world again");
	});

	it("double-decodes the entity-escaped markup ATS payloads ship", () => {
		expect(htmlToText(ESCAPED_JD)).toBe(
			"Senior Backend Engineer Build & run our billing platform. 5+ years with Node.js Fluent Français a plus",
		);
	});

	it("removes script and style blocks with their contents", () => {
		expect(htmlToText("<style>.x{color:red}</style><p>Visible</p><script>steal()</script>")).toBe("Visible");
	});

	it("does not leak attribute soup from tags whose attributes contain angle brackets", () => {
		expect(htmlToText('<a href="/x" title="a > b">link</a>')).toBe("link");
	});

	it("neutralizes a trailing incomplete tag opener instead of hiding its text", () => {
		expect(htmlToText("Apply now <a href=")).toBe("Apply now a href=");
	});

	it("caps the output at DESCRIPTION_CAP characters", () => {
		expect(htmlToText(`<p>${"word ".repeat(2000)}</p>`)).toHaveLength(DESCRIPTION_CAP);
	});
});
