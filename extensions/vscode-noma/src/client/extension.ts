import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	const watcher = vscode.workspace.createFileSystemWatcher("**/*.noma");
	const output = vscode.window.createOutputChannel("Noma Language Server", {
		log: true,
	});
	context.subscriptions.push(watcher, output);
	const server = {
		module: context.asAbsolutePath("dist/server.cjs"),
		transport: TransportKind.ipc,
	};
	client = new LanguageClient(
		"noma",
		"Noma Language Server",
		{
			run: server,
			debug: server,
		},
		{
			documentSelector: [
				{ scheme: "file", language: "noma" },
				{ scheme: "untitled", language: "noma" },
			],
			synchronize: { fileEvents: watcher },
			outputChannel: output,
		},
	);
	await client.start();
}

export async function deactivate(): Promise<void> {
	await client?.stop();
	client = undefined;
}
