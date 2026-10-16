import { pathToFileURL } from "node:url";
import { LanguageError } from "./ast.js";
import type { Expression } from "./ast.js";
import { checkProgram } from "./checker.js";
import type { CheckedProgram, CheckOptions } from "./checker.js";
import { loadProgram } from "./modules.js";
import type { LoadProgramOptions, Program } from "./modules.js";
import type { SemanticSymbol, SymbolKind } from "./semantic.js";
import { SourceText } from "./source.js";
import type { Position, Range, SourceRange } from "./source.js";
import { describe } from "./types.js";

export interface Diagnostic {
	uri: string;
	range: Range;
	message: string;
	severity: 1;
	source: "noma";
	code: "syntax" | "resolve" | "type" | "io";
}
export interface AnalysisOptions extends LoadProgramOptions, CheckOptions {}
export interface AnalysisResult {
	status: "success" | "error";
	diagnostics: readonly Diagnostic[];
	sources: ReadonlyMap<string, SourceText>;
	program?: Program;
	/** Available only after the entire snapshot passes checking. */
	checked?: CheckedProgram;
}
/** Compiler-only entry point. Never constructs an Interpreter or Native Registry. */
export async function analyzeFile(
	file: string,
	options: AnalysisOptions = {},
): Promise<AnalysisResult> {
	const sources = new Map<string, SourceText>();
	let program: Program | undefined,
		checking = false;
	try {
		program = await loadProgram(file, {
			...options,
			onSource(source) {
				sources.set(source.file, source);
				options.onSource?.(source);
			},
		});
		checking = true;
		const checked = checkProgram(program, {
			requireEntryPoint: options.requireEntryPoint ?? false,
		});
		return {
			status: "success",
			diagnostics: [],
			sources,
			program,
			checked,
		};
	} catch (error) {
		let diagnostic: Diagnostic;
		if (error instanceof LanguageError) {
			const source = sources.get(error.span.file);
			const start =
				source?.offsetAt({
					line: error.span.line - 1,
					character: error.span.column - 1,
				}) ?? 0;
			const range = error.range ?? {
				file: error.span.file,
				start,
				end: start,
			};
			diagnostic = {
				uri: pathToFileURL(error.span.file).href,
				range: source
					? source.range(range)
					: {
							start: {
								line: error.span.line - 1,
								character: error.span.column - 1,
							},
							end: {
								line: error.span.line - 1,
								character: error.span.column - 1,
							},
						},
				message: error.detail,
				severity: 1,
				source: "noma",
				code:
					error.phase === "syntax"
						? "syntax"
						: checking
							? "type"
							: "resolve",
			};
		} else if (
			error instanceof Error &&
			"code" in error &&
			["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(
				String(error.code),
			)
		) {
			const target =
				"path" in error && typeof error.path === "string"
					? error.path
					: file;
			diagnostic = {
				uri: pathToFileURL(target).href,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
				message: error.message,
				severity: 1,
				source: "noma",
				code: "io",
			};
		} else throw error; // Do not turn compiler bugs into source diagnostics.
		return {
			status: "error",
			diagnostics: [diagnostic],
			sources,
			...(program ? { program } : {}),
		};
	}
}
export interface Location {
	uri: string;
	range: Range;
}
export interface Hover {
	contents: string;
	range: Range;
}
export interface Completion {
	label: string;
	detail: string;
	kind: SymbolKind;
	mutable: boolean;
	definition: Location;
}

/** One immutable document/version snapshot; callers must discard it after changes. */
export class AnalysisSnapshot {
	readonly diagnostics: readonly Diagnostic[];
	constructor(
		readonly uri: string,
		readonly version: number,
		readonly result: AnalysisResult,
		private readonly uris: ReadonlyMap<string, string> = new Map(),
	) {
		this.diagnostics = result.diagnostics.map((diagnostic) => ({
			...diagnostic,
			uri: this.remap(diagnostic.uri),
		}));
	}
	private remap(uri: string): string {
		for (const [file, original] of this.uris)
			if (pathToFileURL(file).href === uri) return original;
		return uri;
	}
	private source(uri: string): SourceText | undefined {
		return [...this.result.sources.values()].find(
			(source) =>
				(this.uris.get(source.file) ??
					pathToFileURL(source.file).href) === uri,
		);
	}
	private location(range: SourceRange): Location {
		return {
			uri: this.uris.get(range.file) ?? pathToFileURL(range.file).href,
			range: this.result.sources.get(range.file)!.range(range),
		};
	}
	hover(uri: string, position: Position): Hover | undefined {
		const checked = this.result.checked,
			source = this.source(uri);
		if (!checked || !source) return undefined;
		const offset = source.offsetAt(position),
			occurrence = checked.semantic.occurrenceAt(source.file, offset);
		if (occurrence) {
			const symbol = occurrence.definitionId
				? checked.semantic.symbols.get(occurrence.definitionId)
				: undefined;
			const contents =
				occurrence.type &&
				symbol &&
				["variable", "parameter", "case", "handler"].includes(
					symbol.kind,
				)
					? `${occurrence.mutable ? "mut " : ""}${symbol.name}: ${describe(occurrence.type)}`
					: (symbol?.detail ?? occurrence.detail);
			return { contents, range: this.location(occurrence.range).range };
		}
		let best: { range: SourceRange; contents: string } | undefined;
		const visit = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			if ("kind" in value && "range" in value) {
				const node = value as Expression,
					range = node.range,
					type = checked.expressionTypes.get(node);
				if (
					range &&
					type &&
					range.start <= offset &&
					offset < range.end &&
					(!best ||
						range.end - range.start <
							best.range.end - best.range.start)
				)
					best = { range, contents: describe(type) };
			}
			for (const [key, child] of Object.entries(value))
				if (
					!["span", "range", "nameRange", "qualifierRange"].includes(
						key,
					)
				)
					visit(child);
		};
		visit(
			checked.program.modules.find(
				(module) => module.file === source.file,
			)?.ast,
		);
		return best
			? {
					contents: best.contents,
					range: this.location(best.range).range,
				}
			: undefined;
	}
	definition(uri: string, position: Position): Location | undefined {
		const source = this.source(uri);
		if (!source) return undefined;
		const symbol = this.result.checked?.semantic.definitionAt(
			source.file,
			source.offsetAt(position),
		);
		return symbol ? this.location(symbol.range) : undefined;
	}
	references(
		uri: string,
		position: Position,
		includeDeclaration = false,
	): Location[] {
		const source = this.source(uri);
		if (!source) return [];
		return (
			this.result.checked?.semantic
				.referencesAt(
					source.file,
					source.offsetAt(position),
					includeDeclaration,
				)
				.map((item) => this.location(item.range)) ?? []
		);
	}
	completions(
		uri: string,
		position: Position,
		moduleAlias?: string,
	): Completion[] {
		const source = this.source(uri),
			index = this.result.checked?.semantic;
		if (!source || !index) return [];
		const offset = source.offsetAt(position),
			symbols =
				moduleAlias === undefined
					? index.visibleSymbols(source.file, offset)
					: index.moduleMembers(source.file, offset, moduleAlias);
		return symbols.map((symbol: SemanticSymbol) => ({
			label: symbol.name,
			detail: symbol.detail,
			kind: symbol.kind,
			mutable: symbol.mutable,
			definition: this.location(symbol.range),
		}));
	}
}
