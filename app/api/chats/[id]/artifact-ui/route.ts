/**
 * THE ARTIFACT-UI ROUTE (owner, 2026-10-07): persists the learner's invert
 * switch onto a demo/figure steer message (details.ui.inverted) so it
 * survives session navigation and restarts. Modeled on the dismissal
 * route's SILENCE: no wake, no agent, no tokens, no SSE — the record is
 * the only state that moves, and the client already holds the toggled
 * state optimistically (no refetch churn).
 *
 * Guards: 404 unknown chat, 400 for a body that isn't
 * { input: { messageId, inverted } } or targets no demo/visual steer.
 */
import { setSteerUiInverted, type SteerDetails } from "@/src/core";
import { getChat, stores } from "@/src/server";
import { z } from "zod";

const targetSchema = z.union([
	z.object({ artifactId: z.string().regex(/^[A-Za-z0-9_-]+$/), inverted: z.boolean() }).strict(),
	z.object({ messageId: z.string(), inverted: z.boolean() }).strict(),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const parsed = z.object({ input: targetSchema }).safeParse(await req.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "input must identify an artifact or message and a boolean inverted value" }, { status: 400 });
	const input = parsed.data.input;
	if ("artifactId" in input) {
		const job = stores.jobStore.getJob(input.artifactId);
		if (!job || job.chatId !== id || !job.result || (job.kind !== "demo" && job.kind !== "visual")) {
			return Response.json({ error: "No demo/figure artifact with that id" }, { status: 400 });
		}
		stores.jobStore.updateJob(job.id, { ui: { ...job.ui, inverted: input.inverted } });
		return Response.json({ ok: true });
	}

	// Honesty: the target must actually be a demo/figure steer.
	const target = chat.messages.find((m) => m.id === input.messageId);
	const details = target ? ((target as { details?: unknown }).details as Partial<SteerDetails> | undefined) : undefined;
	if (!details || (details.kind !== "demo" && details.kind !== "visual")) {
		return Response.json({ error: "No demo/figure steer with that message id" }, { status: 400 });
	}
	if (typeof details.artifactId === "string") {
		const job = stores.jobStore.getJob(details.artifactId);
		if (!job || job.chatId !== id) return Response.json({ error: "Artifact unavailable" }, { status: 400 });
		stores.jobStore.updateJob(job.id, { ui: { ...job.ui, inverted: input.inverted } });
		return Response.json({ ok: true });
	}

	const messages = setSteerUiInverted(chat.messages, input.messageId, input.inverted);
	stores.chatStore.saveMessages(id, messages);
	return Response.json({ ok: true });
}
