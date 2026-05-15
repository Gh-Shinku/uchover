import * as vscode from 'vscode';
import { unicodeName } from 'unicode-name';

const ESCAPE_PATTERN = /\\u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))|\\U([0-9A-Fa-f]{8})/g;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const MAX_UNICODE_CODE_POINT = 0x10ffff;

interface EscapeToken {
	start: number;
	end: number;
	sourceText: string;
	value: number;
	kind: 'basic' | 'scalar';
}

export interface UnicodeEscapeMatch {
	start: number;
	end: number;
	sourceText: string;
	codePoint: number;
	character: string;
	name: string | undefined;
}

export interface UnicodeSequenceMatch {
	characters: string;
	matchCount: number;
}

function parseEscapeTokens(text: string): EscapeToken[] {
	const tokens: EscapeToken[] = [];

	for (const match of text.matchAll(ESCAPE_PATTERN)) {
		const sourceText = match[0];
		const start = match.index;

		if (start === undefined) {
			continue;
		}

		if (match[1] !== undefined) {
			tokens.push({
				start,
				end: start + sourceText.length,
				sourceText,
				value: Number.parseInt(match[1], 16),
				kind: 'scalar',
			});
			continue;
		}

		if (match[2] !== undefined) {
			tokens.push({
				start,
				end: start + sourceText.length,
				sourceText,
				value: Number.parseInt(match[2], 16),
				kind: 'basic',
			});
			continue;
		}

		if (match[3] !== undefined) {
			tokens.push({
				start,
				end: start + sourceText.length,
				sourceText,
				value: Number.parseInt(match[3], 16),
				kind: 'scalar',
			});
		}
	}

	return tokens;
}

function isHighSurrogate(value: number): boolean {
	return value >= HIGH_SURROGATE_START && value <= HIGH_SURROGATE_END;
}

function isLowSurrogate(value: number): boolean {
	return value >= LOW_SURROGATE_START && value <= LOW_SURROGATE_END;
}

function isScalarValue(value: number): boolean {
	return value >= 0 && value <= MAX_UNICODE_CODE_POINT && !isHighSurrogate(value) && !isLowSurrogate(value);
}

function toCombinedCodePoint(highSurrogate: number, lowSurrogate: number): number {
	return ((highSurrogate - HIGH_SURROGATE_START) << 10)
		+ (lowSurrogate - LOW_SURROGATE_START)
		+ 0x10000;
}

function toUnicodeEscapeMatch(start: number, end: number, sourceText: string, codePoint: number): UnicodeEscapeMatch {
	const character = String.fromCodePoint(codePoint);

	return {
		start,
		end,
		sourceText,
		codePoint,
		character,
		name: unicodeName(character),
	};
}

function resolveBasicToken(tokens: EscapeToken[], tokenIndex: number): UnicodeEscapeMatch | undefined {
	const current = tokens[tokenIndex];

	if (!current || current.kind !== 'basic') {
		return undefined;
	}

	if (isHighSurrogate(current.value)) {
		const next = tokens[tokenIndex + 1];

		if (!next || next.kind !== 'basic' || next.start !== current.end || !isLowSurrogate(next.value)) {
			return undefined;
		}

		return toUnicodeEscapeMatch(
			current.start,
			next.end,
			`${current.sourceText}${next.sourceText}`,
			toCombinedCodePoint(current.value, next.value),
		);
	}

	if (isLowSurrogate(current.value)) {
		const previous = tokens[tokenIndex - 1];

		if (!previous || previous.kind !== 'basic' || previous.end !== current.start || !isHighSurrogate(previous.value)) {
			return undefined;
		}

		return toUnicodeEscapeMatch(
			previous.start,
			current.end,
			`${previous.sourceText}${current.sourceText}`,
			toCombinedCodePoint(previous.value, current.value),
		);
	}

	return toUnicodeEscapeMatch(current.start, current.end, current.sourceText, current.value);
}

export function collectUnicodeEscapes(text: string): UnicodeEscapeMatch[] {
	const tokens = parseEscapeTokens(text);
	const matches: UnicodeEscapeMatch[] = [];

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];

		if (token.kind === 'scalar') {
			if (isScalarValue(token.value)) {
				matches.push(toUnicodeEscapeMatch(token.start, token.end, token.sourceText, token.value));
			}

			continue;
		}

		const match = resolveBasicToken(tokens, index);

		if (!match) {
			continue;
		}

		matches.push(match);

		if (match.end > token.end) {
			index += 1;
		}
	}

	return matches;
}

export function resolveUnicodeEscapeAt(text: string, offset: number): UnicodeEscapeMatch | undefined {
	if (offset < 0 || offset >= text.length) {
		return undefined;
	}

	return collectUnicodeEscapes(text).find((match) => offset >= match.start && offset < match.end);
}

export function decodeUnicodeEscapeSequence(text: string): UnicodeSequenceMatch | undefined {
	const matches = collectUnicodeEscapes(text);

	if (matches.length === 0) {
		return undefined;
	}

	return {
		characters: matches.map((match) => match.character).join(''),
		matchCount: matches.length,
	};
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

function formatCodePoint(codePoint: number): string {
	return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

function getCharacterPreview(match: UnicodeEscapeMatch): string {
	if (/^[\p{C}\p{Z}]$/u.test(match.character)) {
		return `[${match.name?.toLowerCase() ?? `U+${formatCodePoint(match.codePoint)}`}]`;
	}

	return match.character;
}

export function buildHoverMarkdown(
	match: UnicodeEscapeMatch,
	sequenceMatch?: UnicodeSequenceMatch,
): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);

	markdown.appendMarkdown('**Character**\n\n');
	markdown.appendCodeblock(getCharacterPreview(match), 'text');
	markdown.appendMarkdown(`\n\n**Escape**: \`${escapeMarkdown(match.sourceText)}\``);
	markdown.appendMarkdown(`\n\n**Code point**: \`U+${formatCodePoint(match.codePoint)}\``);
	markdown.appendMarkdown(`\n\n**Name**: ${escapeMarkdown(match.name ?? 'Unknown')}`);

	if (sequenceMatch) {
		markdown.appendMarkdown('\n\n---\n\n**Selected Sequence**\n\n');
		markdown.appendCodeblock(sequenceMatch.characters, 'text');
	}

	markdown.isTrusted = false;
	markdown.supportHtml = false;

	return markdown;
}

function getSelectedSequenceMatch(
	document: vscode.TextDocument,
	position: vscode.Position,
): UnicodeSequenceMatch | undefined {
	const activeEditor = vscode.window.activeTextEditor;

	if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
		return undefined;
	}

	const selection = activeEditor.selections.find((candidate) =>
		!candidate.isEmpty && candidate.contains(position),
	);

	if (!selection) {
		return undefined;
	}

	return decodeUnicodeEscapeSequence(document.getText(selection));
}

export function createUnicodeHoverProvider(): vscode.HoverProvider {
	return {
		provideHover(document, position) {
			const line = document.lineAt(position.line);
			const match = resolveUnicodeEscapeAt(line.text, position.character);

			if (!match) {
				return undefined;
			}

			const range = new vscode.Range(
				new vscode.Position(position.line, match.start),
				new vscode.Position(position.line, match.end),
			);

			return new vscode.Hover(buildHoverMarkdown(match, getSelectedSequenceMatch(document, position)), range);
		},
	};
}
