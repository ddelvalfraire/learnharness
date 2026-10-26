import type { ChatStore } from "../../src/core/ports.ts";
import type { TurnRunner } from "../../src/server/jobs.ts";

/** A successful scripted turn commits its input just like the real composition. */
export function durableWake(chatStore: Pick<ChatStore, "getChat" | "saveMessages">, run: TurnRunner): TurnRunner {
	return async (chatId, input) => {
		const status = await run(chatId, input);
		const chat = chatStore.getChat(chatId);
		if (status === 200 && chat && input.type === "steers") {
			const ids = new Set(chat.messages.map((message) => message.id));
			chatStore.saveMessages(chatId, [...chat.messages, ...input.steers.filter((message) => !ids.has(message.id))]);
		}
		return status;
	};
}
