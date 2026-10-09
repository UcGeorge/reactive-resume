import type { Messages } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";

const catalogs = import.meta.glob<{ messages: Messages }>("../../locales/*.po");

// These IDs appeared verbatim in production when the feature shipped without catalog extraction.
// Resolve IDs alone: development-mode macro defaults would hide missing catalog entries.
const labels = [
	["_omFb6", "Update existing resume in place"],
	["-Nwxkv", "Update this resume in place?"],
	["-DvbVt", "Keep creating a copy"],
	["kazTR1", "Update in place"],
	["3m-PLC", "Update the linked resume for this job"],
	["Yij7z2", "Tailoring will use your latest completed evaluation, including gaps and recommendations."],
	[
		"USYR45",
		"AI changes will modify the selected resume directly instead of creating a separate copy. Other applications and shared links using this resume will show those changes too. Review the changes carefully. You can use version history or the agent's undo controls to recover earlier content.",
	],
] as const;

describe("production tailoring translations", () => {
	it.each(Object.entries(catalogs))(
		"resolves labels and the risk warning from %s without message defaults",
		async (path, load) => {
			const locale = path.split("/").at(-1)?.replace(".po", "") ?? "en-US";
			const { messages } = await load();
			const i18n = setupI18n({ locale, messages: { [locale]: messages } });
			for (const [id, english] of labels) {
				const translated = i18n._(id);
				expect(translated, `${locale}: ${id}`).not.toBe(id);
				if (locale === "en-US" || locale === "en-GB") expect(translated).toBe(english);
			}
		},
	);
});
