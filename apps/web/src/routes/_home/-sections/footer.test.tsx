// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

vi.stubGlobal("__APP_VERSION__", "9.9.9");

// The footer module evaluates `t` calls at module scope, so the locale must be active before the import.
i18n.loadAndActivate({ locale: "en", messages: {} });

const { Footer } = await import("./footer");

const renderFooter = () =>
	render(
		<I18nProvider i18n={i18n}>
			<Footer />
		</I18nProvider>,
	);

describe("Footer", () => {
	it("renders only the Resources link group", () => {
		renderFooter();
		expect(screen.getByText("Resources")).toBeInTheDocument();
		expect(screen.queryByText("Community")).not.toBeInTheDocument();
	});

	it("keeps the documentation link and drops promotional links", () => {
		const { container } = renderFooter();
		const text = container.textContent ?? "";
		expect(text).toContain("Documentation");
		for (const label of ["Sponsorships", "Changelog", "Report an issue", "Translations", "Subreddit", "Discord"]) {
			expect(text, label).not.toContain(label);
		}
	});

	it("links nowhere promotional or personal", () => {
		const { container } = renderFooter();
		const hrefs = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).map((a) => a.href);
		expect(hrefs.some((h) => h.includes("docs.rxresu.me"))).toBe(true);
		expect(hrefs.some((h) => /opencollective|sponsors|linkedin\.com|x\.com|discord|reddit|crowdin/.test(h))).toBe(
			false,
		);
	});

	it("includes Reactive Resume version copy via Copyright", () => {
		renderFooter();
		// The version is wrapped in <bdi> for RTL isolation, so it is its own text node.
		expect(screen.getByText("9.9.9")).toBeInTheDocument();
	});
});
