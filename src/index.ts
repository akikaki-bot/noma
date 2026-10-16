import { compile } from "./compiler.js";
import { Interpreter } from "./interpreter.js";
import type { RunOptions } from "./interpreter.js";
import { createIORegistry } from "./native.js";
import type { IOHost } from "./native.js";

export { compile } from "./compiler.js";
export async function runFile(
	file: string,
	host: IOHost,
	options?: RunOptions,
) {
	const program = await compile(file);
	return new Interpreter(program, createIORegistry(host), options).run();
}
export { LanguageError } from "./ast.js";
export { parse } from "./parser.js";
export { lex } from "./lexer.js";
export { Interpreter } from "./interpreter.js";
export { NativeRegistry, NodeIOHost, createIORegistry } from "./native.js";
export { ThrowableValue } from "./values.js";
export { analyzeFile, AnalysisSnapshot } from "./analysis.js";
export type {
	AnalysisOptions,
	AnalysisResult,
	Diagnostic,
	Location,
	Hover,
	Completion,
} from "./analysis.js";
export { AnalysisWorkspace } from "./workspace.js";
export type {
	EditorDocument,
	WorkspaceOptions,
	WorkspaceChange,
} from "./workspace.js";
export { SourceText } from "./source.js";
export type { SourceRange, Position, Range } from "./source.js";
export { loadProgram, canonicalPath, diskFileSystem } from "./modules.js";
export type {
	Program,
	SourceModule,
	LoadProgramOptions,
	SourceFileSystem,
} from "./modules.js";
export { checkProgram, CheckedProgram } from "./checker.js";
export type { CheckOptions } from "./checker.js";
export type { SemanticSymbol, SymbolKind, Occurrence } from "./semantic.js";
