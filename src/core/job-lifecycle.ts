import { z } from "zod";
import { JOB_KINDS, buildSubagentSteer, isSubagentFailure, type JobRecord, type JobResult } from "./contracts/jobs.ts";
import type { LhMessage } from "./native-messages.ts";
import type { LhViewMessage } from "./view.ts";

const resultMetadata = z.object({ subagentResult: z.object({ toolCallId: z.string() }) });
const jobTools = new Set(JOB_KINDS.map((kind) => `tool-${kind}`));

/** Legacy payloads retain their original transcript location; new artifacts own dispatch slots. */
export function artifactSlotsOf(messages: readonly LhViewMessage[]): ReadonlySet<string> {
	const legacy = new Set<string>();
	for (const message of messages) {
		const metadata = resultMetadata.safeParse(message.metadata);
		if (metadata.success && message.parts.some((part) => part.type === "data-subagent-artifact" &&
			typeof part.data === "object" && part.data !== null && "result" in part.data && part.data.result !== undefined)) {
			legacy.add(metadata.data.subagentResult.toolCallId);
		}
	}
	const slots = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			if (jobTools.has(part.type) && part.state === "output-available" && part.toolCallId && !legacy.has(part.toolCallId)) {
				slots.add(part.toolCallId);
			}
		}
	}
	return slots;
}

const resultSchemas = {
	demo: z.object({ title: z.string(), html: z.string(), tested: z.literal(true), notes: z.string().optional() }),
	visual: z.object({ svg: z.string(), notes: z.string().optional() }),
	research: z.object({ brief: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string() })) }),
	pdf: z.object({ path: z.string(), question: z.string(), brief: z.string(), pagesRead: z.array(z.number()).optional(), pagesConsulted: z.array(z.number()) })
		.transform((result) => ({ ...result, pagesRead: result.pagesRead ?? result.pagesConsulted })),
};

/** Parse persisted/network result data once before rendering or delivery. */
export function jobResult(job: Pick<JobRecord, "kind" | "result">): JobResult | null {
	const parsed = resultSchemas[job.kind].safeParse(job.result);
	return parsed.success ? parsed.data : null;
}

export function jobHasWork(job: JobRecord): boolean {
	return job.status === "running" || job.delivery?.state === "pending";
}

/** One completion write owns both the artifact and its durable notification. */
export function completedJob(job: JobRecord, result: JobResult): JobRecord {
	const failed = isSubagentFailure(job.kind, result);
	return {
		...job, result, status: failed ? "error" : "done",
		activity: failed ? "failed; awaiting teacher" : "ready; awaiting teacher",
		delivery: { state: "pending", message: buildSubagentSteer({ ...job, delivery: { state: "none" } }, result) },
	};
}

/** Legacy jobs embedded artifacts in transcript messages and used status for delivery. */
export function migrateJob(job: JobRecord, messages: readonly LhMessage[]): JobRecord {
	if (job.delivery) return job;
	const marker = messages.find((m) => m.id === `steer_${job.id}`);
	const result = jobResult(job);
	if (result) {
		const completed = completedJob(job, result);
		const details = marker && "details" in marker ? marker.details : undefined;
		const ui = z.object({ ui: z.object({ inverted: z.boolean().optional() }).optional() }).safeParse(details);
		return { ...completed, ui: job.ui ?? (ui.success ? ui.data.ui : undefined),
			delivery: marker || job.status === "done" ? { state: "delivered" } : job.status === "error"
				? { state: "cancelled" } : completed.delivery };
	}
	return { ...job, delivery: marker ? { state: "delivered" } : { state: "none" } };
}
