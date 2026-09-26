import { t } from "@lingui/core/macro";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Input } from "@reactive-resume/ui/components/input";

type KeywordListFieldProps = {
	value: string[];
	onChange: (value: string[]) => void;
	placeholder?: string;
};

// Minimal chip input local to the discovery feature (same shape as the applications TagsField):
// type a keyword and press Enter or comma to add it; entries render as removable chips.
export function KeywordListField({ value, onChange, placeholder }: KeywordListFieldProps) {
	const [draft, setDraft] = useState("");

	const add = () => {
		const keyword = draft.trim();
		if (!keyword || value.includes(keyword)) {
			setDraft("");
			return;
		}
		onChange([...value, keyword]);
		setDraft("");
	};

	return (
		<div className="flex flex-col gap-2">
			<Input
				value={draft}
				placeholder={placeholder ?? t`Add a keyword and press Enter…`}
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
					{value.map((keyword) => (
						<span
							key={keyword}
							className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs"
						>
							{keyword}
							<button
								type="button"
								title={t`Remove keyword`}
								className="hover:text-destructive"
								onClick={() => onChange(value.filter((entry) => entry !== keyword))}
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
