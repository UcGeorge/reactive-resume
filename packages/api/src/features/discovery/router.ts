import { ORPCError } from "@orpc/client";
import { env } from "@reactive-resume/env/server";
import { protectedProcedure } from "../../context";
import { discoveryDto } from "../../dto/discovery";
import { scannerRateLimit } from "../../middleware/rate-limit";
import { applicationService } from "../applications/service";
import { evaluationsService } from "../evaluations/service";
import { scanCompany, scanUser } from "./scan";
import { discoveryService, resolveScannerSettings } from "./service";

const reserved = { tags: ["Discovery"] } as const;

const discoveryErrors = {
	BAD_REQUEST: { message: "Invalid discovery request.", status: 400 },
	NOT_FOUND: { message: "Not found.", status: 404 },
};

function assertScannerEnabled() {
	if (env.FLAG_DISABLE_JOB_SCANNER) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The job scanner is disabled on this server (FLAG_DISABLE_JOB_SCANNER).",
		});
	}
}

export const discoveryRouter = {
	watchedCompanies: {
		list: protectedProcedure
			.route({ method: "GET", path: "/discovery/watched-companies", operationId: "listWatchedCompanies", ...reserved })
			.input(discoveryDto.watchedCompanies.list.input)
			.output(discoveryDto.watchedCompanies.list.output)
			.errors(discoveryErrors)
			.handler(({ context }) => discoveryService.listWatchedCompanies({ userId: context.user.id })),

		create: protectedProcedure
			.route({ method: "POST", path: "/discovery/watched-companies", operationId: "watchCompany", ...reserved })
			.input(discoveryDto.watchedCompanies.create.input)
			.output(discoveryDto.watchedCompanies.create.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) => {
				assertScannerEnabled();
				return discoveryService.createWatchedCompany({ userId: context.user.id, ...input });
			}),

		update: protectedProcedure
			.route({
				method: "PATCH",
				path: "/discovery/watched-companies/{id}",
				operationId: "updateWatchedCompany",
				...reserved,
			})
			.input(discoveryDto.watchedCompanies.update.input)
			.output(discoveryDto.watchedCompanies.update.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) => discoveryService.updateWatchedCompany({ userId: context.user.id, ...input })),

		delete: protectedProcedure
			.route({
				method: "DELETE",
				path: "/discovery/watched-companies/{id}",
				operationId: "unwatchCompany",
				...reserved,
			})
			.input(discoveryDto.watchedCompanies.delete.input)
			.output(discoveryDto.watchedCompanies.delete.output)
			.errors(discoveryErrors)
			.handler(async ({ context, input }) => {
				await discoveryService.deleteWatchedCompany({ id: input.id, userId: context.user.id });
			}),

		// One live fetch against the board — the onboarding "does it work?" moment.
		test: protectedProcedure
			.route({
				method: "POST",
				path: "/discovery/watched-companies/{id}/test",
				operationId: "testWatchedCompany",
				...reserved,
			})
			.input(discoveryDto.watchedCompanies.test.input)
			.use(scannerRateLimit)
			.output(discoveryDto.watchedCompanies.test.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) => {
				assertScannerEnabled();
				return scanCompany({ userId: context.user.id, watchedCompanyId: input.id, manual: true });
			}),
	},

	settings: {
		get: protectedProcedure
			.route({ method: "GET", path: "/discovery/settings", operationId: "getScannerSettings", ...reserved })
			.input(discoveryDto.settings.get.input)
			.output(discoveryDto.settings.get.output)
			.errors(discoveryErrors)
			.handler(async ({ context }) => {
				const profile = await evaluationsService.getCareerProfile({ userId: context.user.id });
				return resolveScannerSettings(profile?.scanner);
			}),

		update: protectedProcedure
			.route({ method: "PATCH", path: "/discovery/settings", operationId: "updateScannerSettings", ...reserved })
			.input(discoveryDto.settings.update.input)
			.output(discoveryDto.settings.update.output)
			.errors(discoveryErrors)
			.handler(async ({ context, input }) => {
				const profile = await evaluationsService.getCareerProfile({ userId: context.user.id });
				const merged = resolveScannerSettings({ ...resolveScannerSettings(profile?.scanner), ...input });
				await evaluationsService.upsertCareerProfile({ userId: context.user.id, scanner: merged });
				return merged;
			}),
	},

	// Run a scan immediately: everything watched, or one company. Deduped by singleton key
	// when the background worker runs it; inline (awaited) when background jobs are off.
	scanNow: protectedProcedure
		.route({ method: "POST", path: "/discovery/scan", operationId: "scanJobBoards", ...reserved })
		.input(discoveryDto.scanNow.input)
		.use(scannerRateLimit)
		.output(discoveryDto.scanNow.output)
		.errors(discoveryErrors)
		.handler(async ({ context, input }) => {
			assertScannerEnabled();
			const results = await scanUser({
				userId: context.user.id,
				...(input.watchedCompanyId ? { watchedCompanyId: input.watchedCompanyId } : {}),
				manual: true,
			});
			return { results };
		}),

	status: protectedProcedure
		.route({ method: "GET", path: "/discovery/status", operationId: "getDiscoveryStatus", ...reserved })
		.input(discoveryDto.status.input)
		.output(discoveryDto.status.output)
		.errors(discoveryErrors)
		.handler(async ({ context }) => {
			const [newCount, watches] = await Promise.all([
				discoveryService.countNewJobs({ userId: context.user.id }),
				discoveryService.listWatchedCompanies({ userId: context.user.id }),
			]);
			const lastScanAt = watches.reduce<Date | null>(
				(latest, watch) => (watch.lastScanAt && (!latest || watch.lastScanAt > latest) ? watch.lastScanAt : latest),
				null,
			);
			return {
				enabled: !env.FLAG_DISABLE_JOB_SCANNER,
				newCount,
				watchedCount: watches.length,
				lastScanAt,
			};
		}),

	jobs: {
		list: protectedProcedure
			.route({ method: "GET", path: "/discovery/jobs", operationId: "listDiscoveredJobs", ...reserved })
			.input(discoveryDto.jobs.list.input)
			.output(discoveryDto.jobs.list.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) =>
				discoveryService.listJobs({ userId: context.user.id, status: input.status, limit: input.limit }),
			),

		markSeen: protectedProcedure
			.route({ method: "POST", path: "/discovery/jobs/{id}/seen", operationId: "markDiscoveredJobSeen", ...reserved })
			.input(discoveryDto.jobs.markSeen.input)
			.output(discoveryDto.jobs.markSeen.output)
			.errors(discoveryErrors)
			.handler(async ({ context, input }) => {
				const job = await discoveryService.getJob({ id: input.id, userId: context.user.id });
				if (job.status !== "new") {
					const { userId: _userId, ...rest } = job;
					return rest;
				}
				return discoveryService.setJobStatus({ id: input.id, userId: context.user.id, status: "seen" });
			}),

		dismiss: protectedProcedure
			.route({ method: "POST", path: "/discovery/jobs/{id}/dismiss", operationId: "dismissDiscoveredJob", ...reserved })
			.input(discoveryDto.jobs.dismiss.input)
			.output(discoveryDto.jobs.dismiss.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) =>
				discoveryService.setJobStatus({ id: input.id, userId: context.user.id, status: "dismissed" }),
			),

		bulkDismiss: protectedProcedure
			.route({
				method: "POST",
				path: "/discovery/jobs/bulk-dismiss",
				operationId: "bulkDismissDiscoveredJobs",
				...reserved,
			})
			.input(discoveryDto.jobs.bulkDismiss.input)
			.output(discoveryDto.jobs.bulkDismiss.output)
			.errors(discoveryErrors)
			.handler(({ context, input }) => discoveryService.bulkDismiss({ ids: input.ids, userId: context.user.id })),

		// "Import to Applications": create a real tracker row (status saved) and back-link it.
		// From there every evaluation/tailoring feature applies.
		import: protectedProcedure
			.route({ method: "POST", path: "/discovery/jobs/{id}/import", operationId: "importDiscoveredJob", ...reserved })
			.input(discoveryDto.jobs.import.input)
			.output(discoveryDto.jobs.import.output)
			.errors(discoveryErrors)
			.handler(async ({ context, input }) => {
				const job = await discoveryService.getJob({ id: input.id, userId: context.user.id });
				if (job.status === "imported" && job.applicationId) return { applicationId: job.applicationId };

				const applicationId = await applicationService.create({
					userId: context.user.id,
					company: job.company,
					role: job.title,
					status: "saved",
					source: "Job scanner",
					sourceUrl: job.url,
					...(job.location ? { location: job.location } : {}),
					...(job.description ? { jobDescription: job.description.slice(0, 20_000) } : {}),
				});
				await discoveryService.setJobStatus({
					id: input.id,
					userId: context.user.id,
					status: "imported",
					applicationId,
				});
				return { applicationId };
			}),
	},
};
