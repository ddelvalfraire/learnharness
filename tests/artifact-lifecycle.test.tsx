import { durableWake } from "./helpers/durable-wake.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { after, afterEach, test } from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-artifact-lifecycle-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
globalThis.React = React;
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { projectView, danglingQuestionOf, toLlmMessages, jobHasWork, artifactSlotsOf, newUserSteer } = await import("../src/core/index.ts");
const { deliverJobResult, abortJob, registerLiveAgent, unregisterLiveAgent, settleSteers, setTurnRunner, steerLiveChat, reconcileUserSteers } = await import("../src/server/jobs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { POST } = await import("../app/api/chats/[id]/artifact-ui/route.ts");
const { JobArtifactCard } = await import("../components/artifacts/job-artifact-card.tsx");
const { SubagentSteerCard } = await import("../components/artifacts/steer-card.tsx");
const { DemoOutputCard } = await import("../components/artifacts/demo-card.tsx");
const { VisualOutputCard } = await import("../components/artifacts/visual-card.tsx");
const { JobsContext, ArtifactSlotsContext } = await import("../components/jobs-context.ts");
const { buildSubagentSteer } = await import("../src/core/contracts/jobs.ts");

afterEach(() => {
	for (const chat of chatStore.listChats()) {
		for (const job of jobStore.listJobs(chat.id)) {
			if (jobHasWork(job)) jobStore.updateJob(job.id, { status: "done", delivery: { state: "cancelled" } });
		}
	}
});

const result = { title: "Ready demo", html: "<button onclick='this.textContent++'>0</button>", tested: true as const };
const assistant: AssistantMessage & { id: string } = {
	id: "dispatch", role: "assistant", api: "openai-completions", provider: "openrouter", model: "fixture", timestamp: 1, stopReason: "toolUse",
	usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
	content: [{ type: "toolCall", id: "demo-call", name: "demo", arguments: { title: result.title, brief: "Count clicks" } }],
};
const question: LhMessage = { ...assistant, id: "question", content: [
	{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "What is 2 + 2?", options: [{ label: "4" }, { label: "5" }], correctAnswer: "4", explanation: "Addition." } },
] };

function fixture() {
	const chat = chatStore.createChat("Artifact lifecycle");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "test/fixture" } });
	chatStore.saveMessages(chat.id, [assistant, {
		id: "ack", role: "toolResult", toolCallId: "demo-call", toolName: "demo", content: [{ type: "text", text: "Dispatched" }], details: "Dispatched", isError: false, timestamp: 1,
	}, question]);
	const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "demo-call" });
	return { chat, job };
}

function completion(id: string) {
	const job = jobStore.completeJob(id, result);
	assert.ok(job && job.delivery?.state === "pending");
	return { job, marker: job.delivery.message };
}

test("completion persists one verified result and its notification without answering the question", () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	assert.equal(completed.job.status, "done");
	assert.equal(jobHasWork(completed.job), true);
	assert.equal(danglingQuestionOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "quiz-call");
	assert.deepEqual(jobStore.completeJob(job.id, result), completed.job, "repeated completion preserves the original notification");
	const saved = fs.readFileSync(path.join(scratch, "jobs", `${job.id}.json`), "utf8");
	assert.equal(saved.split(result.html).length - 1, 1, "the notification references its artifact instead of copying HTML");
	assert.ok(!JSON.stringify(toLlmMessages([completed.marker])).includes(result.html));
	const html = renderToStaticMarkup(<JobsContext.Provider value={[completed.job]}><JobArtifactCard toolCallId="demo-call" kind="demo" /></JobsContext.Provider>);
	assert.match(html, /data-testid="demo-iframe"/);
	assert.match(html, /sandbox="allow-scripts"/);
});

test("a failed atomic completion leaves the previous record intact", () => {
	const { job } = fixture();
	const rename = fs.renameSync;
	try {
		fs.renameSync = () => { throw new Error("simulated interruption before commit"); };
		syncBuiltinESMExports();
		assert.throws(() => jobStore.completeJob(job.id, result), /simulated interruption/);
	} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
	assert.equal(jobStore.getJob(job.id)?.status, "running");
	assert.equal(jobStore.getJob(job.id)?.result, undefined);
	assert.ok(!fs.readdirSync(path.join(scratch, "jobs")).some((name) => name.endsWith(".tmp")));
});

