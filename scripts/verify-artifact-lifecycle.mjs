// Run after npm run build:
// LH_TEST_CHROMIUM_PATH=/path/to/chrome node --import tsx scripts/verify-artifact-lifecycle.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import puppeteer from "puppeteer-core";

assert.ok(fs.existsSync(".next/BUILD_ID"), "Run npm run build first");
const executablePath = process.env.LH_TEST_CHROMIUM_PATH;
assert.ok(executablePath && fs.existsSync(executablePath), "Set LH_TEST_CHROMIUM_PATH to Chromium");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-artifact-browser-"));
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = path.join(dataDir, "auth.json");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { inputAppends, parseChatInput } = await import("../src/core/input-events.ts");
const chat = chatStore.createChat("Artifact browser regression");
const base = {
	role: "assistant", api: "openai-completions", provider: "openrouter", model: "fixture", timestamp: 1, stopReason: "toolUse",
	usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
};
chatStore.saveMessages(chat.id, [
	{ ...base, id: "dispatch", content: [{ type: "toolCall", id: "demo-call", name: "demo", arguments: { title: "Click counter", brief: "Count clicks" } }] },
	{ id: "ack", role: "toolResult", toolCallId: "demo-call", toolName: "demo", content: [{ type: "text", text: "Dispatched" }], details: "Dispatched", isError: false, timestamp: 1 },
	{ ...base, id: "question", content: [{ type: "toolCall", id: "quiz-call", name: "probe", arguments: {
		question: "What is 2 + 2?", options: [{ label: "4", value: "four" }, { label: "5", value: "five" }], correctAnswer: "four", explanation: "Addition.",
	} }] },
]);
const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "demo-call" });
const socket = net.createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", LH_IGNORE_ENV_KEYS: "1" };
delete env.LH_DESKTOP_API_SECRET;
delete env.LH_DESKTOP_SERVER;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Next server did not start")), 30_000);
		server.stdout.on("data", (chunk) => { if (String(chunk).includes("Ready in")) { clearTimeout(timeout); resolve(); } });
		server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next server exited ${code}`)); });
	});
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 1000 });
	const errors = [], posts = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.evaluateOnNewDocument(() => {
		window.__artifactEventSources = [];
		window.EventSource = class extends EventTarget {
			constructor() { super(); window.__artifactEventSources.push(this); queueMicrotask(() => this.onopen?.(new Event("open"))); }
			close() {}
		};
	});
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		void (async () => {
			const url = new URL(request.url());
			if (url.protocol === "about:" || url.protocol === "data:") return request.continue();
			if (url.origin !== origin) return request.abort();
			// The fixture's builder runs in this process, so the server has no live
			// worker registration during the initial building phase.
			if (url.pathname === "/api/activity") return request.respond({ contentType: "application/json", body: '{"jobs":[],"extractions":[]}' });
			if (url.pathname === "/api/jobs" && jobStore.getJob(job.id).status === "running") {
				return request.respond({ contentType: "application/json", body: JSON.stringify({ jobs: jobStore.listJobs(chat.id), turnInFlight: false }) });
			}
			if (url.pathname === "/api/chat") {
				const input = parseChatInput(JSON.parse(request.postData()).input);
				posts.push(input);
				assert.equal(input.type, "answer", "artifact completion must not trigger a continuation");
				const record = chatStore.getChat(chat.id);
				const completed = jobStore.getJob(job.id);
				assert.equal(completed.delivery.state, "pending");
				chatStore.saveMessages(chat.id, [...record.messages, ...inputAppends(record, input), completed.delivery.message,
					{ ...base, id: "teacher-reaction", stopReason: "stop", content: [{ type: "text", text: "Answer received. Keep exploring the demo." }] }]);
				jobStore.updateJob(job.id, { delivery: { state: "delivered" }, activity: "delivered" });
				return request.respond({ status: 202, contentType: "application/json", body: '{"ok":true}' });
			}
			if (url.pathname === `/api/chats/${chat.id}/stream`) return request.respond({ contentType: "text/event-stream", body: "data: [DONE]\n\n" });
			return request.continue();
		})().catch((error) => { errors.push(String(error)); void request.abort(); });
	});
	const announce = async (type) => page.evaluate((type) => window.__artifactEventSources.forEach((source) =>
		source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ chatId: location.pathname.split("/").at(-1) }) }))), type);
	await page.goto(`${origin}/chat/${chat.id}`, { waitUntil: "networkidle0" });
	await page.waitForSelector('[data-testid="question-dock"] button[data-kbdrow="0"]');
	await page.type('[data-testid="thinking-field"] textarea', "Keep this draft while the demo finishes.");
	jobStore.completeJob(job.id, { title: "Click counter", html: '<!doctype html><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>', tested: true });
	await announce("jobs-changed");
	await page.waitForSelector('[data-testid="demo-iframe"]');
	assert.equal(posts.length, 0);
	assert.equal(await page.$eval('[data-testid="thinking-field"] textarea', (element) => element.value), "Keep this draft while the demo finishes.");
	const iframe = await page.$('[data-testid="demo-iframe"]');
	const frame = await iframe.contentFrame();
	await frame.waitForSelector("#counter");
	await frame.click("#counter");
	await frame.click("#counter");
	await page.evaluate(() => { window.__originalDemoIframe = document.querySelector('[data-testid="demo-iframe"]'); });
	await page.click('[aria-label="Invert demo brightness"]');
	await page.waitForNetworkIdle({ idleTime: 300 });
	assert.equal(jobStore.getJob(job.id).ui.inverted, true);
	await page.click('[data-testid="question-dock"] button[data-kbdrow="0"]');
	await page.waitForSelector('[data-testid="question-dock"] button[type="submit"]:not([disabled])');
	await page.click('[data-testid="question-dock"] button[type="submit"]');
	await page.waitForFunction(() => document.body.textContent.includes("Answer received. Keep exploring the demo."));
	await announce("jobs-changed");
	await page.waitForNetworkIdle({ idleTime: 300 });
	await announce("jobs-changed");
	await page.waitForNetworkIdle({ idleTime: 300 });
	assert.equal(await page.$$eval('[data-testid="demo-iframe"]', (elements) => elements.length), 1);
	assert.equal(await page.evaluate(() => document.querySelector('[data-testid="demo-iframe"]') === window.__originalDemoIframe), true);
	assert.equal(await frame.$eval("#counter", (element) => element.textContent), "2");
	assert.equal(await page.$eval('[aria-label="Invert demo brightness"]', (element) => element.getAttribute("aria-checked")), "true");
	assert.equal(posts.length, 1);
	await page.reload({ waitUntil: "networkidle0" });
	await page.waitForSelector('[data-testid="demo-iframe"]');
	assert.equal(await page.$eval('[aria-label="Invert demo brightness"]', (element) => element.getAttribute("aria-checked")), "true");
	assert.deepEqual(errors, []);
	console.log("PASS: demo appears before answering; draft survives; one iframe retains interaction through delivery; brightness survives reload; no unsolicited teacher request.");
} finally {
	await browser?.close();
	if (server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
	fs.rmSync(dataDir, { recursive: true, force: true });
}
