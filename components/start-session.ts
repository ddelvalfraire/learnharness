import { z } from "zod";
import type { GraphContextPick } from "@/src/core";

const createdSession = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) });

/** Persist the opening prompt before navigating. URLs contain only the chat ID. */
export async function startSession({
	text,
	fetchLike = fetch,
	kind,
	picks = [],
}: {
	text: string;
	fetchLike?: typeof fetch;
	kind?: "practice";
	picks?: readonly GraphContextPick[];
}): Promise<string | null> {
	const prompt = text.trim();
	if (!prompt) return null;
	const res = await fetchLike("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt,
			...(kind ? { kind } : {}),
			...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}),
		}),
	});
	if (!res.ok) throw new Error(`Could not create the session (${res.status}).`);
	const { id } = createdSession.parse(await res.json());
	return `/chat/${id}`;
}
