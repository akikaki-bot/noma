import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFile, AnalysisSnapshot } from "./analysis.js";
import type { AnalysisOptions } from "./analysis.js";
import { canonicalPath } from "./modules.js";

export interface EditorDocument {
	uri: string;
	version: number;
	text: string;
	/** Intended disk location for non-file URIs, e.g. untitled documents. */
	filePath?: string;
}
export interface WorkspaceChange {
	/** Conservative invalidation: analyze these open roots again. */
	reanalyzeUris: string[];
	/** Publish [] for these URIs to clear obsolete diagnostics. */
	clearDiagnosticsUris: string[];
}
export type WorkspaceOptions = Omit<AnalysisOptions, "sources" | "onSource">;
/** Transport-independent lifecycle for LSP open/change/close and disk events. */
export class AnalysisWorkspace {
	private readonly documents = new Map<string, EditorDocument>();
	private readonly results = new Map<string, AnalysisSnapshot>();
	private readonly requests = new Map<string, number>();
	private generation = 0;
	constructor(readonly options: WorkspaceOptions = {}) {}
	updateDocument(document: EditorDocument): WorkspaceChange {
		const uri = new URL(document.uri).href;
		if (!Number.isInteger(document.version))
			throw new Error("Document version must be an integer");
		const previous = this.documents.get(uri);
		if (previous && document.version <= previous.version)
			throw new Error("Document versions must increase");
		this.fileFor({ ...document, uri }); // Validate before changing workspace state.
		this.documents.set(uri, Object.freeze({ ...document, uri }));
		return this.invalidate();
	}
	closeDocument(uri: string): WorkspaceChange {
		uri = new URL(uri).href;
		this.documents.delete(uri);
		const change = this.invalidate();
		if (!change.clearDiagnosticsUris.includes(uri))
			change.clearDiagnosticsUris.push(uri);
		return change;
	}
	/** Call for file create/change/delete/rename; includes dependency changes. */
	invalidate(): WorkspaceChange {
		this.generation++;
		const clearDiagnosticsUris = [
			...new Set(
				[...this.results.values()].flatMap((snapshot) => [
					snapshot.uri,
					...snapshot.diagnostics.map((diagnostic) => diagnostic.uri),
				]),
			),
		];
		this.results.clear();
		return {
			reanalyzeUris: [...this.documents.keys()],
			clearDiagnosticsUris,
		};
	}
	getSnapshot(uri: string): AnalysisSnapshot | undefined {
		return this.results.get(new URL(uri).href);
	}
	private fileFor(document: EditorDocument): string {
		const url = new URL(document.uri);
		if (url.protocol === "file:") {
			if (document.filePath !== undefined)
				throw new Error("filePath is only for non-file document URIs");
			return fileURLToPath(url);
		}
		if (url.protocol !== "untitled:")
			throw new Error(`Unsupported document URI scheme: ${url.protocol}`);
		if (document.filePath) return path.resolve(document.filePath);
		const id = createHash("sha256")
			.update(document.uri)
			.digest("hex")
			.slice(0, 24);
		return path.resolve(
			this.options.projectRoot ?? process.cwd(),
			`__noma_untitled_${id}.noma`,
		);
	}
	async analyze(uri: string): Promise<AnalysisSnapshot | undefined> {
		uri = new URL(uri).href;
		const document = this.documents.get(uri);
		if (!document) return undefined;
		const generation = this.generation,
			request = (this.requests.get(uri) ?? 0) + 1;
		this.requests.set(uri, request);
		const documents = [...this.documents.values()],
			sources = new Map<string, string>(),
			uris = new Map<string, string>();
		for (const document of documents) {
			const file = await canonicalPath(
				this.fileFor(document),
				this.options.fileSystem,
				true,
			);
			if (sources.has(file))
				throw new Error(
					"Multiple document URIs refer to the same source file",
				);
			sources.set(file, document.text);
			uris.set(file, document.uri);
		}
		const result = await analyzeFile(this.fileFor(document), {
			...this.options,
			sources,
		});
		if (
			this.generation !== generation ||
			this.requests.get(uri) !== request ||
			!this.documents.has(uri)
		)
			return undefined;
		const snapshot = new AnalysisSnapshot(
			uri,
			document.version,
			result,
			uris,
		);
		this.results.set(uri, snapshot);
		return snapshot;
	}
}
