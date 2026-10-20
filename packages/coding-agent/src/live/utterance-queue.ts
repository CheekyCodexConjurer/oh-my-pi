/**
 * Pending-listen bookkeeping for the live voice session.
 *
 * Keeps the two guarantees the ask bridge needs:
 * - a transcript only answers a listen registered before that user turn, so a
 *   delayed transcript from an earlier turn cannot fill a new question;
 * - the delegation the realtime model emits for the words that answered a
 *   question is not run as a new task.
 */
export interface UtteranceWaiter {
	/** Final transcripts at or before this user turn predate the question. */
	readonly minTurn: number;
	resolve(text: string | undefined): void;
}

export class LiveUtteranceQueue {
	#waiters = new Set<UtteranceWaiter>();
	#suppressedDelegationTurn: number | undefined;

	/** Register a listen; resolves `undefined` when `signal` aborts. */
	wait(signal?: AbortSignal, currentTurn = 0): Promise<string | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const waiter: UtteranceWaiter = {
			minTurn: currentTurn,
			resolve: text => {
				if (settled) return;
				settled = true;
				this.#waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
				resolve(text);
			},
		};
		const onAbort = (): void => waiter.resolve(undefined);
		this.#waiters.add(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	/**
	 * Hand an utterance to waiting listeners; true when at least one consumed it.
	 *
	 * A final transcript is only offered to listeners registered before its
	 * turn. A delegation is the model acting on the current request and is
	 * offered to every listener.
	 */
	deliver(text: string, currentTurn: number, options: { allowStale?: boolean } = {}): boolean {
		if (this.#waiters.size === 0) return false;
		let delivered = false;
		// Each waiter removes itself before resolving, so deleting during the walk is safe.
		for (const waiter of this.#waiters) {
			if (!options.allowStale && currentTurn <= waiter.minTurn) continue;
			delivered = true;
			waiter.resolve(text);
		}
		if (delivered) this.#suppressedDelegationTurn = currentTurn;
		return delivered;
	}

	/** Whether a delegation for `currentTurn` belongs to an ask answer, not a new task. */
	shouldSuppressDelegation(currentTurn: number): boolean {
		return this.#suppressedDelegationTurn !== undefined && currentTurn <= this.#suppressedDelegationTurn;
	}

	/** Fail every pending listen so a dialog falls back to its visual surface. */
	release(): void {
		for (const waiter of this.#waiters) waiter.resolve(undefined);
	}

	/** Number of listeners still waiting. */
	get pending(): number {
		return this.#waiters.size;
	}
}
