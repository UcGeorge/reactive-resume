import { Trans } from "@lingui/react/macro";
import { cn } from "@reactive-resume/utils/style";
import { UPSTREAM_LICENSE_URL } from "@/libs/links";

type Props = React.ComponentProps<"div">;

export function Copyright({ className, ...props }: Props) {
	return (
		<div className={cn("text-muted-foreground/80 text-xs leading-relaxed", className)} {...props}>
			<p>
				<Trans>
					Licensed under{" "}
					<a
						href={UPSTREAM_LICENSE_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="font-medium underline underline-offset-2"
					>
						MIT
					</a>
					.
				</Trans>
			</p>

			<p className="mt-4">
				<Trans comment="App version label in footer; includes semantic version variable">
					Reactive Resume v<bdi>{__APP_VERSION__}</bdi>
				</Trans>
			</p>
		</div>
	);
}
