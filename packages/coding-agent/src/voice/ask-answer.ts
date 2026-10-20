/**
 * Spoken-answer normalization for the voice ask bridge.
 *
 * Turns one utterance into the shape an ask dialog expects. The mapping is
 * deliberately conservative: a number, an ordinal, the exact label, or a
 * yes/no word may select an option; anything else becomes a free-form
 * (`customInput`) answer, which ask already supports. Nothing is ever chosen
 * because a recommendation exists or because time passed.
 */
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";

/** One normalized answer for one question. */
export interface SpokenAnswer {
	/** Labels exactly as the question declared them. */
	selectedOptions: string[];
	/** Free-form answer when no option matched. */
	customInput?: string;
}

/** Ordinal words (Portuguese and English); values are zero-based option indexes. */
const ORDINALS: Record<string, number> = {
	primeiro: 0,
	primeira: 0,
	first: 0,
	segundo: 1,
	segunda: 1,
	second: 1,
	terceiro: 2,
	terceira: 2,
	third: 2,
	quarto: 3,
	quarta: 3,
	fourth: 3,
	quinto: 4,
	quinta: 4,
	fifth: 4,
	sexto: 5,
	sexta: 5,
	sixth: 5,
	setimo: 6,
	setima: 6,
	seventh: 6,
	oitavo: 7,
	oitava: 7,
	eighth: 7,
	nono: 8,
	nona: 8,
	ninth: 8,
	decimo: 9,
	decima: 9,
	tenth: 9,
};

/** Number words up to ten, only trusted when the utterance is clearly a choice. */
const NUMBERS: Record<string, number> = {
	um: 0,
	uma: 0,
	one: 0,
	dois: 1,
	duas: 1,
	two: 1,
	tres: 2,
	three: 2,
	quatro: 3,
	four: 3,
	cinco: 4,
	five: 4,
	seis: 5,
	six: 5,
	sete: 6,
	seven: 6,
	oito: 7,
	eight: 7,
	nove: 8,
	nine: 8,
	dez: 9,
	ten: 9,
};

/** Words that announce a following option reference ("option 2", "letra b"). */
const INDEX_MARKERS = new Set([
	"opcao",
	"opcoes",
	"numero",
	"letra",
	"alternativa",
	"item",
	"option",
	"number",
	"letter",
	"resposta",
]);

/** Articles that turn "o 2" / "a 2" into an option reference. */
const DECISION_CONNECTORS = new Set(["a", "o", "na", "no"]);

const AFFIRMATIVE = new Set([
	"sim",
	"yes",
	"claro",
	"confirmo",
	"confirmar",
	"confirmado",
	"aprovo",
	"aprovado",
	"autorizo",
	"pode",
	"ok",
	"aceito",
	"certo",
	"positivo",
]);

const NEGATIVE = new Set([
	"nao",
	"no",
	"negativo",
	"nego",
	"negar",
	"recuso",
	"recusar",
	"cancelar",
	"cancela",
	"cancelo",
	"pare",
	"parar",
]);