test("invalid or unverified demo results cannot complete a build", () => {
	const { job } = fixture();
	assert.throws(() => jobStore.completeJob(job.id, { brief: "Wrong artifact kind", sources: [] }), /Invalid completed demo/);
	assert.equal(jobStore.getJob(job.id)?.status, "running");
	const html = renderToStaticMarkup(<JobsContext.Provider value={[{ ...job, result: { ...result, tested: false } }]}><JobArtifactCard toolCallId="demo-call" kind="demo" /></JobsContext.Provider>);
	assert.doesNotMatch(html, /data-testid="demo-iframe"/);
});

test("cancelling an unconsumed notification preserves queued learner steering", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	const agent = new Agent({ streamFn: () => { throw new Error("No generation expected"); } });
	assert.ok(beginTurn(chat.id));
	registerLiveAgent(chat.id, agent);
	const delivery = deliverJobResult(completed.marker);
	const learner = newUserSteer("Keep the current question", "learner-steer");
	assert.equal(steerLiveChat(chat.id, learner), true);
	assert.equal(abortJob(job.id).ok, true);
	await delivery;
	assert.deepEqual(agent.peekQueuedMessages().map((message) => "id" in message ? message.id : undefined), [learner.id]);
	unregisterLiveAgent(chat.id);
	reconcileUserSteers(chat.id, [learner]);
	endTurn(chat.id);
});

test("cancelling a later notification never requeues already consumed inputs", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	const other = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "other-demo" });
	const later = completion(other.id);
	const agent = new Agent({ streamFn: () => { throw new Error("No generation expected"); } });
	agent.steeringMode = "all";
	assert.ok(beginTurn(chat.id));
	registerLiveAgent(chat.id, agent);
	const firstDelivery = deliverJobResult(completed.marker);
	const learner = newUserSteer("Keep this instruction once", "consumed-learner-steer");
	steerLiveChat(chat.id, learner);
	const consumed = agent.peekQueuedMessages();
	agent.clearSteeringQueue();
	agent.state.messages = consumed;
	const laterDelivery = deliverJobResult(later.marker);
	try {
		assert.equal(abortJob(other.id).ok, true);
		await laterDelivery;
		assert.deepEqual(agent.peekQueuedMessages(), [], "consumed automatic and learner inputs must not be injected again");
	} finally {
		chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, completed.marker, learner]);
		unregisterLiveAgent(chat.id);
		settleSteers(chat.id, [completed.marker]);
		reconcileUserSteers(chat.id, [learner]);
		endTurn(chat.id);
		await firstDelivery;
	}
});

test("a dispatched wake cannot report cancellation before its turn claim starts", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	chatStore.saveMessages(chat.id, [assistant]);
	let start = () => {};
	let release = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	setTurnRunner(durableWake(chatStore, async () => { start(); await gate; return 200; }));
	const delivery = deliverJobResult(completed.marker);
	await started;
	try {
		assert.deepEqual(abortJob(job.id), { ok: false, reason: "not_running" });
		assert.equal(jobHasWork(jobStore.getJob(job.id)!), true, "deletion stays blocked while the dispatched wake is active");
	} finally { release(); await delivery; }
});

test("hot reload upgrades a wake registry created before the in-flight map existed", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	const pipeline = Reflect.get(globalThis, "__lhWakePipeline");
	Reflect.deleteProperty(pipeline, "delivering");
	try {
		const delivery = deliverJobResult(completed.marker);
		assert.equal(abortJob(job.id).ok, true);
		await delivery;
	} finally {
		if (!Reflect.get(pipeline, "delivering")) Reflect.set(pipeline, "delivering", new Map());
		chatStore.saveMessages(chat.id, []);
	}
});

test("hot reload preserves observers on a notification queued by the previous module", async () => {
	const { job } = fixture();
	const completed = completion(job.id);
	const first = deliverJobResult(completed.marker);
	const pipeline = Reflect.get(globalThis, "__lhWakePipeline");
	const entry = Reflect.get(pipeline, "queues").get(job.chatId)[0];
	Reflect.deleteProperty(entry, "observers");
	const duplicate = deliverJobResult(completed.marker);
	assert.equal(abortJob(job.id).ok, true);
	await Promise.all([first, duplicate]);
});

