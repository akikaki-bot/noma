import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisWorkspace } from "../../../../src/workspace.js";
import type { AnalysisSnapshot } from "../../../../src/analysis.js";
import type { WorkspaceChange } from "../../../../src/workspace.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CompletionItemKind, MarkupKind } from "vscode-languageserver/node";
import type {
	CompletionItem,
	Hover,
	Location,
	Position,
	PublishDiagnosticsParams,
} from "vscode-languageserver/node";

interface Group {
	workspace: AnalysisWorkspace;
	documents: Set<string>;
	snapshots: Map<string, AnalysisSnapshot>;
	timer?: NodeJS.Timeout;
	pending?: Promise<void>;
}

const inside = (root: string, file: string): boolean => {
	const relative = path.relative(root, file);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
};
const locationKey = (location: Location): string => JSON.stringify(location);

/** Only coordinates the compiler's public analysis API; no language rules live here. */
export class NomaLanguageService {
	private roots: string[] = [];
	private readonly groups = new Map<string, Group>();
	private readonly documents = new Map<string, TextDocument>();
	private readonly owners = new Map<string, Group>();
	private published = new Set<string>();
	private revision = 0;
	private disposed = false;

	constructor(
		private readonly stdlibRoot: string,
		private readonly publish: (params: PublishDiagnosticsParams) => void,
		private readonly log: (message: string) => void,
		private readonly debounceMs = 100,
	) {}

	setFolders(uris: readonly string[]): void {
		this.roots = uris
			.filter((uri) => new URL(uri).protocol === "file:")
			.map((uri) => fileURLToPath(uri))
			.sort((a, b) => a.length - b.length);
		for (const group of this.groups.values()) {
			clearTimeout(group.timer);
			group.workspace.invalidate();
		}
		this.revision++;
		this.groups.clear();
		this.owners.clear();
		for (const document of this.documents.values()) this.attach(document);
		this.publishDiagnostics();
	}

	private attach(document: TextDocument): void {
		const file =
			new URL(document.uri).protocol === "file:"
				? fileURLToPath(document.uri)
				: undefined;
		const root = file
			? (this.roots.find((root) => inside(root, file)) ??
				path.dirname(file))
			: (this.roots[0] ?? process.cwd());
		let group = this.groups.get(root);
		if (!group) {
			group = {
				workspace: new AnalysisWorkspace({
					projectRoot: root,
					stdlibRoot: this.stdlibRoot,
				}),
				documents: new Set(),
				snapshots: new Map(),
			};
			this.groups.set(root, group);
		}
		group.documents.add(document.uri);
		this.owners.set(document.uri, group);
		this.apply(
			group,
			group.workspace.updateDocument({
				uri: document.uri,
				version: document.version,
				text: document.getText(),
			}),
		);
	}

	update(document: TextDocument): void {
		if (
			this.disposed ||
			!["file:", "untitled:"].includes(new URL(document.uri).protocol)
		)
			return;
		const previous = this.documents.get(document.uri);
		if (previous && previous.version >= document.version) return;
		// TextDocuments mutates its TextDocument on edits; retain our own versioned copy.
		document = TextDocument.create(
			document.uri,
			document.languageId,
			document.version,
			document.getText(),
		);
		this.documents.set(document.uri, document);
		this.revision++;
		const group = this.owners.get(document.uri);
		if (group)
			this.apply(
				group,
				group.workspace.updateDocument({
					uri: document.uri,
					version: document.version,
					text: document.getText(),
				}),
			);
		else this.attach(document);
	}

	close(uri: string): void {
		this.documents.delete(uri);
		this.revision++;
		const group = this.owners.get(uri);
		this.owners.delete(uri);
		if (!group) return;
		group.documents.delete(uri);
		this.apply(group, group.workspace.closeDocument(uri));
	}

	invalidate(): void {
		this.revision++;
		for (const group of this.groups.values())
			this.apply(group, group.workspace.invalidate());
	}

	private apply(group: Group, change: WorkspaceChange): void {
		clearTimeout(group.timer);
		delete group.timer;
		delete group.pending;
		group.snapshots.clear();
		// Merge at the server level so one root cannot clear another root's diagnostics.
		for (const uri of change.clearDiagnosticsUris) this.published.add(uri);
		this.publishDiagnostics();
		if (change.reanalyzeUris.length)
			group.timer = setTimeout(() => {
				void this.flush(group);
			}, this.debounceMs);
	}