const FILLER_PREFIXES = [
	"a resposta e",
	"a resposta seria",
	"eu escolho",
	"eu quero",
	"eu prefiro",
	"escolho",
	"prefiro",
	"quero",
	"opcao",
	"opcao numero",
	"numero",
	"letra",
	"alternativa",
	"resposta",
	"the answer is",
	"i choose",
	"i want",
	"option",
	"number",
];

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeSpoken(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stripFillers(text: string): string {
	let current = text;
	for (const prefix of FILLER_PREFIXES) {
		if (current === prefix) return "";
		if (current.startsWith(`${prefix} `)) current = current.slice(prefix.length + 1).trim();
	}
	return current;
}

/**
 * Option index named by the utterance, when the wording is clearly a choice.
 *
 * Ordinals count anywhere. A number word only counts at the start of a short
 * phrase or right after a marker, and a digit only alone, after a marker, or
 * after an article, so "uma réplica só para leitura" and "usar 2 fases" stay
 * free text.
 */
function indexFromText(text: string, optionCount: number): number | undefined {
	const tokens = text.split(" ").filter(Boolean);
	for (const [position, token] of tokens.entries()) {
		if (/^\d{1,2}$/.test(token)) {
			const index = Number(token) - 1;
			if (index >= 0 && index < optionCount) {
				const previous = tokens[position - 1] ?? "";
				const clearlyAChoice =
					tokens.length === 1 || INDEX_MARKERS.has(previous) || DECISION_CONNECTORS.has(previous);
				// "usar 2 fases" is prose, not option two.
				if (clearlyAChoice) return index;
			}
			continue;
		}
		const ordinal = ORDINALS[token];
		if (ordinal !== undefined) {
			if (ordinal < optionCount) return ordinal;
			continue;
		}
		const number = NUMBERS[token];
		if (number !== undefined && number < optionCount) {
			const atStartOfShortPhrase = position === 0 && tokens.length <= 3;
			const afterMarker = INDEX_MARKERS.has(tokens[position - 1] ?? "");
			if (atStartOfShortPhrase || afterMarker) return number;
			continue;
		}
		if (/^[a-j]$/.test(token) && (tokens.length === 1 || INDEX_MARKERS.has(tokens[position - 1] ?? ""))) {
			const index = token.charCodeAt(0) - 97;
			if (index < optionCount) return index;
		}
	}
	return undefined;
}

function decisionWord(text: string): "affirmative" | "negative" | undefined {
	const tokens = text.split(" ").filter(Boolean);
	if (tokens.length === 0 || tokens.length > 6) return undefined;
	if (tokens.some(token => NEGATIVE.has(token))) return "negative";
	if (tokens.some(token => AFFIRMATIVE.has(token))) return "affirmative";
	return undefined;
}

function labelForDecision(labels: readonly string[], decision: "affirmative" | "negative"): number | undefined {
	for (const [index, label] of labels.entries()) {
		if (decisionWord(normalizeSpoken(label)) === decision) return index;
	}
	return undefined;
}

function exactLabelIndex(normalizedText: string, labels: readonly string[]): number | undefined {
	for (const [index, label] of labels.entries()) {
		if (normalizeSpoken(label) === normalizedText) return index;
	}
	return undefined;
}

function containsLabelIndex(normalizedText: string, labels: readonly string[]): number | undefined {
	let best: { index: number; length: number } | undefined;
	for (const [index, label] of labels.entries()) {
		const normalized = normalizeSpoken(label);
		if (normalized.length < 3) continue;
		if (!normalizedText.includes(normalized)) continue;
		if (!best || normalized.length > best.length) best = { index, length: normalized.length };
	}
	return best?.index;
}

/** Resolve one choice phrase (no multi-select bookkeeping) to an option index. */
function resolveChoice(text: string, labels: readonly string[]): number | undefined {
	const stripped = stripFillers(text);
	const exact = exactLabelIndex(stripped, labels) ?? exactLabelIndex(text, labels);
	if (exact !== undefined) return exact;

	const decision = decisionWord(stripped) ?? decisionWord(text);
	if (decision) {
		const byDecision = labelForDecision(labels, decision);
		if (byDecision !== undefined) return byDecision;
	}

	const byIndex = indexFromText(stripped, labels.length) ?? indexFromText(text, labels.length);
	if (byIndex !== undefined) return byIndex;

	return containsLabelIndex(stripped, labels) ?? containsLabelIndex(text, labels);
}

function matchMulti(text: string, question: ExtensionAskDialogQuestion): SpokenAnswer {
	const labels = question.options.map(option => option.label);
	const picks = new Set<number>();
	if (/\b(todos|todas|all|any)\b/.test(text) && !/\b(nenhum|nenhuma|none)\b/.test(text)) {
		for (let index = 0; index < labels.length; index++) picks.add(index);
	}
	// "um e três", "1, 3", "primeira ou segunda"
	const segments = text
		.split(/\b(?:e|ou|and|or)\b|,/)
		.map(segment => segment.trim())
		.filter(Boolean);
	for (const segment of segments.length > 0 ? segments : [text]) {
		const index = resolveChoice(segment, labels);
		if (index !== undefined) picks.add(index);
	}
	if (picks.size > 0) {
		return {
			selectedOptions: [...picks].sort((left, right) => left - right).map(index => labels[index]!),
		};
	}
	return { selectedOptions: [], customInput: text };
}

/**
 * Map one utterance onto one question.
 *
 * Returns `undefined` only for an empty utterance; a non-empty utterance that
 * matches nothing is a free-form answer.
 */
export function matchSpokenAnswer(
	question: ExtensionAskDialogQuestion,
	transcript: string,
): SpokenAnswer | undefined {
	const raw = transcript.trim();
	if (!raw) return undefined;
	const text = normalizeSpoken(raw);
	if (!text) return undefined;
	const labels = question.options.map(option => option.label);
	if (labels.length === 0) return { selectedOptions: [], customInput: raw };
	if (question.multi === true) return matchMulti(text, question);

	const index = resolveChoice(text, labels);
	if (index !== undefined) return { selectedOptions: [labels[index]!] };
	return { selectedOptions: [], customInput: raw };
}

/** Turn one spoken answer into a dialog result item (ids and option order preserved). */
export function toResultItem(
	question: ExtensionAskDialogQuestion,
	answer: SpokenAnswer,
): { id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string } {
	const options = question.options.map(option => option.label);
	const multi = question.multi ?? false;
	const allowed = new Set(options);
	const selected = answer.selectedOptions.filter(label => allowed.has(label));
	const customInput = answer.customInput?.trim();
	const useCustom = customInput !== undefined && customInput.length > 0;
	// Single-select answers carry either a selection or free text, never both.
	const selectedOptions = multi ? selected : useCustom ? [] : selected.slice(0, 1);
	return {
		id: question.id,
		question: question.question,
		options,
		multi,
		selectedOptions,
		...(useCustom ? { customInput: customInput! } : {}),
	};
}
