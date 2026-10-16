import type { Node } from "./ast.js";
import type { Program, SourceModule } from "./modules.js";
import type { SourceRange } from "./source.js";
import { containsTSAny, describe } from "./types.js";
import type { Type } from "./types.js";

export type SymbolKind =
	| "function"
	| "type"
	| "module"
	| "variable"
	| "parameter"
	| "case"
	| "handler";
export interface SemanticSymbol {
	id: string;
	name: string;
	kind: SymbolKind;
	range: SourceRange;
	scope: SourceRange;
	visibleFrom: number;
	mutable: boolean;
	public: boolean;
	hidden: boolean;
	detail: string;
	type?: Type;
	targetModule?: SourceModule;
}
export interface Occurrence {
	range: SourceRange;
	definitionId: string | null;
	detail: string;
	type?: Type;
	declaration: boolean;
	mutable?: boolean;
}
interface SymbolOptions {
	mutable?: boolean;
	public?: boolean;
	hidden?: boolean;
	visibleFrom?: number;
	type?: Type;
	detail?: string;
	targetModule?: SourceModule;
}
/** Index only identities resolved by Checker; never search by identifier spelling. */
export class SemanticIndex {
	readonly symbols = new Map<string, SemanticSymbol>();
	private readonly definitions = new WeakMap<Node, SemanticSymbol>();
	private readonly occurrences = new Map<string, Occurrence>();
	private readonly views: {
		symbol: SemanticSymbol;
		type: Type;
		scope: SourceRange;
	}[] = [];
	constructor(readonly program: Program) {}
	define(
		node: Node,
		name: string,
		kind: SymbolKind,
		scope: SourceRange | undefined,
		options: SymbolOptions = {},
	): SemanticSymbol | undefined {
		const previous = this.definitions.get(node);
		if (previous) return previous;
		const range = node.nameRange;
		if (!range || !scope) return undefined;
		const symbol: SemanticSymbol = {
			id: `${range.file}:${range.start}:${kind}`,
			name,
			kind,
			range,
			scope,
			visibleFrom: options.visibleFrom ?? scope.start,
			mutable: options.mutable ?? false,
			public: options.public ?? false,
			hidden: options.hidden ?? false,
			detail: options.detail ?? name,
			...(options.type ? { type: options.type } : {}),
			...(options.targetModule
				? { targetModule: options.targetModule }
				: {}),
		};
		this.symbols.set(symbol.id, symbol);
		this.definitions.set(node, symbol);
		this.record(range, symbol, options.type, true);
		return symbol;
	}
	definition(node: Node): SemanticSymbol | undefined {
		return this.definitions.get(node);
	}
	update(node: Node, type: Type | undefined, detail: string): void {
		const symbol = this.definition(node);
		if (!symbol) return;
		symbol.detail = detail;
		if (type) symbol.type = type;
		this.record(symbol.range, symbol, type, true);
	}
	reference(
		node: Node,
		symbol: SemanticSymbol | undefined,
		type?: Type,
		range = node.nameRange ?? node.range,
		mutable?: boolean,
	): void {
		if (range && symbol) this.record(range, symbol, type, false, mutable);
	}
	builtin(node: Node, type: Type): void {
		const range = node.nameRange ?? node.range;
		if (range)
			this.occurrences.set(this.key(range), {
				range,
				definitionId: null,
				detail: describe(type),
				type,
				declaration: false,
			});
	}
	narrow(
		symbol: SemanticSymbol | undefined,
		type: Type,
		scope: SourceRange | undefined,
	): void {
		if (symbol && scope) this.views.push({ symbol, type, scope });
	}
	private key(range: SourceRange): string {
		return `${range.file}:${range.start}:${range.end}`;
	}
	private record(
		range: SourceRange,
		symbol: SemanticSymbol,
		type: Type | undefined,
		declaration: boolean,
		mutable = symbol.mutable,
	): void {
		this.occurrences.set(this.key(range), {
			range,
			definitionId: symbol.id,
			detail: symbol.detail,
			...(type ? { type } : {}),
			declaration,
			mutable,
		});
	}
	occurrenceAt(file: string, offset: number): Occurrence | undefined {
		return [...this.occurrences.values()]
			.filter(
				(item) =>
					item.range.file === file &&
					item.range.start <= offset &&
					offset < item.range.end,
			)
			.sort(
				(a, b) =>
					a.range.end - a.range.start - (b.range.end - b.range.start),
			)[0];
	}
	definitionAt(file: string, offset: number): SemanticSymbol | undefined {
		const occurrence = this.occurrenceAt(file, offset);
		return occurrence?.definitionId
			? this.symbols.get(occurrence.definitionId)
			: undefined;
	}
	referencesAt(
		file: string,
		offset: number,
		includeDeclaration = false,
	): Occurrence[] {
		const id = this.occurrenceAt(file, offset)?.definitionId;
		return id
			? [...this.occurrences.values()].filter(
					(item) =>
						item.definitionId === id &&
						(includeDeclaration || !item.declaration),
				)
			: [];
	}
	visibleSymbols(file: string, offset: number): SemanticSymbol[] {
		const candidates = [...this.symbols.values()].filter(
			(symbol) =>
				!symbol.hidden &&
				(!symbol.type || !containsTSAny(symbol.type)) &&
				symbol.scope.file === file &&
				symbol.scope.start <= offset &&
				(offset < symbol.scope.end ||
					(offset === symbol.scope.end &&
						["function", "type", "module"].includes(
							symbol.kind,
						))) &&
				symbol.visibleFrom <= offset,
		);
		candidates.sort(
			(a, b) =>
				a.scope.end - a.scope.start - (b.scope.end - b.scope.start) ||
				b.visibleFrom - a.visibleFrom,
		);
		const visible = new Map<string, SemanticSymbol>();
		for (const symbol of candidates) {
			if (visible.has(symbol.name)) continue;
			const view = this.views
				.filter(
					(view) =>
						view.symbol.id === symbol.id &&
						view.scope.start <= offset &&
						offset < view.scope.end,
				)
				.sort(
					(a, b) =>
						a.scope.end -
						a.scope.start -
						(b.scope.end - b.scope.start),
				)[0];
			visible.set(
				symbol.name,
				view
					? {
							...symbol,
							type: view.type,
							mutable: false,
							detail: `${symbol.name}: ${describe(view.type)}`,
						}
					: symbol,
			);
		}
		return [...visible.values()];
	}
	moduleMembers(
		file: string,
		offset: number,
		alias: string,
	): SemanticSymbol[] {
		const module = this.visibleSymbols(file, offset).find(
			(symbol) => symbol.name === alias,
		)?.targetModule;
		if (!module) return [];
		return module.ast.declarations.flatMap((declaration) => {
			const symbol = this.definition(declaration);
			return symbol &&
				symbol.public &&
				!symbol.hidden &&
				(!symbol.type || !containsTSAny(symbol.type))
				? [symbol]
				: [];
		});
	}
}