	private async flush(group: Group): Promise<void> {
		clearTimeout(group.timer);
		delete group.timer;
		if (group.pending) return group.pending;
		const job = (async () => {
			await Promise.all(
				[...group.documents].map(async (uri) => {
					try {
						const snapshot = await group.workspace.analyze(uri);
						if (
							!this.disposed &&
							snapshot &&
							this.owners.get(uri) === group &&
							group.workspace.getSnapshot(uri) === snapshot
						)
							group.snapshots.set(uri, snapshot);
					} catch (error) {
						this.log(
							`Analysis failed for ${uri}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
						);
					}
				}),
			);
			if (!this.disposed) this.publishDiagnostics();
		})();
		group.pending = job;
		try {
			await job;
		} finally {
			if (group.pending === job) delete group.pending;
		}
	}

	private publishDiagnostics(): void {
		if (this.disposed) return;
		const merged = new Map<
			string,
			Map<string, PublishDiagnosticsParams["diagnostics"][number]>
		>();
		for (const group of this.groups.values())
			for (const snapshot of group.snapshots.values()) {
				if (group.workspace.getSnapshot(snapshot.uri) !== snapshot)
					continue;
				for (const { uri, ...diagnostic } of snapshot.diagnostics) {
					let values = merged.get(uri);
					if (!values) {
						values = new Map();
						merged.set(uri, values);
					}
					values.set(JSON.stringify(diagnostic), diagnostic);
				}
			}
		const targets = new Set([
			...this.published,
			...this.documents.keys(),
			...merged.keys(),
		]);
		for (const uri of targets) {
			const document = this.documents.get(uri);
			this.publish({
				uri,
				diagnostics: [...(merged.get(uri)?.values() ?? [])],
				...(document ? { version: document.version } : {}),
			});
		}
		this.published = new Set([...this.documents.keys(), ...merged.keys()]);
	}

	private async snapshot(uri: string): Promise<AnalysisSnapshot | undefined> {
		const group = this.owners.get(uri),
			document = this.documents.get(uri),
			revision = this.revision;
		if (!group || !document) return undefined;
		if (!group.workspace.getSnapshot(uri)) await this.flush(group);
		if (
			this.revision !== revision ||
			this.documents.get(uri)?.version !== document.version
		)
			return undefined;
		return group.workspace.getSnapshot(uri);
	}

	async hover(uri: string, position: Position): Promise<Hover | null> {
		const value = (await this.snapshot(uri))?.hover(uri, position);
		return value
			? {
					contents: {
						kind: MarkupKind.PlainText,
						value: value.contents,
					},
					range: value.range,
				}
			: null;
	}

	async definition(
		uri: string,
		position: Position,
	): Promise<Location | null> {
		return (await this.snapshot(uri))?.definition(uri, position) ?? null;
	}

	async completions(
		uri: string,
		position: Position,
	): Promise<CompletionItem[]> {
		const snapshot = await this.snapshot(uri),
			document = this.documents.get(uri);
		if (!snapshot || !document) return [];
		const prefix = document.getText().slice(0, document.offsetAt(position));
		const alias = /\b([A-Za-z_][A-Za-z_0-9]*)\s*\.\s*[A-Za-z_0-9]*$/.exec(
			prefix,
		)?.[1];
		return snapshot.completions(uri, position, alias).map((item) => ({
			label: item.label,
			detail: item.detail,
			kind:
				item.kind === "function"
					? CompletionItemKind.Function
					: item.kind === "type"
						? CompletionItemKind.Class
						: item.kind === "module"
							? CompletionItemKind.Module
							: CompletionItemKind.Variable,
		}));
	}

	async references(
		uri: string,
		position: Position,
		includeDeclaration: boolean,
	): Promise<Location[]> {
		const revision = this.revision;
		const snapshot = await this.snapshot(uri);
		if (!snapshot) return [];
		const target = snapshot.definition(uri, position);
		if (!target) return [];
		await Promise.all(
			[...this.groups.values()]
				.filter(
					(group) =>
						group.timer ||
						group.pending ||
						[...group.documents].some(
							(uri) => !group.workspace.getSnapshot(uri),
						),
				)
				.map((group) => this.flush(group)),
		);
		if (revision !== this.revision) return [];
		const result = new Map<string, Location>();
		for (const group of this.groups.values())
			for (const current of group.snapshots.values()) {
				if (group.workspace.getSnapshot(current.uri) !== current)
					continue;
				for (const location of current.references(
					target.uri,
					target.range.start,
					includeDeclaration,
				))
					result.set(locationKey(location), location);
			}
		return [...result.values()];
	}

	dispose(): void {
		this.disposed = true;
		for (const group of this.groups.values()) {
			clearTimeout(group.timer);
			group.workspace.invalidate();
		}
	}
}
