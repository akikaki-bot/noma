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

	const features =
		'use "std/arr" as arr;\nasync fn calculate()->int32{return 42;}\npub async fn main()->int32{\n let mut values:Array<int32>=[1,2];\n let pending:Future<int32>=calculate();\n let count:int32=arr.length<int32>(read values);\n let answer:int32=await pending;\n return answer-count;\n}\n';
	async function replace(text: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length),
			),
			text,
		);
		assert.ok(await vscode.workspace.applyEdit(edit));
	}
	async function featureReady(): Promise<vscode.Hover[]> {
		return until(async () => {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				"vscode.executeHoverProvider",
				document.uri,
				document.positionAt(
					document.getText().indexOf("pending:Future"),
				),
			);
			return hovers?.length &&
				vscode.languages.getDiagnostics(document.uri).length === 0
				? hovers
				: undefined;
		}, "async/Future feature analysis");
	}
	await replace(features);
	const featureHovers = await featureReady();
	assert.match(
		featureHovers
			.flatMap((hover) =>
				hover.contents.map((content) =>
					typeof content === "string" ? content : content.value,
				),
			)
			.join("\n")
			.replace(/\\([<>])/g, "$1"),
		/Future<int32>/,
	);
	const readPosition = document.positionAt(
		features.indexOf("read values") + 2,
	);
	const readCompletion =
		await vscode.commands.executeCommand<vscode.CompletionList>(
			"vscode.executeCompletionItemProvider",
			document.uri,
			readPosition,
		);
	assert.ok(readCompletion?.items.some((i) => i.label === "read"));
	const signature =
		await vscode.commands.executeCommand<vscode.SignatureHelp>(
			"vscode.executeSignatureHelpProvider",
			document.uri,
			document.positionAt(features.lastIndexOf("calculate()") + 10),
		);
	assert.equal(
		signature?.signatures[0]?.label,
		"calculate() -> Future<int32>",
	);
	console.log(
		"PASS: real editor read completion, Future hover and async call signature",
	);
	await replace(
		features.replace(
			" return answer-count;",
			" let second:int32=await pending;\n return answer-count;",
		),
	);
	await until(
		async () =>
			vscode.languages
				.getDiagnostics(document.uri)
				.find((d) => /consumed or moved/.test(d.message)),
		"double await diagnostic",
	);
	await replace(features);
	await featureReady();
	await replace(
		features.replace("arr.length<int32>(read values)", "values.length"),
	);
	await until(
		async () =>
			vscode.languages
				.getDiagnostics(document.uri)
				.find((d) => /no properties/.test(d.message)),
		"removed array length diagnostic",
	);
	await replace(features);
	await featureReady();
	console.log(
		"PASS: Future consumption and removed array length diagnostics recover after edits",
	);
	await document.save();
	const snippetBytes = await vscode.workspace.fs.readFile(
		vscode.Uri.joinPath(extension.extensionUri, "snippets/noma.json"),
	);
	const snippets = JSON.parse(
		Buffer.from(snippetBytes).toString("utf8"),
	) as Record<string, { prefix: string; body: string | string[] }>;
	const snippet = Object.values(snippets).find(
		(s) => s.prefix === "asyncmain",
	)!;
	const scratch = await vscode.workspace.openTextDocument({
		language: "noma",
		content: "",
	});
	const editor = await vscode.window.showTextDocument(scratch);
	assert.ok(
		await editor.insertSnippet(
			new vscode.SnippetString(
				Array.isArray(snippet.body)
					? snippet.body.join("\n")
					: snippet.body,
			),
		),
	);
	assert.match(scratch.getText(), /pub async fn main\(\) -> int32/);
	await until(async () => {
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
			"vscode.executeHoverProvider",
			scratch.uri,
			scratch.positionAt(scratch.getText().indexOf("main")),
		);
		return hover?.length &&
			vscode.languages.getDiagnostics(scratch.uri).length === 0
			? true
			: undefined;
	}, "expanded async main snippet");
	console.log(
		"PASS: async main snippet expands and type-checks in a real untitled editor",
	);
	await vscode.commands.executeCommand(
		"workbench.action.revertAndCloseActiveEditor",
	);
	await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
