import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import type { VoiceSpeech } from "../../src/voice/ask-bridge";
import {
	clearActiveVoiceSpeech,
	decorateVoiceAsk,
	setActiveVoiceSpeech,
} from "../../src/voice/registry";

class FakeSpeech implements VoiceSpeech {
	readonly kind = "local" as const;
	constructor(private readonly answer: string) {}
	speak(): void {}
	listen(): Promise<string | undefined> {
		return Promise.resolve(this.answer);
	}
	cancel(): void {}
}

interface FakeUi {
	ui: ExtensionUIContext;
	approveCalls: number;
	dialogCalls: number;
}

function fakeUi(askDialogResult: unknown, pending = false): FakeUi {
	const state: FakeUi = { approveCalls: 0, dialogCalls: 0, ui: undefined as unknown as ExtensionUIContext };
	state.ui = {
		askDialog: async (_questions: unknown, options?: { signal?: AbortSignal }) => {
			state.dialogCalls += 1;
			if (!pending) return askDialogResult;
			// A real TUI dialog stays open until the user answers or it is closed.
			return new Promise(resolve => {
				options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		},
		approve: async () => {
			state.approveCalls += 1;
			return { approved: true };
		},
		select: async () => undefined,
		notify: () => {},
	} as unknown as ExtensionUIContext;
	return state;
}

const question: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Qual banco usar?",
	options: [{ label: "SQLite" }, { label: "Postgres" }],
};

afterEach(() => {
	clearActiveVoiceSpeech();
	delete process.env.OMP_VOICE_ASK;
});

describe("decorateVoiceAsk", () => {
	it("resolves an ask dialog from the registered voice channel", async () => {
		setActiveVoiceSpeech(new FakeSpeech("2"));
		const fake = fakeUi(undefined, true);
		const decorated = decorateVoiceAsk(fake.ui);
		const result = await decorated.askDialog?.([question]);
		expect(result?.kind).toBe("submit");
		expect(result?.kind === "submit" ? result.results[0]?.selectedOptions : undefined).toEqual(["Postgres"]);
	});

	it("passes the dialog through untouched when no channel is registered", async () => {
		const keyboardResult = { kind: "submit" as const, results: [] };
		const fake = fakeUi(keyboardResult);
		const decorated = decorateVoiceAsk(fake.ui);
		expect(await decorated.askDialog?.([question])).toBe(keyboardResult);
		expect(fake.dialogCalls).toBe(1);
	});

	it("does not intercept approvals", async () => {
		setActiveVoiceSpeech(new FakeSpeech("2"));
		const fake = fakeUi(undefined);
		const decorated = decorateVoiceAsk(fake.ui);
		await decorated.approve?.({ title: "Run rm -rf?", details: "delete files" } as never);
		expect(fake.approveCalls).toBe(1);
	});

	it("honors the kill switch", async () => {
		setActiveVoiceSpeech(new FakeSpeech("2"));
		process.env.OMP_VOICE_ASK = "0";
		const keyboardResult = { kind: "submit" as const, results: [] };
		const fake = fakeUi(keyboardResult);
		const decorated = decorateVoiceAsk(fake.ui);
		expect(await decorated.askDialog?.([question])).toBe(keyboardResult);
	});
});
