import { useQuery } from "@tanstack/react-query";
import { followUpsDueCountQueryOptions } from "./queries";

/** The number of pending follow-ups whose due date has passed — the badge count shared by the
 * Applications view switcher and any future surface. Returns 0 while loading or on error. */
export function useFollowUpsDueCount(): number {
	const { data } = useQuery(followUpsDueCountQueryOptions());
	return data?.due ?? 0;
}
