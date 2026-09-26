import { t } from "@lingui/core/macro";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Input } from "@reactive-resume/ui/components/input";

type TagListFieldProps = {
	value: string[];
	onChange: (value: string[]) => void;
	placeholder?: string;
};

// Minimal chip input local to the stories feature (same shape as discovery's KeywordListField):
// type a tag and press Enter or comma to add it; entries render as removable chips.
export function TagListField({ value, onChange, placeholder }: TagListFieldProps) {
	const [draft, setDraft] = useState("");

	const add = () => {
		const tag = draft.trim();
		if (!tag || value.includes(tag)) {
			setDraft("");
			return;
		}
		onChange([...value, tag]);
		setDraft("");
	};

	return (
		<div className="flex flex-col gap-2">
			<Input
				value={draft}
				placeholder={placeholder ?? t`Add a tag and press Enter…`}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === ",") {
						event.preventDefault();
						add();
					}
				}}
				onBlur={add}
			/>
			{value.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{value.map((tag) => (
						<span
							key={tag}
							className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs"
						>
							{tag}
							<button
								type="button"
								title={t`Remove tag`}
								className="hover:text-destructive"
								onClick={() => onChange(value.filter((entry) => entry !== tag))}
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}
		</div>
	);
}
