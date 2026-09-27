import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { m } from "motion/react";
import { cn } from "@reactive-resume/utils/style";
import { DOCS_URL, UPSTREAM_LICENSE_URL } from "@/libs/links";
import { wrap } from "./classes";

type FooterLink = { label: string } & (
	| { external: string }
	| { anchor: string }
	| { to: "/dashboard" | "/ats-checker" }
);
type FooterColumn = { title: string; links: FooterLink[] };

const getColumns = (): FooterColumn[] => [
	{
		title: t`Product`,
		links: [
			{ anchor: "#templates", label: t`Templates` },
			{ anchor: "#features", label: t`Features` },
			{ to: "/ats-checker", label: t`ATS Checker` },
			{ to: "/dashboard", label: t`Get Started` },
		],
	},
	{
		title: t`Resources`,
		links: [{ external: DOCS_URL, label: t`Documentation` }],
	},
];

const linkClass =
	"group/link inline-flex min-h-9 items-center gap-1 text-(--home-muted) text-[14px] [transition:color_150ms_ease] hover:text-(--home-ink)";
const arrowClass =
	"opacity-0 [transition:opacity_180ms_ease,transform_180ms_cubic-bezier(0.23,1,0.32,1)] group-hover/link:transform-[translate(1px,-1px)] group-hover/link:opacity-60";
const metaLinkClass = "text-(--home-ink) underline-offset-[3px] hover:underline";

function FooterColumnLink({ link }: { link: FooterLink }) {
	if ("external" in link) {
		return (
			<a href={link.external} target="_blank" rel="noopener noreferrer" className={linkClass}>
				{link.label}
				<span className="sr-only">
					<Trans>(opens in new tab)</Trans>
				</span>
				<ArrowUpRightIcon size={13} aria-hidden="true" className={arrowClass} />
			</a>
		);
	}

	if ("anchor" in link) {
		return (
			<a href={link.anchor} className={linkClass}>
				{link.label}
			</a>
		);
	}

	return (
		<Link to={link.to} className={linkClass}>
			{link.label}
		</Link>
	);
}

export function SiteFooter() {
	return (
		<footer id="footer" className="relative isolate z-1 overflow-clip border-(--home-line) border-t">
			{/* Warm light pooling under the wordmark, echoing the parallax planes behind the page. */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 -z-1 h-[78%] bg-[radial-gradient(125%_100%_at_50%_100%,rgb(196_166_140/13%)_0%,rgb(166_143_184/7%)_36%,transparent_70%)]"
			/>

			<div
				className={cn(
					wrap,
					"grid grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))] gap-x-8 gap-y-12 pt-[76px] max-[700px]:grid-cols-2 max-[700px]:gap-y-10 max-[540px]:pt-[52px]",
				)}
			>
				<div className="max-[700px]:col-span-full">
					<Link to="/" className="inline-flex items-center gap-[11px] font-[550] text-[17px] tracking-[-0.04em]">
						<img src="/icon/dark.svg" alt="" width="30" height="30" className="block" />
						<span>Reactive Resume</span>
					</Link>
					<p className="mt-[18px] max-w-[300px] text-(--home-muted) text-[14px] leading-[1.7]">
						<Trans>A free, open-source resume builder. Yours to keep, yours to export, yours to host.</Trans>
					</p>
				</div>

				{getColumns().map((column) => (
					<nav key={column.title} aria-label={column.title}>
						<h2 className="font-[Manrope_Variable,sans-serif] font-semibold text-[15px] tracking-[-0.03em]">
							{column.title}
						</h2>
						<ul className="mt-[18px] space-y-0.5">
							{column.links.map((link) => (
								<li key={link.label}>
									<FooterColumnLink link={link} />
								</li>
							))}
						</ul>
					</nav>
				))}
			</div>

			<div
				className={cn(
					wrap,
					"mt-[68px] flex items-center justify-between gap-x-8 gap-y-3 border-(--home-line) border-t pt-6 text-[#87878d] text-[12px] max-[540px]:mt-12 max-[700px]:flex-col max-[700px]:items-start",
				)}
			>
				<p>
					<Trans>
						Released under the{" "}
						<a href={UPSTREAM_LICENSE_URL} target="_blank" rel="noopener noreferrer" className={metaLinkClass}>
							MIT License
						</a>
						.
					</Trans>
				</p>
				<p>
					<bdi className="tabular-nums">v{__APP_VERSION__}</bdi>
				</p>
			</div>

			{/* Oversized wordmark, cropped by the footer edge so it reads as a watermark rather than a heading. */}
			<div className={cn(wrap, "@container mt-10 max-[540px]:mt-7")}>
				<m.p
					aria-hidden="true"
					className="select-none bg-gradient-to-b from-(--home-ink) from-45% to-[rgb(241_240_235/7%)] bg-clip-text font-[Manrope_Variable,sans-serif] font-bold text-[14.4cqw] text-transparent leading-[0.78] tracking-[-0.07em]"
					initial={{ opacity: 0, y: 24 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, amount: 0.3 }}
					transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
				>
					Reactive Resume
				</m.p>
			</div>
		</footer>
	);
}
