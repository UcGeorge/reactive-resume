import type { StoryProvenance } from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

export type StoryRow = typeof schema.story.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

type StoryFields = {
	title: string;
	theme?: string | undefined;
	situation?: string | undefined;
	task?: string | undefined;
	action?: string | undefined;
	result?: string | undefined;
	reflection?: string | undefined;
	tags?: string[] | undefined;
	provenance?: StoryProvenance | undefined;
	sourceResumeId?: string | null | undefined;
	sourceApplicationId?: string | null | undefined;
};

export const storiesService = {
	list: async (input: { userId: string }) => {
		const rows = await db
			.select()
			.from(schema.story)
			.where(eq(schema.story.userId, input.userId))
			.orderBy(desc(schema.story.updatedAt));
		return rows.map(stripUserId);
	},

	getById: async (input: { id: string; userId: string }): Promise<StoryRow> => {
		const [row] = await db
			.select()
			.from(schema.story)
			.where(and(eq(schema.story.id, input.id), eq(schema.story.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return row;
	},

	create: async (input: { userId: string } & StoryFields) => {
		const { userId, ...fields } = input;
		const [row] = await db
			.insert(schema.story)
			.values({ userId, ...fields })
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the story." });
		return stripUserId(row);
	},

	update: async (input: { id: string; userId: string } & { [K in keyof StoryFields]?: StoryFields[K] | undefined }) => {
		const { id, userId, ...fields } = input;
		const [row] = await db
			.update(schema.story)
			.set(fields)
			.where(and(eq(schema.story.id, id), eq(schema.story.userId, userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	delete: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.delete(schema.story)
			.where(and(eq(schema.story.id, input.id), eq(schema.story.userId, input.userId)))
			.returning({ id: schema.story.id });
		if (!row) throw new ORPCError("NOT_FOUND");
	},

	recordUse: async (input: { id: string; userId: string }): Promise<void> => {
		const row = await storiesService.getById(input);
		await db
			.update(schema.story)
			.set({ lastUsedAt: new Date(), timesUsed: row.timesUsed + 1 })
			.where(and(eq(schema.story.id, input.id), eq(schema.story.userId, input.userId)));
	},
};
