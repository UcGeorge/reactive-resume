import type { AuditReport } from "@reactive-resume/schema/career/data";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { ORPCError } from "@orpc/client";
import z from "zod";
import { hmAuditSystemPrompt } from "@reactive-resume/ai/prompts";
import { htmlToMarkdown } from "@reactive-resume/resume/markdown";
import { generateJson } from "../ai/generate-json";
import { getModel } from "../ai/service";
import { aiProvidersService } from "../ai-providers/service";
import { resumeService } from "../resume/service";
import { tailoringService } from "./service";

/**
 * The opt-in hiring-manager audit (career-ops `pdf --hm-audit`): a separate adversarial
 * pass over an already-tailored resume. The fact gate proves nothing was invented; this
 * asks whether these are the RIGHT bullets — and whether the likely reviewer would advance
 * the application at all.
 *
 * The reviewer persona is synthesized from the posting alone and declared tier C — a
 * constructed reviewer built from the JD's actual signals (reports-to line, vocabulary,
 * scale), never a real person and never a stereotype. Research-grounded tiers A/B need
 * provider web search and are future work.
 */

const MAX_AUDIT_BULLETS = 40;

type AuditBullet = { index: number; text: string; where: string };

/** Bullets from the tailored resume's experience and project descriptions, numbered. */
export function collectAuditBullets(data: ResumeData): AuditBullet[] {
	const bullets: AuditBullet[] = [];
	const push = (markdown: string, where: string) => {
		for (const line of markdown.split("\n")) {
			const match = /^\s*[-*]\s+(.+)$/.exec(line);
			if (match?.[1]) bullets.push({ index: bullets.length + 1, text: match[1].trim(), where });
		}
	};

	for (const item of data.sections.experience.items) {
		if (item.hidden) continue;
		push(htmlToMarkdown(item.description), `${item.company}`);
		for (const role of item.roles) push(htmlToMarkdown(role.description), `${item.company} — ${role.position}`);
	}
	for (const item of data.sections.projects.items) {
		if (item.hidden) continue;
		push(htmlToMarkdown(item.description), `Project: ${item.name}`);
	}

	return bullets.slice(0, MAX_AUDIT_BULLETS);
}

const auditOutput = z.object({
	rows: z
		.array(
			z.object({
				index: z.coerce.number().int(),
				verdict: z.enum(["keep", "cut", "rewrite"]).catch("keep"),
				why: z.string().catch(""),
				rewrite: z.string().nullable().catch(null),
			}),
		)
		.catch([]),
	scopeRead: z.string().catch(""),
	wouldAdvance: z.boolean().catch(false),
	reason: z.string().catch(""),
});

export async function runHmAudit(input: {
	tailoringRunId: string;
	userId: string;
	locale: string;
}): Promise<AuditReport> {
	const run = await tailoringService.getById({ id: input.tailoringRunId, userId: input.userId });
	if (run.status !== "complete" || !run.tailoredResumeId) {
		throw new ORPCError("BAD_REQUEST", { message: "Only a completed tailoring run can be audited." });
	}

	const provider = await aiProvidersService.getDefaultRunnable({ userId: input.userId });
	if (!provider) {
		throw new ORPCError("BAD_REQUEST", {
			message: "No AI provider is configured. Add one in Settings → Integrations to use AI features.",
		});
	}
	const model = getModel({
		provider: provider.provider,
		model: provider.model,
		apiKey: provider.apiKey,
		...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
	});

	const tailored = await resumeService.getById({ id: run.tailoredResumeId, userId: input.userId });
	const bullets = collectAuditBullets(tailored.data);
	if (bullets.length === 0) {
		throw new ORPCError("BAD_REQUEST", { message: "The tailored resume has no bullets to audit." });
	}

	const persona =
		"Synthesized from the posting itself: its stated reporting line, the scale the description implies, and the JD's own vocabulary. Tier C — a constructed reviewer, not a real person.";

	const result = auditOutput.parse(
		await generateJson(
			model,
			{
				system: hmAuditSystemPrompt,
				prompt: [
					`LOCALE: write prose in ${input.locale || "en-US"}.`,
					`REVIEWER PERSONA (tier C): ${persona}`,
					`JOB DESCRIPTION:\n${run.jdArchived}`,
					`TAILORED BULLETS (${bullets.length} total — return exactly ${bullets.length} rows, numbered 1..${bullets.length}):\n${bullets
						.map((bullet) => `${bullet.index}. [${bullet.where}] ${bullet.text}`)
						.join("\n")}`,
					'Reminder, verbatim: "You may recommend cutting or reframing any bullet. You may never recommend a claim the source files do not support. If a requirement is unmet, say it is unmet — do not invent coverage for it."',
				].join("\n\n"),
			},
			auditOutput,
		),
	);

	const rowsByIndex = new Map(result.rows.map((row) => [row.index, row]));
	const rows = bullets.map((bullet) => {
		const row = rowsByIndex.get(bullet.index);
		return {
			index: bullet.index,
			bullet: bullet.text,
			verdict: row?.verdict ?? "keep",
			why: row?.why ?? "(no verdict returned for this bullet)",
			rewrite: row?.verdict === "rewrite" ? (row.rewrite ?? null) : null,
		};
	});

	const report: AuditReport = {
		tier: "C",
		persona,
		rows,
		scopeRead: result.scopeRead,
		wouldAdvance: result.wouldAdvance,
		reason: result.reason,
		// Said out loud, never papered over: a short table means some bullets went unjudged.
		incomplete: result.rows.length < bullets.length,
		createdAt: new Date().toISOString(),
	};

	await tailoringService.update({ id: run.id, userId: input.userId, auditReport: report });
	return report;
}
