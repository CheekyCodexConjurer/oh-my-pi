/**
 * Live speech channel for the ask voice bridge.
 *
 * The realtime model is the voice: questions are appended as `speakable`
 * context so it reads them aloud, and the user's next turn transcript (or the
 * delegation the model would otherwise run) becomes the answer. While a
 * listener is waiting, the live controller suppresses delegations, so a spoken
 * answer is not mistaken for a new task.
 */
import type { LiveSessionController } from "../live/controller";
import type { VoiceSpeech } from "./ask-bridge";

export class LiveVoiceSpeech implements VoiceSpeech {
	readonly kind = "live" as const;

	constructor(private readonly controller: LiveSessionController) {}

	speak(text: string): void {
		this.controller.appendSpokenContext(text);
	}

	listen(signal: AbortSignal): Promise<string | undefined> {
		return this.controller.waitForUserUtterance(signal);
	}

	cancel(): void {
		// A pending listen is aborted through its own signal; nothing to flush here.
	}
}
