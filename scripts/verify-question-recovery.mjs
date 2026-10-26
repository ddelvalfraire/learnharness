// Run after npm run build:
// LH_TEST_CHROMIUM_PATH=/path/to/chrome NODE_ENV=test node --import tsx scripts/verify-question-recovery.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import puppeteer from "puppeteer-core";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
import { buildAnswer } from "../src/core/question-core.ts";
import { modelsNotConfigured, providerKeyMissing } from "../src/core/settings.ts";

const executablePath = process.env.LH_TEST_CHROMIUM_PATH;
assert.ok(executablePath && fs.existsSync(executablePath), "Set LH_TEST_CHROMIUM_PATH to a Chromium executable");
assert.ok(fs.existsSync(".next/BUILD_ID"), "Run npm run build first");
const id = "chat_question_recovery_fixture";
const input = {
	question: "Fixture question", options: [{ label: "4", value: "four" }, { label: "5", value: "five" }],
	correctAnswer: "four", explanation: "Two plus two is four.",
};
const question = (callId) => ({
	id: `assistant-${callId}`, role: "assistant", api: "openai-completions", provider: "openrouter", model: "fixture",
	timestamp: 0, stopReason: "toolUse",
	usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
		cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
	content: [{ type: "toolCall", id: callId, name: "probe", arguments: { ...input, question: `${callId}: What is 2 + 2?` } }],
});
const answeredOld = newAnswerResult("old", "probe", buildAnswer({
	id: "old", kind: "quiz", question: input.question, mode: "single-select", options: input.options,
	correctIndices: [1], explanation: input.explanation, createdAt: "2026-01-01T00:00:00Z",
}, { values: ["four"], confidence: 50 }, "probe"));
const old = question("old"), current = question("current");
const owed = [old, answeredOld];
const canonical = [...owed, current];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-question-ui-"));
fs.mkdirSync(path.join(dataDir, "chats"));
const seed = (messages) => fs.writeFileSync(path.join(dataDir, "chats", `${id}.json`), JSON.stringify({
	id, title: "Question recovery fixture", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages,
}));
const socket = net.createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const env = { ...process.env, NODE_ENV: "production", LH_DATA_DIR: dataDir, LH_AUTH_FILE: path.join(dataDir, "auth.json") };
delete env.LH_DESKTOP_API_SECRET;
delete env.LH_DESKTOP_SERVER;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
	env, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Next server did not become ready")), 30_000);
		server.stdout.on("data", (chunk) => {
			if (String(chunk).includes("Ready in")) { clearTimeout(timeout); resolve(); }
		});
		server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next server exited: ${code}`)); });
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	async function scenario(name, initial, serverMessages, refusal, run) {
		seed(initial);
		const page = await browser.newPage();
		await page.setViewport({ width: 1440, height: 1000 });
		const errors = [], posts = [];
		let holdNextRecord = false, held;
		let notifyHeld;
		const heldRequest = new Promise((resolve) => { notifyHeld = resolve; });
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.evaluateOnNewDocument(() => {
			window.__fixtureSources = [];
			window.EventSource = class extends EventTarget {
				constructor() { super(); window.__fixtureSources.push(this); queueMicrotask(() => this.onopen?.(new Event("open"))); }
				close() {}
			};
		});
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			void (async () => {
				const url = new URL(request.url());
				if (url.origin !== `http://127.0.0.1:${port}`) return request.abort();
				const json = (body, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
				const provider = { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", keyPresent: false };
				if (url.pathname === "/api/models") return json({ providers: [provider], models: [], slots: { strong: null, cheap: null, vision: null } });
				if (url.pathname === "/api/keys") return json({ providers: [provider], keys: [] });
				if (url.pathname === "/api/settings") return json({ settings: {} });
				if (url.pathname === "/api/chat") {
					const event = parseChatInput(JSON.parse(request.postData()).input);
					posts.push(event);
					if (refusal) return json(refusal, 503);
					try {
						const appends = inputAppends({ messages: serverMessages }, event);
						const next = event.type === "answer" && event.toolCallId === "current" ? "next" : "current";
						serverMessages = [...serverMessages, ...appends, question(next)];
						return json({ ok: true });
					} catch (error) { return json({ error: error.message }, 400); }
				}
				if (url.pathname === `/api/chats/${id}/stream`) return request.respond({ contentType: "text/event-stream", body: "data: [DONE]\n\n" });
				if (url.pathname === `/api/chats/${id}`) {
					const record = { messages: serverMessages, turnInFlight: false, turns: [], pricing: { cost: 0, unpriced: 0, turnCosts: {} } };
					if (holdNextRecord) { holdNextRecord = false; held = { request, record }; notifyHeld(); return; }
					return json(record);
				}
				if (request.method() !== "GET") throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`);
				return request.continue();
			})().catch((error) => { if (!page.isClosed()) errors.push(String(error)); });
		});
		const expectQuestion = async (callId) => page.waitForFunction((expected) =>
			document.querySelector('[data-testid="question-dock"]')?.textContent?.includes(`${expected}: What is 2 + 2?`),
		{ timeout: 10_000 }, callId);
		const answerVisible = async () => {
			await page.click('[data-testid="question-dock"] button[data-kbdrow="0"]');
			await page.waitForSelector('[data-testid="question-dock"] button[type="submit"]:not([disabled])');
			await page.click('[data-testid="question-dock"] button[type="submit"]');
		};
		try {
			await page.goto(`http://127.0.0.1:${port}/chat/${id}`, { waitUntil: "networkidle0" });
			await run({ page, posts, expectQuestion, answerVisible,
				holdRefresh: async () => {
					holdNextRecord = true;
					await page.evaluate((chatId) => window.__fixtureSources.forEach((source) =>
						source.dispatchEvent(new MessageEvent("turn-settled", { data: JSON.stringify({ chatId }) }))), id);
					await heldRequest;
				},
				releaseRefresh: async () => {
					assert.ok(held);
					await held.request.respond({ contentType: "application/json", body: JSON.stringify(held.record) });
					await page.waitForNetworkIdle({ idleTime: 300, timeout: 10_000 });
				},
			});
			assert.deepEqual(errors, [], `${name}: browser errors`);
			process.stdout.write(`PASS ${name}\n`);
		} finally { await page.close(); }
	}
	await scenario("delayed refresh cannot restore an answered question", [old], [old], null, async ({ expectQuestion, answerVisible, holdRefresh, releaseRefresh }) => {
		await expectQuestion("old");
		await holdRefresh();
		await answerVisible();
		await expectQuestion("current");
		await releaseRefresh();
		await expectQuestion("current");
	});
	await scenario("rejected stale answer recovers and the next answer advances", [old], canonical, null, async ({ posts, expectQuestion, answerVisible }) => {
		await expectQuestion("old");
		await answerVisible();
		await expectQuestion("current");
		await answerVisible();
		await expectQuestion("next");
		assert.deepEqual(posts.map((event) => event.toolCallId), ["old", "current"]);
	});
	for (const refusal of [modelsNotConfigured(["strong"]), providerKeyMissing("openrouter", ["strong"])]) {
		await scenario(`${refusal.code} opens setup without retrying`, owed, owed, refusal, async ({ page, posts }) => {
			await page.waitForSelector('[data-testid="setup-dialog"]', { timeout: 10_000 });
			await page.waitForNetworkIdle({ idleTime: 300, timeout: 10_000 });
			assert.deepEqual(posts.map((event) => event.type), ["continue"]);
		});
	}
	await scenario("normal mount continuation reaches its question", owed, owed, null, async ({ posts, expectQuestion }) => {
		await expectQuestion("current");
		assert.deepEqual(posts.map((event) => event.type), ["continue"]);
	});
} finally {
	await browser?.close();
	if (server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
	fs.rmSync(dataDir, { recursive: true, force: true });
}
