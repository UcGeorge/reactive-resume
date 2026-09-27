import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { Copyright } from "@/components/ui/copyright";
import { UPSTREAM_REPO_URL } from "@/libs/links";

/** The one place the app credits its origin. Everything else that named upstream was promotional. */
export function AboutSettingsPage() {
	return (
		<m.div
			initial={{ y: -20 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
			className="grid max-w-xl gap-6 will-change-[transform,opacity]"
		>
			<p className="text-sm leading-relaxed">
				<Trans>
					Based on the open source project{" "}
					<a
						href={UPSTREAM_REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="font-medium underline underline-offset-2"
					>
						Reactive Resume
					</a>{" "}
					by Amruth Pillai.
				</Trans>
			</p>

			<Copyright />
		</m.div>
	);
}