for (const stranded of [false, true]) {
	test(`a completed demo remains visible while notification waits ${stranded ? "after a question stopper" : "behind a question"}`, async () => {
		const { chat, job } = fixture();
		const completed = completion(job.id);
		let wakes = 0;
		setTurnRunner(durableWake(chatStore, async () => { wakes++; return 200; }));
		if (stranded) {
			assert.ok(beginTurn(chat.id));
			registerLiveAgent(chat.id, new Agent({ streamFn: () => { throw new Error("This test must not generate a teacher response"); } }));
		}
		const delivery = deliverJobResult(completed.marker);
		if (stranded) {
			unregisterLiveAgent(chat.id);
			settleSteers(chat.id, []);
			endTurn(chat.id);
		}
		assert.equal(jobStore.getJob(job.id)?.delivery?.state, "pending");
		assert.equal(wakes, 0);
		const html = renderToStaticMarkup(<JobsContext.Provider value={[jobStore.getJob(job.id)!]}><JobArtifactCard toolCallId="demo-call" kind="demo" /></JobsContext.Provider>);
		assert.match(html, /data-testid="demo-iframe"/);
		assert.equal(danglingQuestionOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "quiz-call");
		assert.equal(abortJob(job.id).ok, true);
		await delivery;
		assert.equal(jobStore.getJob(job.id)?.status, "done", "cancelling notification preserves the completed demo");
		assert.deepEqual(jobStore.getJob(job.id)?.result, result);
	});
}

test("brightness saves before any delivery message and rejects cross-chat targets", async () => {
	const { chat, job } = fixture();
	completion(job.id);
	const post = (chatId: string) => POST(new Request("http://fixture/artifact-ui", { method: "POST", body: JSON.stringify({ input: { artifactId: job.id, inverted: true } }) }), { params: Promise.resolve({ id: chatId }) });
	assert.equal((await post(chat.id)).status, 200);
	assert.equal(jobStore.getJob(job.id)?.ui?.inverted, true);
	const other = chatStore.createChat("Other chat");
	assert.equal((await post(other.id)).status, 400);
	assert.ok(!chatStore.getChat(chat.id)!.messages.some((message) => message.id === `steer_${job.id}`));
});

