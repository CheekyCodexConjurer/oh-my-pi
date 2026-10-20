/**
 * Voice bridge for the `ask` dialog.
 *
 * When an agent asks the user a question, the bridge speaks the question and
 * its options through an active speech channel, listens for a spoken answer,
 * and resolves the dialog with the matching option (or free text). The visual
 * dialog keeps running in parallel: whichever answers first wins, and an
 * unanswered question stays pending forever (no timeout, no auto-selection).
 */
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { ExtensionUIDialogOptions } from "../extensibility/extensions/types";
import { matchSpokenAnswer, type SpokenAnswer, toResultItem } from "./ask-answer";

/** Options the TUI ask dialog accepts; images are already part of the shared options. */
export type VoiceAskDialogOptions = ExtensionUIDialogOptions;

/** One speech channel: how to speak, and how to hear one utterance. */
export interface VoiceSpeech {
	readonly kind: "live" | "local";
	/** Announce text. Fire-and-forget: playback must not block the dialog. */
	speak(text: string): void;
	/** Resolve with the next utterance, or `undefined` when aborted. */
	listen(signal: AbortSignal): Promise<string | undefined>;
	/** Drop any pending listen. */
	cancel(): void;
}

export interface VoiceAskRequest {
	questions: readonly ExtensionAskDialogQuestion[];
	options?: VoiceAskDialogOptions;
	/** Open the real dialog; the bridge races it against speech. */
	open: (
		questions: ExtensionAskDialogQuestion[],
		options: VoiceAskDialogOptions,
	) => Promise<ExtensionAskDialogResult | undefined>;
	speech: VoiceSpeech;
	/** Visual fallback when the terminal is minimized; called once per dialog. */
	notify?: (question: string, details?: string) => void;
	log?: (message: string, data?: unknown) => void;
}

/** Compose the spoken form of one question: header, options, and how to answer. */
export function buildSpokenQuestion(question: ExtensionAskDialogQuestion, index: number, total: number): string {
	const lines: string[] = [];
	if (total > 1) lines.push(`Pergunta ${index + 1} de ${total}.`);
	if (question.header?.trim()) lines.push(question.header.trim());
	lines.push(question.question.trim());
	if (question.options.length > 0) {
		lines.push("Opções:");
		for (const [optionIndex, option] of question.options.entries()) {
			const description = option.description?.trim();
			lines.push(`${optionIndex + 1}. ${option.label}${description ? `. ${description}` : ""}`);
		}
		lines.push(
			question.multi === true
				? "Você pode escolher várias, dizendo os números ou os nomes."
				: "Diga o número ou o nome da opção.",
		);
		lines.push("Se preferir, responda livremente.");
	} else {
		lines.push("Responda livremente.");
	}
	return lines.join("\n");
}

type DialogOutcome =
	| { type: "dialog"; result: ExtensionAskDialogResult | undefined }
	| { type: "dialog-error"; error: unknown };

type ListenOutcome = { type: "spoken"; text: string | undefined } | { type: "listen-error"; error: unknown };

/**
 * Replace the dialog signal and drop its deadline.
 *
 * `ask.timeout` would let the dialog submit the recommended option on elapsed
 * time. When a voice channel answers, silence must never choose anything, so
 * the deadline is removed for this dialog only.
 */
function withVoiceSignal(options: VoiceAskDialogOptions | undefined, signal: AbortSignal): VoiceAskDialogOptions {
	const dialogOptions: VoiceAskDialogOptions = { ...options, signal };
	delete dialogOptions.timeout;
	delete dialogOptions.onTimeout;
	delete dialogOptions.onTimeoutStart;
	delete dialogOptions.onTimeoutReset;
	return dialogOptions;
}

/**
 * Race the visual dialog against the voice channel for every question.
 *
 * The dialog is opened once and stays available as the fallback. A spoken
 * answer for each question is collected in order; once all questions have a
 * spoken answer the dialog is closed and the synthesized result is returned.
 * Nothing resolves the dialog on silence: the wait is unbounded unless the
 * caller supplies its own abort signal.
 */
export async function runVoiceAskDialog(request: VoiceAskRequest): Promise<ExtensionAskDialogResult | undefined> {
	const { questions, options, open, speech, notify, log } = request;
	if (questions.length === 0) {
		// Nothing to ask: still normalize the options so a deadline cannot survive.
		return open([...questions], withVoiceSignal(options, new AbortController().signal));
	}

	const outer = options?.signal;
	if (outer?.aborted) return undefined;

	const closeDialog = new AbortController();
	const onOuterAbort = (): void => closeDialog.abort();
	outer?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const dialogPromise: Promise<DialogOutcome> = open(
			[...questions],
			withVoiceSignal(options, closeDialog.signal),
		).then(
			result => ({ type: "dialog", result }),
			error => ({ type: "dialog-error", error }),
		);

		const answers: SpokenAnswer[] = [];
		for (const [index, question] of questions.entries()) {
			if (closeDialog.signal.aborted) {
				speech.cancel();
				return await dialogPromise.then(outcome => (outcome.type === "dialog" ? outcome.result : undefined));
			}
			if (index === 0) {
				notify?.(
					question.question,
					question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}`).join("  "),
				);
			}
			speech.speak(buildSpokenQuestion(question, index, questions.length));
			log?.("voice ask: announced question", { id: question.id, index });

			const listenAbort = new AbortController();
			const onDialogAbort = (): void => listenAbort.abort();
			closeDialog.signal.addEventListener("abort", onDialogAbort, { once: true });
			const listenPromise: Promise<ListenOutcome> = speech.listen(listenAbort.signal).then(
				text => ({ type: "spoken", text }),
				error => ({ type: "listen-error", error }),
			);

			let winner: DialogOutcome | ListenOutcome;
			try {
				winner = await Promise.race([dialogPromise, listenPromise]);
			} finally {
				closeDialog.signal.removeEventListener("abort", onDialogAbort);
			}

			if (winner.type === "dialog") {
				listenAbort.abort();
				speech.cancel();
				return winner.result;
			}
			if (winner.type === "dialog-error") {
				listenAbort.abort();
				speech.cancel();
				throw winner.error;
			}
			if (winner.type === "listen-error") {
				speech.cancel();
				throw winner.error;
			}
			if (winner.text === undefined) {
				speech.cancel();
				return await dialogPromise.then(outcome => (outcome.type === "dialog" ? outcome.result : undefined));
			}
			const answer = matchSpokenAnswer(question, winner.text);
			if (!answer) {
				log?.("voice ask: empty utterance ignored", { id: question.id });
				speech.cancel();
				return await dialogPromise.then(outcome => (outcome.type === "dialog" ? outcome.result : undefined));
			}
			log?.("voice ask: answer captured", {
				id: question.id,
				selected: answer.selectedOptions,
				custom: answer.customInput !== undefined,
			});
			answers.push(answer);
		}

		speech.cancel();
		closeDialog.abort();
		return {
			kind: "submit",
			results: questions.map((question, index) => toResultItem(question, answers[index]!)),
		};
	} finally {
		outer?.removeEventListener("abort", onOuterAbort);
	}
}
