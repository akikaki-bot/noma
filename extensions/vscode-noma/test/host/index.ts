import assert from "node:assert/strict";
import * as vscode from "vscode";

async function until<T>(
	operation: () => PromiseLike<T | undefined>,
	description: string,
): Promise<T> {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const value = await operation();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${description}`);
}

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension(
		"noma-local.noma-language",
	);
	assert.ok(extension);
	await extension.activate();
	const folder = vscode.workspace.workspaceFolders![0]!.uri;
	const document = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(folder, "main.noma"),
	);
	assert.equal(document.languageId, "noma");
	await vscode.window.showTextDocument(document);
	const usage = document.positionAt(document.getText().indexOf("answer"));
	const definitions = await until(async () => {
		const values = await vscode.commands.executeCommand<vscode.Location[]>(
			"vscode.executeDefinitionProvider",
			document.uri,
			usage,
		);
		return values?.length ? values : undefined;
	}, "definition provider");
	assert.equal(
		definitions[0]!.uri.fsPath,
		vscode.Uri.joinPath(folder, "helper.noma").fsPath,
	);
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
		"vscode.executeHoverProvider",
		document.uri,
		usage,
	);
	assert.ok(hovers?.length);
	const completions =
		await vscode.commands.executeCommand<vscode.CompletionList>(
			"vscode.executeCompletionItemProvider",
			document.uri,
			usage.translate(0, 2),
		);
	assert.ok(completions?.items.some((item) => item.label === "answer"));
	const references = await vscode.commands.executeCommand<vscode.Location[]>(
		"vscode.executeReferenceProvider",
		document.uri,
		usage,
	);
	assert.ok(
		references?.some(
			(item) => item.uri.toString() === document.uri.toString(),
		),
	);
	console.log(
		"PASS: .noma activation, Ctrl+click definition, hover, completion and references",
	);

	const invalid = document
		.getText()
		.replace("value: int32 = 2", 'value: int32 = "bad"');
	let edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(
			document.positionAt(0),
			document.positionAt(document.getText().length),
		),
		invalid,
	);
	assert.ok(await vscode.workspace.applyEdit(edit));
	const diagnostic = await until(
		async () =>
			vscode.languages
				.getDiagnostics(document.uri)
				.find((item) => item.source === "noma"),
		"unsaved type diagnostic",
	);
	assert.match(diagnostic.message, /Expected int32, got string/);
	const failedDefinition = await vscode.commands.executeCommand<
		vscode.Location[]
	>(
		"vscode.executeDefinitionProvider",
		document.uri,
		document.positionAt(invalid.indexOf("answer")),
	);
	assert.equal(failedDefinition?.length ?? 0, 0);
	edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(
			document.positionAt(0),
			document.positionAt(invalid.length),
		),
		invalid.replace('"bad"', "2"),
	);
	assert.ok(await vscode.workspace.applyEdit(edit));
	await until(async () => {
		const values = await vscode.commands.executeCommand<vscode.Location[]>(
			"vscode.executeDefinitionProvider",
			document.uri,
			document.positionAt(document.getText().indexOf("answer")),
		);
		return values?.length &&
			vscode.languages.getDiagnostics(document.uri).length === 0
			? true
			: undefined;
	}, "diagnostic cleared after fix");
	await document.save();
	console.log(
		"PASS: unsaved edits, type diagnostics, stale-result clearing and recovery",
	);
	await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