test("restart recovers completed builds and duplicate delivery produces one notification", () => {
	const { chat, job } = fixture();
	completion(job.id);
	chatStore.saveMessages(chat.id, [assistant]);
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		const { chatStore } = await import('./src/store/chats.ts');
		const { jobStore } = await import('./src/store/jobs.ts');
		const { subscribe } = await import('./src/core/events.ts');
		const { recoverStaleJobs, setTurnRunner, deliverJobResult } = await import('./src/server/jobs.ts');
		const id = process.env.LH_TEST_JOB_ID;
		let wakes = 0;
		setTurnRunner(async (chatId, input) => { wakes++; chatStore.saveMessages(chatId, [...chatStore.getChat(chatId).messages, ...input.steers]); return 200; });
		const accepted = new Promise((resolve) => {
			const stop = subscribe(() => { if (jobStore.getJob(id)?.delivery?.state === 'delivered') { stop(); resolve(); } });
		});
		recoverStaleJobs();
		await accepted;
		const recovered = jobStore.getJob(id);
		await deliverJobResult({ id: 'steer_' + id, ...{role:'custom',customType:'subagent-steer',content:'duplicate',display:true,details:{jobId:id},timestamp:0} });
		assert.equal(wakes, 1);
		assert.equal(chatStore.getChat(recovered.chatId).messages.filter((message) => message.id === 'steer_' + id).length, 1);
		console.log('recovered-and-deduplicated');
	`], { env: { ...process.env, LH_TEST_JOB_ID: job.id }, encoding: "utf8", timeout: 10_000 });
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /recovered-and-deduplicated/);
});

test("duplicate delivery during a wake and after transcript compaction does not resend", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	chatStore.saveMessages(chat.id, [assistant]);
	let start = () => {};
	let release = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let wakes = 0;
	setTurnRunner(durableWake(chatStore, async () => { wakes++; start(); await gate; return 200; }));
	const first = deliverJobResult(completed.marker);
	await started;
	const duplicate = deliverJobResult(completed.marker);
	release();
	await Promise.all([first, duplicate]);
	assert.equal(wakes, 1);
	assert.equal(jobStore.getJob(job.id)?.delivery?.state, "delivered");
	await deliverJobResult(completed.marker);
	assert.equal(wakes, 1, "durable acknowledgement survives a transcript without the old marker");
});

test("a successful response without a persisted marker cannot acknowledge delivery", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	chatStore.saveMessages(chat.id, [assistant]);
	setTurnRunner(async () => 200);
	await assert.rejects(deliverJobResult(completed.marker), /persist/);
	assert.equal(jobStore.getJob(job.id)?.delivery?.state, "failed");
	assert.deepEqual(jobStore.getJob(job.id)?.result, result);
});

test("legacy embedded artifacts retain their payload and saved brightness", () => {
	const { chat, job } = fixture();
	const legacy = { ...job, result, status: "running" };
	delete legacy.delivery;
	const marker = buildSubagentSteer({ id: job.id, kind: "demo", toolCallId: "demo-call" }, result);
	if (marker.details && typeof marker.details === "object") marker.details = { ...marker.details, ui: { inverted: true } };
	chatStore.saveMessages(chat.id, [assistant, marker]);
	fs.writeFileSync(path.join(scratch, "jobs", `${job.id}.json`), JSON.stringify(legacy));
	const migrated = jobStore.getJob(job.id)!;
	assert.equal(migrated.delivery?.state, "delivered");
	assert.equal(migrated.ui?.inverted, true);
	const view = projectView([marker])[0]!;
	assert.match(renderToStaticMarkup(<SubagentSteerCard message={view} />), /data-testid="demo-iframe"/);
	assert.equal(artifactSlotsOf(projectView(chatStore.getChat(chat.id)!.messages)).has("demo-call"), false, "legacy artifacts retain their transcript location");
});

test("legacy completed jobs stay delivered when compaction removed their marker", () => {
	const { job } = fixture();
	const legacy = { ...job, status: "done", result };
	delete legacy.delivery;
	fs.writeFileSync(path.join(scratch, "jobs", `${job.id}.json`), JSON.stringify(legacy));
	assert.equal(jobStore.getJob(job.id)?.delivery?.state, "delivered");
	assert.equal(jobHasWork(jobStore.getJob(job.id)!), false);
});

test("legacy message-addressed preference writes update the canonical artifact", async () => {
	const { chat, job } = fixture();
	const legacy = { ...job, status: "done", result };
	delete legacy.delivery;
	const marker = buildSubagentSteer({ id: job.id, kind: "demo", toolCallId: "demo-call" }, result);
	chatStore.saveMessages(chat.id, [assistant, marker]);
	fs.writeFileSync(path.join(scratch, "jobs", `${job.id}.json`), JSON.stringify(legacy));
	jobStore.updateJob(job.id, { ui: { inverted: true } });
	const response = await POST(new Request("http://fixture/artifact-ui", { method: "POST",
		body: JSON.stringify({ input: { messageId: marker.id, inverted: false } }),
	}), { params: Promise.resolve({ id: chat.id }) });
	assert.equal(response.status, 200);
	assert.equal(jobStore.getJob(job.id)?.ui?.inverted, false, "legacy addressing must not leave the artifact preference stale");
});

for (const kind of ["demo", "visual"] as const) {
	test(`${kind} applies a loaded brightness preference without recreating its content`, async () => {
		const { window, document } = parseHTML("<html><body><main></main></body></html>");
		Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
		const { createRoot } = await import("react-dom/client");
		const mount = document.querySelector("main");
		assert.ok(mount);
		const root = createRoot(mount);
		const card = (inverted: boolean) => kind === "demo"
			? <DemoOutputCard output={result} initialInverted={inverted} />
			: <VisualOutputCard output={{ svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>' }} initialInverted={inverted} />;
		try {
			await act(async () => root.render(card(false)));
			const content = document.querySelector(kind === "demo" ? "iframe" : '[data-testid="visual-svg"]');
			assert.ok(content);
			await act(async () => root.render(card(true)));
			assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "true");
			assert.equal(document.querySelector(kind === "demo" ? "iframe" : '[data-testid="visual-svg"]'), content);
		} finally { await act(async () => root.unmount()); }
	});
}

test("delivery and repeated jobs updates preserve one iframe and local brightness", async () => {
	const { chat, job } = fixture();
	const completed = completion(job.id);
	const { window, document } = parseHTML("<html><body><main></main></body></html>");
	Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
	const { createRoot } = await import("react-dom/client");
	const mount = document.querySelector("main");
	assert.ok(mount);
	const root = createRoot(mount);
	const render = (delivered: boolean) => <JobsContext.Provider value={[jobStore.getJob(job.id)!]}>
		<ArtifactSlotsContext.Provider value={new Set(["demo-call"])}>
			<JobArtifactCard toolCallId="demo-call" kind="demo" />
			{delivered && <SubagentSteerCard message={projectView([completed.marker])[0]!} />}
		</ArtifactSlotsContext.Provider>
	</JobsContext.Provider>;
	try {
		await act(async () => root.render(render(false)));
		const iframe = document.querySelector("iframe");
		assert.ok(iframe);
		const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]');
		assert.ok(toggle);
		await act(async () => toggle.click());
		chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, completed.marker]);
		jobStore.updateJob(job.id, { delivery: { state: "delivered" } });
		await act(async () => root.render(render(true)));
		await act(async () => root.render(render(true)));
		assert.equal(document.querySelectorAll("iframe").length, 1);
		assert.equal(document.querySelector("iframe"), iframe);
		assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "true");
	} finally { await act(async () => root.unmount()); }
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));
