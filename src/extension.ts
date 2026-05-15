import * as vscode from 'vscode';
import { createUnicodeHoverProvider } from './unicodeHover';

export function activate(context: vscode.ExtensionContext) {
	const selector: vscode.DocumentSelector = [{ language: '*', scheme: '*' }];

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(selector, createUnicodeHoverProvider()),
	);
}

export function deactivate() {}
