// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

vi.stubGlobal("__APP_VERSION__", "9.9.9");

i18n.loadAndActivate({ locale: "en", messages: {} });

const { AboutSettingsPage } = await import("./about");

describe("AboutSettingsPage", () => {
	it("credits the upstream project once, with a link, plus the license and version", () => {
		render(
			<I18nProvider i18n={i18n}>
				<AboutSettingsPage />
			</I18nProvider>,
		);

		const upstream = screen.getByRole("link", { name: "Reactive Resume" });
		expect(upstream.getAttribute("href")).toBe("https://github.com/reactive-resume/reactive-resume");
		expect(screen.getByText(/by Amruth Pillai/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "MIT" })).toBeInTheDocument();
		expect(screen.getByText("9.9.9")).toBeInTheDocument();
	});
});
