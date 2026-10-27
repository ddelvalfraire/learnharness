import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell } from "../components/new-session.tsx";
import { startSession } from "../components/start-session.ts";

/**
 * The sessionless draft view (/chat/new, owner 2026-09-13): "+ New session"
 * opens the draft — NOTHING is created until the first message is sent, and
 * that message becomes the session's title. These pins hold the two seams:
 * startSession (the create-on-send contract) and DraftShell (the
 * visible surface: composer blob + stats bar + the fresh-chat empty state).
 */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startSession — the create-on-send contract", () => {
	it("creates the session with the first message, returns a URL containing only its ID", async () => {
		const { f, calls } = fakeFetch("c_new");
		const target = await startSession({ text: "teach me orbital mechanics", fetchLike: f });
		assert.equal(target, "/chat/c_new");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.equal(calls[0]!.method, "POST");
		assert.deepEqual(calls[0]!.body, { prompt: "teach me orbital mechanics" });
	});

	it("no settings PUT on create — the server stamps the newborn (per-session models, owner 2026-09-28)", async () => {
		const { f, calls } = fakeFetch("c_3");
		await startSession({ text: "hello", fetchLike: f });
		assert.equal(calls.length, 1, "a single create call — the birth stamp is server-side");
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startSession({ text: "", fetchLike: f }), null);
		assert.equal(await startSession({ text: "   ", fetchLike: f }), null);
		assert.equal(calls.length, 0);
	});

	it("failed creation and invalid IDs never produce a navigation target", async () => {
		await assert.rejects(startSession({ text: "draft", fetchLike: async () => new Response("", { status: 500 }) }), /Could not create/);
		await assert.rejects(startSession({ text: "draft", fetchLike: async () => Response.json({ id: "../elsewhere" }) }));
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("renders the composer blob, the stats bar, and the fresh-chat empty state", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		// The chat composer, ready for the first message.
		assert.ok(html.includes('data-testid="composer"'));
		// The draft's model control binds the strong slot — the
		// new-session default (per-session models, owner 2026-09-28).
		assert.ok(html.includes('data-testid="stats-model"'));
		// No CTA by default: a configured surface stays quiet.
		assert.ok(!html.includes('data-testid="setup-cta"'));
		// The same empty state a fresh chat shows.
		assert.ok(html.includes("The teacher will open by probing what you already know."));
		// The pointer-events pattern (953b22b): the wrapper stays inert…
		assert.ok(html.includes("pointer-events-none"));
		// …and the blob re-enables it.
		assert.ok(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/.test(html));
	});

	it("renders the setup CTA above the composer blob when passed (fix wave chunk B: /chat/new mirrors home)", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				setupCta={
					<button type="button" data-testid="setup-cta">
						Set up your models
					</button>
				}
			/>,
		);
		// The same affordance home carries, above the draft shell's blob.
		assert.ok(html.includes('data-testid="setup-cta"'));
		assert.match(html, />Set up your models<\/button>/);
		assert.doesNotMatch(html, /chats start after/);
		// Above the composer: the CTA's markup precedes the blob's.
		const cta = html.indexOf('data-testid="setup-cta"');
		const blob = html.search(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/);
		assert.ok(cta !== -1 && blob !== -1 && cta < blob, "CTA above the blob");
	});

	it("no chat id anywhere — nothing in the markup references a session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(html));
	});
});
describe("the practice draft (?mode=practice, 2026-10-04)", () => {
	it("the shell swaps copy: practice title, empty state, placeholder", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, /New practice session/);
		assert.ok(html.includes("Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."));
		assert.match(html, /What do you want to practice\?/);
	});

	it("THE PICK BAR (owner round 10): the practice draft carries the same pill above its composer", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, />Pick nodes<\/button>/);
		// picked: count + Clear, the home register verbatim
		const picked = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
				picks={[{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]}
			/>,
		);
		assert.match(picked, /1 node selected/);
		assert.match(picked, /Clear/);
		// teach mode with nothing picked renders nothing (home's law)
		const teach = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" />,
		);
		assert.ok(!teach.includes('data-testid="practice-props-chip"'));
	});

	it("startSession carries the picks as graphContext (the home practice contract)", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c10" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startSession({ text: "drill me", fetchLike: f, kind: "practice", picks: [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }] });
		assert.deepEqual(body, {
			prompt: "drill me",
			kind: "practice",
			graphContext: { propositions: [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }] },
		});
	});

	it("practice with NO picks stays lean — no graphContext key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c11" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startSession({ text: "free practice", fetchLike: f, kind: "practice", picks: [] });
		assert.deepEqual(body, { prompt: "free practice", kind: "practice" });
	});

	it("startSession carries kind:\"practice\" to the create route", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c9" }), { status: 201 });
		}) as unknown as typeof fetch;
		const target = await startSession({ text: "the parity chain", fetchLike: f, kind: "practice" });
		assert.equal(target, "/chat/c9");
		assert.deepEqual(body, { prompt: "the parity chain", kind: "practice" });
	});

	it("the teaching default is unchanged — no kind key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c8" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startSession({ text: "orbital mechanics", fetchLike: f });
		assert.deepEqual(body, { prompt: "orbital mechanics" });
	});
});
