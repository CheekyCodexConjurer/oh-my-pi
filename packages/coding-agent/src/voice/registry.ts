/**
 * Active voice channel and the ask-dialog decorator.
 *
 * The live command controller registers a {@link VoiceSpeech} while `/live`
 * runs; otherwise the decorator offers the local TTS/STT channel when both
 * `speech.enabled` and `stt.enabled` are on. With no channel at all the
 * decorator is transparent, so every dialog keeps its native keyboard flow.
 */
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { settings } from "../config/settings";
import { cfgSttEnabled } from "../stt/settings";
import { cfgSpeechEnabled } from "../tts/settings";
import { runVoiceAskDialog, type VoiceAskDialogOptions, type VoiceSpeech } from "./ask-bridge";
import { notifyPendingQuestion } from "./desktop-notify";
import { LocalVoiceSpeech } from "./local-speech";

let activeSpeech: VoiceSpeech | undefined;
let localSpeech: VoiceSpeech | undefined;

/** Whether the bridge can run at all (kill switch for troubleshooting). */
export function isVoiceAskEnabled(): boolean {
	return process.env.OMP_VOICE_ASK !== "0";
}

/** Attach the channel that should answer ask dialogs (live session wins). */
export function setActiveVoiceSpeech(speech: VoiceSpeech): void {
	activeSpeech = speech;
}

/** Detach `speech` if it is still the registered channel. */
export function clearActiveVoiceSpeech(speech?: VoiceSpeech): void {
	if (speech === undefined || activeSpeech === speech) activeSpeech = undefined;
}

/** Whether the local TTS/STT pair is enabled; false when settings are not ready. */
function localChannelAvailable(): boolean {
	// A headless RPC/ACP host has no local user to speak to, and opening the
	// microphone there would capture the host room for a remote client.
	if (!process.stdin.isTTY) return false;
	try {
		return cfgSpeechEnabled.get(settings) && cfgSttEnabled.get(settings);
	} catch {
		return false;
	}
}

/** The channel used for the next dialog, if any. */
export function getVoiceAskSpeech(): VoiceSpeech | undefined {
	if (!isVoiceAskEnabled()) return undefined;
	if (activeSpeech) return activeSpeech;
	if (localSpeech) return localSpeech;
	if (!localChannelAvailable()) return undefined;
	localSpeech = new LocalVoiceSpeech();
	return localSpeech;
}

/**
 * Wrap `askDialog` so a spoken answer can resolve it.
 *
 * Only `askDialog` is intercepted. Approvals (`approve`/`confirm`), selects and
 * inputs keep their explicit keyboard authorization; the proxy binds the
 * remaining members like the user-wait decorator does.
 */
export function decorateVoiceAsk<T extends ExtensionUIContext>(ui: T): T {
	const methods = new Map<PropertyKey, { value: unknown; wrapper: unknown }>();
	return new Proxy(ui, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const cached = methods.get(property);
			if (cached?.value === value) return cached.wrapper;
			const wrapper: unknown =
				property === "askDialog"
					? (questions: ExtensionAskDialogQuestion[], dialogOptions?: VoiceAskDialogOptions) => {
							const speech = getVoiceAskSpeech();
							const base = value as (
								questions: ExtensionAskDialogQuestion[],
								options?: VoiceAskDialogOptions,
							) => Promise<ExtensionAskDialogResult | undefined>;
							if (!speech) return base.call(target, questions, dialogOptions);
							return runVoiceAskDialog({
								questions,
								options: dialogOptions,
								speech,
								open: (forwarded, options) => base.call(target, forwarded, options),
								notify: (question, details) => notifyPendingQuestion(question, details),
								log: (message, data) => logger.debug(message, data as never),
							});
						}
					: value.bind(target);
			methods.set(property, { value, wrapper });
			return wrapper;
		},
	});
}
