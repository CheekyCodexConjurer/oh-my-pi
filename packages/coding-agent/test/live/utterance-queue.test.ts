import { describe, expect, it } from "bun:test";
import { LiveUtteranceQueue } from "../../src/live/utterance-queue";

describe("LiveUtteranceQueue", () => {
	it("resolves a listen with the transcript of a later turn", async () => {
		const queue = new LiveUtteranceQueue();
		const pending = queue.wait(undefined, 1);
		queue.deliver("opção dois", 2);
		expect(await pending).toBe("opção dois");
	});

	it("ignores a stale transcript from the turn that was current at registration", async () => {
		const queue = new LiveUtteranceQueue();
		let settled = false;
		const pending = queue.wait(undefined, 3).then(text => {
			settled = true;
			return text;
		});
		// turn.done for the turn already running when the question was announced
		expect(queue.deliver("fala anterior", 3)).toBe(false);
		await Promise.resolve();
		expect(settled).toBe(false);
		queue.deliver("resposta", 4);
		expect(await pending).toBe("resposta");
	});

	it("offers a delegation to listeners regardless of turn", async () => {
		const queue = new LiveUtteranceQueue();
		const pending = queue.wait(undefined, 7);
		expect(queue.deliver("usar postgres", 7, { allowStale: true })).toBe(true);
		expect(await pending).toBe("usar postgres");
	});

	it("suppresses delegations for the answered turn and releases the next one", () => {
		const queue = new LiveUtteranceQueue();
		const pending = queue.wait(undefined, 1);
		queue.deliver("opção um", 2);
		void pending;
		expect(queue.shouldSuppressDelegation(2)).toBe(true);
		expect(queue.shouldSuppressDelegation(3)).toBe(false);
	});

	it("resolves undefined on abort without leaking the listener", async () => {
		const queue = new LiveUtteranceQueue();
		const controller = new AbortController();
		const pending = queue.wait(controller.signal, 1);
		controller.abort();
		expect(await pending).toBeUndefined();
		expect(queue.pending).toBe(0);
	});

	it("resolves undefined for every listener on release", async () => {
		const queue = new LiveUtteranceQueue();
		const first = queue.wait(undefined, 1);
		const second = queue.wait(undefined, 1);
		queue.release();
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
		expect(queue.pending).toBe(0);
	});

	it("answers only listeners registered before the utterance", async () => {
		const queue = new LiveUtteranceQueue();
		const early = queue.wait(undefined, 1);
		queue.deliver("a", 2);
		expect(await early).toBe("a");
		const late = queue.wait(undefined, 2);
		expect(queue.deliver("b", 2)).toBe(false);
		queue.deliver("c", 3);
		expect(await late).toBe("c");
	});
});
