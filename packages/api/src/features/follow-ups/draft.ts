import type { FollowUpKind } from "@reactive-resume/schema/career/data";
import { generateText } from "ai";
import { resolveModelForFeature } from "../ai/resolve-model";
import { evaluationsService } from "../evaluations/service";

type DraftApplication = {
	role: string;
	company: string;
	status: string;
	appliedAt: Date;
	contacts: { name: string; role: string; type: string }[];
};

type DraftFollowUp = { kind: FollowUpKind; dueAt: Date; note: string | null };

const KIND_FRAMING: Record<FollowUpKind, string> = {
	applied_first: "a first check-in after applying",
	applied_subsequent: "a second, later check-in after applying — even lighter touch than a first",
	post_interview_thanks: "a thank-you note after an interview, referencing the conversation warmly but briefly",
	responded: "a reply keeping momentum after the company responded",
	custom: "a follow-up the user scheduled themselves",
};

/** Draft a follow-up message with the cadence context (what kind of touch, days elapsed).
 * Voice: conversational tier applies (this is candidate-facing prose), grounded only in the
 * application's real facts. */
export async function draftFollowUpText(input: {
	userId: string;
	application: DraftApplication;
	followUp: DraftFollowUp;
}): Promise<string> {
	const { model } = await resolveModelForFeature(input.userId, "outreach");

	const profile = await evaluationsService.getCareerProfile({ userId: input.userId });
	const daysSinceApplied = Math.max(0, Math.floor((Date.now() - input.application.appliedAt.getTime()) / 86_400_000));
	const recruiter = input.application.contacts.find((contact) =>
		`${contact.type} ${contact.role}`.toLowerCase().includes("recruit"),
	);

	const { text } = await generateText({
		model,
		messages: [
			{
				role: "user",
				content: [
					`Write ${KIND_FRAMING[input.followUp.kind]} for this job application. 80-120 words, warm but not pushy, active voice, no em dashes, no buzzwords (no "excited", "perfect fit", "strong track record"), no placeholders like [Name] unless no contact is known. Return only the message text.`,
					`ROLE: ${input.application.role} at ${input.application.company}`,
					`CURRENT STAGE: ${input.application.status}; applied ${daysSinceApplied} days ago.`,
					recruiter ? `CONTACT: ${recruiter.name} (${recruiter.role || recruiter.type})` : "CONTACT: none known.",
					input.followUp.note ? `CADENCE CONTEXT: ${input.followUp.note}` : "",
					profile?.voiceNotes ? `VOICE NOTES (style only, never content): ${profile.voiceNotes}` : "",
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
	});
	return text.trim();
}
