"use client";

import { useContext } from "react";
import { jobResult, type JobKind } from "@/src/core";
import { ArtifactSlotsContext, JobsContext } from "@/components/jobs-context";
import { DispatchCard } from "./dispatch-card";
import { JobResultCard } from "./steer-card";

/** This location owns the artifact both before and after teacher delivery. */
export function JobArtifactCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const slots = useContext(ArtifactSlotsContext);
	const job = jobs.find((entry) => entry.toolCallId === toolCallId);
	const result = job && jobResult(job);
	if (!job || !result || (slots && !slots.has(toolCallId))) return <DispatchCard toolCallId={toolCallId} kind={kind} />;
	return (
		<div data-artifact-id={job.id}>
			<JobResultCard key={job.id} kind={job.kind} result={result} artifactId={job.id} ui={job.ui} />
			{job.delivery?.state === "failed" && <p className="mt-2 text-sm text-muted-foreground">Teacher notification failed. Your artifact is saved.</p>}
		</div>
	);
}
