import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import { buildAnswer } from "../src/core/question-core.ts";

const questionInput = {
	question: "What is 2 + 2?",
	options: [{ label: "4", value: "four" }, { label: "5", value: "five" }],
	explanation: "Adding two and two gives four.",
	correctAnswer: "four",
};

function question(callId: string): LhMessage {
	return {
		id: `assistant-${callId}`,
		role: "assistant",
		api: "openai-completions",
		provider: "openrouter",
		model: "scripted",
		timestamp: 0,
		stopReason: "toolUse",
		usage: {
			input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
			cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
		},
		content: [{ type: "toolCall", id: callId, name: "probe", arguments: questionInput }],
	};
}

function answer(callId: string) {
	return buildAnswer({
		id: callId, kind: "quiz", question: questionInput.question, mode: "single-select",
		options: questionInput.options, correctIndices: [1], explanation: questionInput.explanation,
		createdAt: "2026-01-01T00:00:00Z",
	}, { values: ["four"], confidence: 50 }, "probe");
}

const old = question("old");
const current = question("current");
const canonical = [old, newAnswerResult("old", "probe", answer("old")), current];
const pending = (model: SessionModel) => findPendingToolCall(model.getState().messages)?.toolCallId ?? null;
const snapshot = (messages: LhMessage[], turnInFlight = false) => Response.json({ messages, turnInFlight });
const done = () => new Response("data: [DONE]\n\n");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("session snapshot synchronization", () => {
	it("does not resurrect an old question when a refresh finishes after an answer", async () => {
		const held = deferred<Response>();
		let reads = 0;
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => {
				if (url === "/api/chat") return Response.json({ ok: true });
				if (url === "/api/chats/sync/stream") return done();
				if (url === "/api/chats/sync") return reads++ === 0 ? held.promise : snapshot(canonical);
				throw new Error(`Unexpected URL: ${url}`);
			},
		});
		const staleRefresh = model.syncRecord();
		await model.submitAnswer("probe", "old", answer("old"));
		assert.equal(pending(model), "current");
		held.resolve(snapshot([old]));
		await staleRefresh;
		assert.equal(pending(model), "current", "a delayed refresh must not restore the answered question");
	});

	it("keeps the newer snapshot when two refreshes complete in reverse order", async () => {
		const held = deferred<Response>();
		let reads = 0;
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async () => reads++ === 0 ? held.promise : snapshot(canonical),
		});
		const staleRefresh = model.syncRecord();
		await model.syncRecord();
		held.resolve(snapshot([old]));
		await staleRefresh;
		assert.equal(pending(model), "current");
	});

	it("rechecks freshness after the response body finishes loading", async () => {
		const body = deferred<string>();
		let reads = 0;
		const slowBody = new Response(new ReadableStream({
			async start(controller) {
				controller.enqueue(new TextEncoder().encode(await body.promise));
				controller.close();
			},
		}));
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async () => reads++ === 0 ? slowBody : snapshot(canonical),
		});
		const staleRefresh = model.syncRecord();
		await model.syncRecord();
		body.resolve(JSON.stringify({ messages: [old], turnInFlight: false }));
		await staleRefresh;
		assert.equal(pending(model), "current");
	});

	it("preserves the optimistic answer when an idle refresh returns during a new submission", async () => {
		const held = deferred<Response>();
		const post = deferred<Response>();
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => {
				if (url === "/api/chat") return post.promise;
				if (url === "/api/chats/sync/stream") return done();
				return held.promise;
			},
		});
		const staleRefresh = model.syncRecord();
		const sending = model.submitAnswer("probe", "old", answer("old"));
		try {
			assert.equal(pending(model), null);
			held.resolve(snapshot([old]));
			await staleRefresh;
			assert.equal(pending(model), null, "the pending POST's answer must remain visible");
			assert.equal(model.status, "submitted");
		} finally {
			post.resolve(Response.json({ error: "Controlled refusal" }, { status: 400 }));
			await sending;
		}
	});

	it("restores submission after a stale answer is rejected and an idle snapshot supplies the correct question", async () => {
		let posts = 0;
		let serverMessages = canonical;
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url, init) => {
				if (url === "/api/chat") {
					posts++;
					assert.equal(typeof init?.body, "string");
					const body = JSON.parse(String(init?.body));
					try {
						const appends = inputAppends({ messages: serverMessages }, parseChatInput(body.input));
						serverMessages = [...serverMessages, ...appends, question("next")];
					} catch (error) {
						assert.ok(error instanceof Error);
						return Response.json({ error: error.message }, { status: 400 });
					}
					return Response.json({ ok: true });
				}
				if (url === "/api/chats/sync/stream") return done();
				return snapshot(serverMessages);
			},
		});
		await model.submitAnswer("probe", "old", answer("old"));
		assert.equal(model.status, "error");
		assert.match(model.getState().error?.message ?? "", /answer input targets no pending question call/);
		await model.syncRecord();
		assert.equal(pending(model), "current");
		await model.submitAnswer("probe", "current", answer("current"));
		assert.equal(posts, 2, "the correct answer must reach the server without reloading");
		assert.equal(model.status, "ready");
		assert.equal(model.getState().error, null);
		assert.equal(pending(model), "next", "the accepted answer advances to the next question");
	});

	it("does not recover an error from a snapshot while the server is still running", async () => {
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => url === "/api/chat"
				? Response.json({ error: "Rejected" }, { status: 400 })
				: snapshot(canonical, true),
		});
		await model.submitAnswer("probe", "old", answer("old"));
		const before = model.getState().nativeMessages;
		await model.syncRecord();
		assert.equal(model.status, "error");
		assert.deepEqual(model.getState().nativeMessages, before, "a running turn's partial snapshot must not replace the view");
	});

	it("keeps the failure visible and submissions blocked if the recovery read fails", async () => {
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => url === "/api/chat"
				? Response.json({ error: "Rejected" }, { status: 400 })
				: new Response(null, { status: 503 }),
		});
		await model.submitAnswer("probe", "old", answer("old"));
		const before = model.getState();
		assert.equal(await model.syncRecord(), null);
		assert.equal(model.status, "error");
		assert.equal(model.readyRef, false);
		assert.deepEqual(model.getState().nativeMessages, before.nativeMessages);
		assert.deepEqual(model.getState().error, before.error);
	});

	it("requires a fresh recovery read after a submission fails", async () => {
		const post = deferred<Response>();
		const held = deferred<Response>();
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => url === "/api/chat" ? post.promise : held.promise,
		});
		const sending = model.submitAnswer("probe", "old", answer("old"));
		const olderRefresh = model.syncRecord();
		post.resolve(Response.json({ error: "Rejected" }, { status: 400 }));
		await sending;
		held.resolve(snapshot([old]));
		assert.equal(await olderRefresh, null);
		assert.equal(model.status, "error", "a snapshot taken before the failure cannot certify recovery");
		assert.equal(pending(model), null, "the old snapshot must not reopen the question");
	});

	it("does not let an old refresh undo an append-only server update", async () => {
		const held = deferred<Response>();
		const model = new SessionModel({ chatId: "sync", initialMessages: [old], fetch: async () => held.promise });
		const staleRefresh = model.syncRecord();
		model.adoptRecord(canonical);
		held.resolve(snapshot([old]));
		await staleRefresh;
		assert.equal(pending(model), "current");
	});

	it("still refreshes when the reattachment stream announces that the turn settled", async () => {
		let refresh: ReturnType<SessionModel["syncRecord"]> | undefined;
		const model = new SessionModel({
			chatId: "sync", initialMessages: [old],
			fetch: async (url) => url === "/api/chats/sync/stream"
				? new Response('data: {"type":"turn-settled"}\n\n')
				: snapshot(canonical),
		});
		model.setReattachSettled(() => {
			refresh = model.syncRecord();
		});
		await model.resumeStream(false);
		assert.ok(refresh);
		await refresh;
		assert.equal(pending(model), "current");
		assert.equal(model.status, "ready");
	});

	it("drops an outstanding refresh after detaching the session", async () => {
		const held = deferred<Response>();
		const model = new SessionModel({ chatId: "sync", initialMessages: [old], fetch: async () => held.promise });
		const refresh = model.syncRecord();
		model.stop();
		held.resolve(snapshot(canonical));
		assert.equal(await refresh, null);
		assert.equal(pending(model), "old");
	});
});
