import { createSelectSchema } from "drizzle-zod";
import z from "zod";
import * as schema from "@reactive-resume/db/schema";
import { followUpKindSchema, followUpStatusSchema } from "@reactive-resume/schema/career/data";

const followUpSchema = createSelectSchema(schema.followUp, {
	id: z.string(),
	applicationId: z.string(),
	kind: followUpKindSchema,
	dueAt: z.date(),
	status: followUpStatusSchema,
	note: z.string().nullable(),
	completedAt: z.date().nullable(),
	snoozedUntil: z.date().nullable(),
	emailNotifiedAt: z.date().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const followUpOutput = followUpSchema.omit({ userId: true });

const queueEntryOutput = followUpOutput.extend({
	application: z.object({
		id: z.string(),
		company: z.string(),
		role: z.string(),
		status: z.string(),
	}),
});

export const followUpDto = {
	queue: {
		input: z
			.object({ horizonDays: z.number().int().min(1).max(90).optional() })
			.optional()
			.default({}),
		output: z.array(queueEntryOutput),
	},
	dueCount: {
		input: z.object({}).optional().default({}),
		output: z.object({ due: z.number() }),
	},
	complete: {
		input: z.object({ id: z.string() }),
		output: followUpOutput,
	},
	snooze: {
		input: z.object({ id: z.string(), until: z.coerce.date() }),
		output: followUpOutput,
	},
	dismiss: {
		input: z.object({ id: z.string() }),
		output: followUpOutput,
	},
	createCustom: {
		input: z.object({
			applicationId: z.string(),
			dueAt: z.coerce.date(),
			note: z.string().trim().max(500).optional(),
		}),
		output: followUpOutput,
	},
	draft: {
		input: z.object({ id: z.string() }),
		output: z.object({ text: z.string() }),
	},
};
