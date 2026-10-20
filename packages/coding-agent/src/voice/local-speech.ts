/**
 * Local speech channel: the vocalizer speaks, the local STT worker listens.
 *
 * Used when no live session is attached. Both halves are the same components
 * the terminal already uses (`speech.enabled` for TTS, `stt.enabled` for
 * dictation), so enabling the bridge costs no new dependency. When either
 * setting is off the channel reports itself unavailable and the dialog stays
 * keyboard-only.
 */
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { sttClient, type SttStreamHandle } from "../stt/asr-client";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import type { SttModelKey } from "../stt/models";
import { cfgSttEnabled, cfgSttLanguage } from "../stt/settings";
import type { VoiceSpeech } from "./ask-bridge";

/** Smallest bundled dictation model: enough for short spoken answers. */
const LOCAL_STT_MODEL: SttModelKey = "whisper-base";

export class LocalVoiceSpeech implements VoiceSpeech {
	readonly kind = "local" as const;

	speak(_text: string): void {
		// The `ask` tool already sends its questions to the vocalizer when
		// `speech.enabled` is on, so speaking here would repeat every question.
	}

	listen(signal: AbortSignal): Promise<string | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		if (!cfgSttEnabled.get(settings)) return Promise.resolve(undefined);

		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let capture: AudioCapture | undefined;
		let stream: SttStreamHandle | undefined;
		let settled = false;

		const finish = (text: string | undefined): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			try {
				capture?.stop();
			} catch (error) {
				logger.debug("voice ask: microphone stop failed", { error: String(error) });
			}
			try {
				stream?.cancel();
			} catch (error) {
				logger.debug("voice ask: stt cancel failed", { error: String(error) });
			}
			resolve(text);
		};
		const onAbort = (): void => finish(undefined);
		signal.addEventListener("abort", onAbort, { once: true });

		void (async () => {
			try {
				if (!(await isSttModelCached(LOCAL_STT_MODEL))) {
					await downloadSttModel(LOCAL_STT_MODEL, undefined, { signal });
				}
				if (settled || signal.aborted) return finish(undefined);
				stream = sttClient.startStream(LOCAL_STT_MODEL, {
					language: cfgSttLanguage.get(settings),
					signal,
					onSegment: text => finish(text),
				});
				capture = new AudioCapture(16_000, (error, samples) => {
					if (error) {
						logger.debug("voice ask: microphone capture failed", { error: error.message });
						finish(undefined);
						return;
					}
					stream?.pushAudio(samples);
				});
			} catch (error) {
				logger.debug("voice ask: local listen unavailable", { error: String(error) });
				finish(undefined);
			}
		})();

		return promise;
	}

	cancel(): void {
		// Listening is cancelled through the bridge's abort signal.
	}
}
