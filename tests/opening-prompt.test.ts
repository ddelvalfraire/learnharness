import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import React from "react";

Object.assign(globalThis, { React });

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-opening-prompt-"));
process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(data, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";

const { POST } = await import("../app/api/chats/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { startSession } = await import("../components/start-session.ts");
const { default: ChatPage } = await import("../app/chat/[id]/page.tsx");

after(() => fs.rmSync(data, { recursive: true, force: true }));

const prompt = "Explain this in detail. 日本語 🧠\n".repeat(2000).trim();
const picks = [{ id: "n_logic", name: "Logic", statement: "P implies Q." }];

function create(body: unknown) {
	return POST(new Request("http://test/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}));
}

async function createPending(kind?: "practice") {
	const res = await create({ prompt, kind, graphContext: { propositions: picks } });
	assert.equal(res.status, 200);
	const body: unknown = await res.json();
	assert.ok(typeof body === "object" && body !== null && "id" in body && typeof body.id === "string");
	return body.id;
}

function post(chatId: string, input: unknown) {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function configure(id: string) {
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
}

async function settle(id: string) {
	const handle = runningTurn(id);
	if (handle) await new Response(handle.subscribe()).text();
}

function teacher(gate: Promise<void> = Promise.resolve()) {
	let calls = 0;
	const faux = createFauxCore({});
	faux.setResponses([async () => {
		await gate;
		return fauxAssistantMessage([fauxText("Opening reply.")]);
	}]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const factory: NonNullable<Parameters<typeof handleChatRequest>[1]> = (opts) => {
		calls++;
		return createTeacherAgent(undefined, { engine, messages: opts.messages });
	};
	return { factory, calls: () => calls };
}

describe("saved opening prompts", () => {
	it("the shared composer handoff carries the full prompt through a short URL into the chat page", async () => {
		for (const kind of [undefined, "practice"] as const) {
			const target = await startSession({
				text: prompt,
				kind,
				picks,
				fetchLike: async (url, init) => {
					assert.equal(url, "/api/chats");
					return POST(new Request("http://test/api/chats", init));
				},
			});
			assert.ok(target);
			const url = new URL(target, "http://test");
			assert.equal(url.search, "");
			assert.equal(url.hash, "");
			assert.ok(target.length < 100);
			const id = target.slice("/chat/".length);
			const page = await ChatPage({ params: Promise.resolve({ id }) });
			assert.equal(page.props.initialPrompt, prompt);
			assert.equal(page.props.kind, kind ?? "teach");
			assert.equal(page.props.initialMessages[0].customType, "graph-context");
		}
	});

	it("preserves a large Unicode prompt through graph context and settings writes in either mode", async () => {
		for (const kind of [undefined, "practice"] as const) {
			const id = await createPending(kind);
			configure(id);
			const saved = chatStore.getChat(id);
			assert.ok(saved);
			assert.equal(saved.pendingPrompt, prompt);
			assert.equal(saved.kind, kind);
			assert.equal(saved.messages.length, 1);
			assert.equal(saved.messages[0]?.role, "custom");
			assert.ok(saved.title.startsWith("Explain this in detail."));
			assert.ok(saved.title.length < 100);
			assert.ok(!JSON.stringify(chatStore.listChats()).includes(prompt), "sidebar summaries omit the pending prompt");
		}
	});

	it("keeps title-only creation compatible and rejects invalid prompts before creating a record", async () => {
		const legacy = await create({ title: "An empty session" });
		assert.equal(legacy.status, 200);
		const count = chatStore.listChats().length;
		for (const value of ["", "   ", 3, null, {}]) {
			assert.equal((await create({ prompt: value })).status, 400);
		}
		assert.equal(chatStore.listChats().length, count);
	});

	it("accepts concurrent opening submissions once, and replay after settlement starts no new turn", async () => {
		const id = await createPending();
		configure(id);
		let resolve = () => {};
		const promise = new Promise<void>((release) => { resolve = release; });
		const agent = teacher(promise);
		try {
			const responses = await Promise.all([
				handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory),
				handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory),
			]);
			assert.deepEqual(responses.map((res) => res.status), [200, 200]);
			const saved = chatStore.getChat(id);
			assert.ok(saved);
			assert.equal(saved.pendingPrompt, undefined);
			assert.equal(saved.messages.filter((m) => m.role === "user").length, 1);
			assert.equal(saved.messages.find((m) => m.role === "user")?.content, prompt);
			assert.equal(agent.calls(), 1);
		} finally {
			resolve();
			await settle(id);
		}
		const replay = await handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory);
		assert.equal(replay.status, 200);
		assert.equal(agent.calls(), 1);
		assert.equal(isTurnRunning(id), false);
	});

	it("retains the pending prompt when setup refuses the first turn", async () => {
		const id = await createPending();
		const agent = teacher();
		const res = await handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory);
		assert.equal(res.status, 503);
		assert.equal(chatStore.getChat(id)?.pendingPrompt, prompt);
		assert.equal(agent.calls(), 0);
		assert.equal(isTurnRunning(id), false);
	});

	it("refuses a mismatched opening message without changing the saved prompt", async () => {
		const id = await createPending();
		configure(id);
		const agent = teacher();
		const res = await handleChatRequest(post(id, { type: "start", text: "Different prompt" }), agent.factory);
		assert.equal(res.status, 400);
		assert.equal(chatStore.getChat(id)?.pendingPrompt, prompt);
		assert.equal(agent.calls(), 0);
	});

	it("ordinary text messages may repeat after the opening prompt is accepted", async () => {
		const id = await createPending("practice");
		configure(id);
		const first = teacher();
		assert.equal((await handleChatRequest(post(id, { type: "start", text: prompt }), first.factory)).status, 200);
		await settle(id);
		const next = teacher();
		assert.equal((await handleChatRequest(post(id, { type: "text", text: prompt }), next.factory)).status, 200);
		await settle(id);
		const saved = chatStore.getChat(id);
		assert.equal(saved?.messages.filter((m) => m.role === "user").length, 2);
		assert.equal(next.calls(), 1);
	});

	it("does not start the model or consume the pending prompt when its message cannot be saved", async () => {
		const id = await createPending();
		configure(id);
		const agent = teacher();
		const save = mock.method(chatStore, "saveMessages", () => { throw new Error("disk full"); });
		try {
			const res = await handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory);
			assert.equal(res.status, 500);
			assert.equal(chatStore.getChat(id)?.pendingPrompt, prompt);
			assert.equal(isTurnRunning(id), false);
			assert.equal(agent.calls(), 0);
		} finally {
			save.mock.restore();
		}
		const retry = await handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory);
		assert.equal(retry.status, 200);
		await settle(id);
		assert.equal(agent.calls(), 1);
	});

	it("an existing conversation never replays an opening prompt", async () => {
		const id = await createPending();
		chatStore.saveMessages(id, [newUserMessage("A message already accepted.")]);
		const agent = teacher();
		const res = await handleChatRequest(post(id, { type: "start", text: prompt }), agent.factory);
		assert.equal(res.status, 200);
		assert.equal(chatStore.getChat(id)?.pendingPrompt, undefined);
		assert.equal(agent.calls(), 0);
	});
});
