import { describe, expect, it } from "bun:test";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { matchSpokenAnswer, normalizeSpoken, toResultItem } from "../../src/voice/ask-answer";

function question(overrides: Partial<ExtensionAskDialogQuestion> = {}): ExtensionAskDialogQuestion {
	return {
		id: "q1",
		question: "Qual banco usar?",
		options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "MySQL" }],
		...overrides,
	};
}

describe("normalizeSpoken", () => {
	it("strips accents, punctuation and case", () => {
		expect(normalizeSpoken("  Não,   obrigado!  ")).toBe("nao obrigado");
	});
});

describe("matchSpokenAnswer", () => {
	it("maps a number to the option at that position", () => {
		expect(matchSpokenAnswer(question(), "2")).toEqual({ selectedOptions: ["Postgres"] });
	});

	it("maps a Portuguese ordinal", () => {
		expect(matchSpokenAnswer(question(), "a segunda opção")).toEqual({ selectedOptions: ["Postgres"] });
	});

	it("maps an exact label regardless of case and accents", () => {
		expect(matchSpokenAnswer(question(), "postgres")).toEqual({ selectedOptions: ["Postgres"] });
	});

	it("maps a label mentioned inside a sentence", () => {
		expect(matchSpokenAnswer(question(), "eu acho melhor o MySQL aqui")).toEqual({
			selectedOptions: ["MySQL"],
		});
	});

	it("maps yes/no words onto yes/no labels", () => {
		const confirm: ExtensionAskDialogQuestion = {
			id: "confirm",
			question: "Aplicar?",
			options: [{ label: "Sim" }, { label: "Não" }],
		};
		expect(matchSpokenAnswer(confirm, "sim, pode aplicar")).toEqual({ selectedOptions: ["Sim"] });
		expect(matchSpokenAnswer(confirm, "não")).toEqual({ selectedOptions: ["Não"] });
	});

	it("falls back to free text when nothing matches", () => {
		const answer = matchSpokenAnswer(question(), "usar uma réplica somente leitura");
		expect(answer?.selectedOptions).toEqual([]);
		expect(answer?.customInput).toBe("usar uma réplica somente leitura");
	});

	it("does not read a number inside prose as an option", () => {
		const answer = matchSpokenAnswer(question(), "usar 2 fases de migração");
		expect(answer?.selectedOptions).toEqual([]);
		expect(answer?.customInput).toBe("usar 2 fases de migração");
	});

	it("still accepts a number with an option marker", () => {
		expect(matchSpokenAnswer(question(), "quero a opção 2")).toEqual({ selectedOptions: ["Postgres"] });
	});

	it("collects several options for a multi question", () => {
		const multi = question({ multi: true });
		expect(matchSpokenAnswer(multi, "um e três")).toEqual({
			selectedOptions: ["SQLite", "MySQL"],
		});
		expect(matchSpokenAnswer(multi, "todos")).toEqual({
			selectedOptions: ["SQLite", "Postgres", "MySQL"],
		});
	});

	it("never picks an option for an empty utterance", () => {
		expect(matchSpokenAnswer(question(), "   ")).toBeUndefined();
	});
});

describe("toResultItem", () => {
	it("keeps the question id, the option list and the selected label", () => {
		const item = toResultItem(question(), { selectedOptions: ["Postgres"] });
		expect(item).toEqual({
			id: "q1",
			question: "Qual banco usar?",
			options: ["SQLite", "Postgres", "MySQL"],
			multi: false,
			selectedOptions: ["Postgres"],
		});
	});

	it("uses free text instead of a selection for a single-select question", () => {
		const item = toResultItem(question(), { selectedOptions: ["SQLite"], customInput: "DuckDB" });
		expect(item.selectedOptions).toEqual([]);
		expect(item.customInput).toBe("DuckDB");
	});

	it("drops labels the question does not declare", () => {
		const item = toResultItem(question(), { selectedOptions: ["Oracle"] });
		expect(item.selectedOptions).toEqual([]);
	});
});
