import { fileURLToPath } from "node:url";
import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	PositionEncodingKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { NomaLanguageService } from "./service.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const service = new NomaLanguageService(
	fileURLToPath(new URL("./stdlib/", import.meta.url)),
	(params) => {
		void connection.sendDiagnostics(params);
	},
	(message) => connection.console.error(message),
);
let folders: { uri: string; name: string }[] = [];
let supportsFolders = false;

connection.onInitialize((params) => {
	supportsFolders = params.capabilities.workspace?.workspaceFolders === true;
	folders =
		params.workspaceFolders ??
		(params.rootUri ? [{ uri: params.rootUri, name: "workspace" }] : []);
	service.setFolders(folders.map((folder) => folder.uri));
	return {
		serverInfo: { name: "Noma Language Server", version: "0.3.0" },
		capabilities: {
			positionEncoding: PositionEncodingKind.UTF16,
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Incremental,
				save: { includeText: false },
			},
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: [".", "<"],
			},
			signatureHelpProvider: {
				triggerCharacters: ["(", ","],
				retriggerCharacters: [","],
			},
			...(params.capabilities.workspace?.workspaceFolders
				? {
						workspace: {
							workspaceFolders: {
								supported: true,
								changeNotifications: true,
							},
						},
					}
				: {}),
		},
	};
});
connection.onInitialized(() => {
	if (!supportsFolders) return;
	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		const removed = new Set(event.removed.map((folder) => folder.uri));
		folders = [
			...folders.filter((folder) => !removed.has(folder.uri)),
			...event.added,
		];
		service.setFolders(folders.map((folder) => folder.uri));
	});
});
documents.onDidChangeContent(({ document }) => service.update(document));
documents.onDidClose(({ document }) => service.close(document.uri));
documents.onDidSave(() => service.invalidate());
connection.onDidChangeWatchedFiles(() => service.invalidate());
connection.onHover(async (params, token) => {
	const result = await service.hover(
		params.textDocument.uri,
		params.position,
	);
	return token.isCancellationRequested ? null : result;
});
connection.onDefinition(async (params, token) => {
	const result = await service.definition(
		params.textDocument.uri,
		params.position,
	);
	return token.isCancellationRequested ? null : result;
});
connection.onCompletion(async (params, token) => {
	const result = await service.completions(
		params.textDocument.uri,
		params.position,
	);
	return token.isCancellationRequested ? [] : result;
});
connection.onReferences(async (params, token) => {
	const result = await service.references(
		params.textDocument.uri,
		params.position,
		params.context.includeDeclaration,
	);
	return token.isCancellationRequested ? [] : result;
});
connection.onSignatureHelp(async (params, token) => {
	const result = await service.signatureHelp(
		params.textDocument.uri,
		params.position,
	);
	return token.isCancellationRequested ? null : result;
});
connection.onShutdown(() => service.dispose());
documents.listen(connection);
connection.listen();
