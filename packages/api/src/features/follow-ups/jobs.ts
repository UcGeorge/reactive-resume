import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { followUpsService } from "./service";

/** Daily sweep: materialize cadence follow-ups for every user with active applications.
 * The queue read also recomputes lazily; this keeps the digest and due counts fresh for
 * users who have not opened the app. */
export async function materializeAllFollowUps(): Promise<void> {
	const users = await db
		.selectDistinct({ userId: schema.application.userId })
		.from(schema.application)
		.where(and(eq(schema.application.archived, false), sql`${schema.application.status} NOT IN ('rejected', 'offer')`));
	for (const { userId } of users) {
		await followUpsService.recomputeAll({ userId }).catch((error) => {
			console.error("Follow-up materialize failed for a user", { userId, error });
		});
	}
}

/** Daily email digest of due follow-ups, opt-in per user, only when SMTP is configured. */
export async function sendFollowUpDigests(): Promise<void> {
	const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
	if (!smtpConfigured) return;

	const [{ sendEmail }, { FollowUpDigestEmail }] = await Promise.all([
		import("@reactive-resume/email/transport"),
		import("@reactive-resume/email/templates/follow-up-digest"),
	]);

	const candidates = await followUpsService.digestCandidates();
	for (const candidate of candidates) {
		const applications = await db
			.select({ id: schema.application.id, company: schema.application.company, role: schema.application.role })
			.from(schema.application)
			.where(eq(schema.application.userId, candidate.userId));
		const byId = new Map(applications.map((application) => [application.id, application]));

		const items = candidate.due.map((row) => {
			const application = byId.get(row.applicationId);
			return {
				company: application?.company ?? "Unknown company",
				role: application?.role ?? "Unknown role",
				dueAt: row.dueAt.toISOString().slice(0, 10),
				note: row.note,
			};
		});

		try {
			await sendEmail({
				to: candidate.email,
				subject: `${items.length} follow-up${items.length === 1 ? "" : "s"} due — Reactive Resume`,
				react: FollowUpDigestEmail({ name: candidate.name, items, appUrl: env.APP_URL }),
			});
			await followUpsService.markNotified(candidate.due.map((row) => row.id));
		} catch (error) {
			// A send failure leaves emailNotifiedAt null, so tomorrow's digest retries.
			console.error("Follow-up digest send failed", { userId: candidate.userId, error });
		}
	}
}
