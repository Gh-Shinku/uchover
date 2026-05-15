import * as assert from 'assert';
import * as vscode from 'vscode';

import { buildHoverMarkdown, decodeUnicodeEscapeSequence, resolveUnicodeEscapeAt } from '../unicodeHover';

async function activateExtension(): Promise<void> {
	const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'uchover');

	assert.ok(extension, 'Extension should be available in the test host.');
	await extension.activate();
}

async function openDocument(content: string): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument({
		content,
		language: 'plaintext',
	});

	return vscode.window.showTextDocument(document);
}

async function getHoverContents(
	content: string,
	offset: number,
	selection?: { start: number; end: number },
): Promise<string[]> {
	const editor = await openDocument(content);

	if (selection) {
		editor.selection = new vscode.Selection(
			editor.document.positionAt(selection.start),
			editor.document.positionAt(selection.end),
		);
	}

	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		'vscode.executeHoverProvider',
		editor.document.uri,
		editor.document.positionAt(offset),
	);

	return (hovers ?? []).flatMap((hover) =>
		hover.contents.map((contentItem) =>
			typeof contentItem === 'string'
				? contentItem
				: contentItem instanceof vscode.MarkdownString
					? contentItem.value
					: contentItem.value,
		),
	);
}

suite('Extension Test Suite', () => {
	suiteSetup(async () => {
		await activateExtension();
	});

	test('resolves a BMP escape', () => {
		const match = resolveUnicodeEscapeAt('prefix \\u0041 suffix', 10);

		assert.ok(match);
		assert.strictEqual(match.character, 'A');
		assert.strictEqual(match.codePoint, 0x41);
		assert.strictEqual(match.name, 'LATIN CAPITAL LETTER A');
	});

	test('resolves an adjacent surrogate pair', () => {
		const match = resolveUnicodeEscapeAt('value=\\uD83D\\uDE00', 15);

		assert.ok(match);
		assert.strictEqual(match.character, '😀');
		assert.strictEqual(match.codePoint, 0x1f600);
		assert.strictEqual(match.sourceText, '\\uD83D\\uDE00');
	});

	test('returns no match for an isolated surrogate', () => {
		const match = resolveUnicodeEscapeAt('value=\\uD83D', 8);

		assert.strictEqual(match, undefined);
	});

	test('builds hover markdown with metadata', () => {
		const match = resolveUnicodeEscapeAt('\\u{1F600}', 3);

		assert.ok(match);

		const markdown = buildHoverMarkdown(match);

		assert.ok(markdown.value.includes('U+1F600'));
		assert.ok(markdown.value.includes('GRINNING FACE'));
		assert.ok(markdown.value.includes('\\u\\{1F600\\}'));
	});

	test('decodes a selected sequence of escapes to characters only', () => {
		const sequence = decodeUnicodeEscapeSequence('prefix \\u0041 and \\u{1F600} done');

		assert.deepStrictEqual(sequence, {
			characters: 'A😀',
			matchCount: 2,
		});
	});

	test('provides a hover for a braced code point escape', async () => {
		const content = 'emoji = \\u{1F600};';
		const hoverContents = await getHoverContents(content, content.indexOf('1F600'));

		assert.ok(hoverContents.length > 0);
		assert.ok(hoverContents.some((value) => value.includes('GRINNING FACE')));
		assert.ok(hoverContents.some((value) => value.includes('U+1F600')));
	});

	test('provides a hover for an 8-hex escape', async () => {
		const content = 'emoji = \\U0001F600;';
		const hoverContents = await getHoverContents(content, content.indexOf('0001F600'));

		assert.ok(hoverContents.length > 0);
		assert.ok(hoverContents.some((value) => value.includes('GRINNING FACE')));
	});

	test('adds a selected sequence block when hovering inside the selection', async () => {
		const content = 'value = \\u0041 \\u{1F600}';
		const hoverContents = await getHoverContents(
			content,
			content.indexOf('1F600'),
			{ start: content.indexOf('\\u0041'), end: content.length },
		);

		assert.ok(hoverContents.some((value) => value.includes('Selected Sequence')));
		assert.ok(hoverContents.some((value) => value.includes('A😀')));
	});

	test('does not add a selected sequence block when hovering outside the selection', async () => {
		const content = 'value = \\u0041 \\u{1F600}';
		const hoverContents = await getHoverContents(
			content,
			content.indexOf('0041'),
			{ start: content.indexOf('\\u{1F600}'), end: content.length },
		);

		assert.ok(hoverContents.length > 0);
		assert.ok(!hoverContents.some((value) => value.includes('Selected Sequence')));
	});

	test('ignores non-escape text when building the selected sequence block', async () => {
		const content = 'value = \\u0041 text \\u0042';
		const hoverContents = await getHoverContents(
			content,
			content.indexOf('0042'),
			{ start: content.indexOf('\\u0041'), end: content.length },
		);

		assert.ok(hoverContents.some((value) => value.includes('AB')));
	});

	test('does not provide a hover outside the escape token', async () => {
		const content = 'value = \\u0041';
		const hoverContents = await getHoverContents(content, 1);

		assert.strictEqual(hoverContents.length, 0);
	});

	test('does not provide a hover for an out-of-range scalar escape', async () => {
		const content = 'value = \\u{110000}';
		const hoverContents = await getHoverContents(content, content.indexOf('110000'));

		assert.strictEqual(hoverContents.length, 0);
	});
});
