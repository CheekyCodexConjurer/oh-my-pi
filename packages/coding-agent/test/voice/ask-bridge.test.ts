import { describe, expect, it } from "bun:test";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import {
	buildSpokenQuestion,
	runVoiceAskDialog,
	type VoiceAskDialogOptions,
	type VoiceSpeech,
} from "../../src/voice/ask-bridge";

/** Speech channel that replays canned utterances and never resolves on its own when exhausted. */
class FakeSpeech implements VoiceSpeech {
	readonly kind = "local" as const;
	readonly spoken: string[] = [];
	#answers: Array<string | undefined>;

	constructor(answers: Array<string | undefined> = []) {
		this.#answers = [...answers];
	}

	speak(text: string): void {
		this.spoken.push(text);
	}

	listen(signal: AbortSignal): Promise<string | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		const answer = this.#answers.shift();
		return new Promise<string | undefined>(resolve => {
			const onAbort = (): void => resolve(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
			if (answer !== undefined) {
				queueMicrotask(() => resolve(answer));
			}
		});
	}

	cancel(): void {}
}

interface FakeDialog {
	open: (
		questions: ExtensionAskDialogQuestion[],
		options: VoiceAskDialogOptions,
	) => Promise<ExtensionAskDialogResult | undefined>;
	calls: Array<{ questions: ExtensionAskDialogQuestion[]; options: VoiceAskDialogOptions }>;
	submit: (result: ExtensionAskDialogResult) => void;
}

function fakeDialog(): FakeDialog {
	const calls: FakeDialog["calls"] = [];
	let resolveDialog: ((result: ExtensionAskDialogResult | undefined) => void) | undefined;
	return {
		calls,
		submit: result => resolveDialog?.(result),
		open: (questions, options) => {
			calls.push({ questions, options });
			return new Promise<ExtensionAskDialogResult | undefined>(resolve => {
				resolveDialog = resolve;
				options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		},
	};
}

const databaseQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Qual banco usar?",
	options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "MySQL" }],
};

const databaseResult: ExtensionAskDialogResult = {
	kind: "submit",
	results: [
		{
			id: "db",
			question: "Qual banco usar?",
			options: ["SQLite", "Postgres", "MySQL"],
			multi: false,
			selectedOptions: ["SQLite"],
		},
	],
};

describe("buildSpokenQuestion", () => {
	it("numbers every option and tells the user how to answer", () => {
		const text = buildSpokenQuestion(databaseQuestion, 0, 1);
		expect(text).toContain("Qual banco usar?");
		expect(text).toContain("1. SQLite");
		expect(text).toContain("2. Postgres");
		expect(text).toContain("3. MySQL");
		expect(text).toContain("Diga o número ou o nome da opção.");
	});
});

describe("runVoiceAskDialog", () => {
	it("answers a single-select question by voice and closes the visual dialog", async () => {
		const dialog = fakeDialog();
		const speech = new FakeSpeech(["opção 2"]);
		const result = await runVoiceAskDialog({
			questions: [databaseQuestion],
			speech,
			open: dialog.open,
		});
		expect(result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Qual banco usar?",
					options: ["SQLite", "Postgres", "MySQL"],
					multi: false,
					selectedOptions: ["Postgres"],
				},
			],
		});
		expect(speech.spoken[0]).toContain("Qual banco usar?");
		expect(dialog.calls[0]?.options.signal?.aborted).toBe(true);
	});

	it("keeps a free-form spoken answer as custom input", async () => {
		const dialog = fakeDialog();
		const result = await runVoiceAskDialog({
			questions: [databaseQuestion],
			speech: new FakeSpeech(["prefiro uma réplica só para leitura"]),
			open: dialog.open,
		});
		const item = result?.kind === "submit" ? result.results[0] : undefined;
		expect(item?.selectedOptions).toEqual([]);
		expect(item?.customInput).toBe("prefiro uma réplica só para leitura");
	});

	it("returns the dialog result when the keyboard answers first", async () => {
		const dialog = fakeDialog();
		const speech = new FakeSpeech(["3"]);
		const pending = runVoiceAskDialog({
			questions: [databaseQuestion],
			speech,
			open: dialog.open,
		});
		dialog.submit(databaseResult);
		expect(await pending).toEqual(databaseResult);
	});

	it("answers a multi-select question with several options", async () => {
		const dialog = fakeDialog();
		const multi: ExtensionAskDialogQuestion = { ...databaseQuestion, multi: true };
		const result = await runVoiceAskDialog({
			questions: [multi],
			speech: new FakeSpeech(["um e três"]),
			open: dialog.open,
		});
		const item = result?.kind === "submit" ? result.results[0] : undefined;
		expect(item?.selectedOptions).toEqual(["SQLite", "MySQL"]);
		expect(item?.multi).toBe(true);
	});

	it("walks multiple questions in order", async () => {
		const dialog = fakeDialog();
		const second: ExtensionAskDialogQuestion = {
			id: "deploy",
			question: "Publicar agora?",
			options: [{ label: "Sim" }, { label: "Não" }],
		};
		const result = await runVoiceAskDialog({
			questions: [databaseQuestion, second],
			speech: new FakeSpeech(["2", "sim"]),
			open: dialog.open,
		});
		expect(result?.kind === "submit" ? result.results.map(item => item.selectedOptions) : undefined).toEqual([
			["Postgres"],
			["Sim"],
		]);
	});

	it("stays pending on silence and never selects an option by itself", async () => {
		const dialog = fakeDialog();
		const speech = new FakeSpeech([]);
		const pending = runVoiceAskDialog({
			questions: [databaseQuestion],
			speech,
			open: dialog.open,
		});
		const settled = await Promise.race([
			pending.then(() => "settled" as const),
			new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 40)),
		]);
		expect(settled).toBe("pending");
	});

	it("drops the ask deadline so silence cannot auto-submit", async () => {
		const dialog = fakeDialog();
		let timedOut = false;
		const result = await runVoiceAskDialog({
			questions: [databaseQuestion],
			speech: new FakeSpeech(["2"]),
			open: dialog.open,
			options: { timeout: 5_000, onTimeout: () => (timedOut = true), acceptImages: true },
		});
		expect(dialog.calls[0]?.options.timeout).toBeUndefined();
		expect(dialog.calls[0]?.options.onTimeout).toBeUndefined();
		// Everything else the rich dialog needs survives the rewrite.
		expect(dialog.calls[0]?.options.acceptImages).toBe(true);
		expect(timedOut).toBe(false);
		expect(result?.kind).toBe("submit");
	});

	it("raises exactly one visual notification per dialog", async () => {
		const dialog = fakeDialog();
		let notified = 0;
		const second: ExtensionAskDialogQuestion = {
			id: "deploy",
			question: "Publicar agora?",
			options: [{ label: "Sim" }, { label: "Não" }],
		};
		await runVoiceAskDialog({
			questions: [databaseQuestion, second],
			speech: new FakeSpeech(["2", "sim"]),
			open: dialog.open,
			notify: () => (notified += 1),
		});
		expect(notified).toBe(1);
	});

	it("returns undefined when the outer signal aborts", async () => {
		const dialog = fakeDialog();
		const controller = new AbortController();
		const pending = runVoiceAskDialog({
			questions: [databaseQuestion],
			speech: new FakeSpeech([]),
			open: dialog.open,
			options: { signal: controller.signal },
		});
		controller.abort();
		expect(await pending).toBeUndefined();
	});
});
