import type { ReactNode } from "react";
import { cn } from "@reactive-resume/utils/style";

type InsightCardProps = {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	className?: string;
};

// The shared section shell for the Insights page, matching the applications insights tiles.
export function InsightCard({ title, description, children, className }: InsightCardProps) {
	return (
		<section className={cn("rounded-xl border border-border p-5", className)}>
			<h3 className="font-semibold text-sm">{title}</h3>
			{description && <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>}
			<div className="mt-4">{children}</div>
		</section>
	);
}

type RateBarProps = {
	/** A 0..1 fraction. */
	rate: number;
	className?: string;
};

// A simple CSS percentage bar (no chart library), same look as the applications sources bars.
export function RateBar({ rate, className }: RateBarProps) {
	return (
		<div className={cn("flex items-center gap-3 text-xs", className)}>
			<div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-foreground/70"
					style={{ width: `${Math.min(Math.max(rate * 100, rate > 0 ? 3 : 0), 100)}%` }}
				/>
			</div>
			<span className="w-10 text-right text-muted-foreground tabular-nums">{Math.round(rate * 100)}%</span>
		</div>
	);
}
