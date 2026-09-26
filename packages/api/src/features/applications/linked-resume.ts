import { and, eq, inArray } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

/**
 * Attach the linked resume's name to application rows in one query. The application row
 * stores only `resumeId`; without this, every surface that shows the link (detail sheet,
 * board card, MCP) has to look the name up itself — or, as the detail sheet did, not show it.
 */
export async function withResumeNames<T extends { resumeId: string | null }>(
	userId: string,
	rows: T[],
): Promise<(T & { resumeName: string | null })[]> {
	const ids = [...new Set(rows.flatMap((row) => (row.resumeId ? [row.resumeId] : [])))];
	const names = new Map<string, string>();
	if (ids.length > 0) {
		const resumes = await db
			.select({ id: schema.resume.id, name: schema.resume.name })
			.from(schema.resume)
			.where(and(eq(schema.resume.userId, userId), inArray(schema.resume.id, ids)));
		for (const resume of resumes) names.set(resume.id, resume.name);
	}
	return rows.map((row) => ({ ...row, resumeName: row.resumeId ? (names.get(row.resumeId) ?? null) : null }));
}

export async function withResumeName<T extends { resumeId: string | null }>(
	userId: string,
	row: T,
): Promise<T & { resumeName: string | null }> {
	const [result] = await withResumeNames(userId, [row]);
	if (!result) throw new Error("withResumeNames returned no row for a single input row");
	return result;
}
