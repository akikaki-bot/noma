import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LanguageError } from "./ast.js";
import type { Declaration, Module, Span } from "./ast.js";
import { parse } from "./parser.js";
import { SourceText } from "./source.js";

export interface SourceModule {
	id: string;
	file: string;
	trusted: boolean;
	ast: Module;
	imports: Map<string, SourceModule>;
	source: SourceText;
}
export interface Program {
	entry: SourceModule;
	modules: SourceModule[];
}
/** Trusted host configuration, never supplied by Noma source code. */
export interface SourceFileSystem {
	readFile(file: string): Promise<string>;
	realpath(file: string): Promise<string>;
}
export const diskFileSystem: SourceFileSystem = {
	readFile: (file) => readFile(file, "utf8"),
	realpath,
};
export interface LoadProgramOptions {
	fileSystem?: SourceFileSystem;
	stdlibRoot?: string;
	projectRoot?: string;
	/** Absolute file paths; overlays never confer stdlib/native privileges. */
	sources?: ReadonlyMap<string, string>;
	onSource?: (source: SourceText) => void;
}
function missing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
/** Resolve existing ancestors, so new files still respect symlink/root boundaries. */
export async function canonicalPath(
	file: string,
	fs: SourceFileSystem = diskFileSystem,
	allowMissing = false,
): Promise<string> {
	file = path.resolve(file);
	try {
		return path.normalize(await fs.realpath(file));
	} catch (error) {
		if (!allowMissing || !missing(error) || path.dirname(file) === file)
			throw error;
		return path.join(
			await canonicalPath(path.dirname(file), fs, true),
			path.basename(file),
		);
	}
}
export function isInside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}
async function defaultStdlibRoot(fs: SourceFileSystem): Promise<string> {
	for (const relative of ["../stdlib/", "../../stdlib/"]) {
		try {
			return await canonicalPath(
				fileURLToPath(new URL(relative, import.meta.url)),
				fs,
			);
		} catch (error) {
			if (!missing(error)) throw error;
		}
	}
	throw new Error(
		"Bundled stdlib not found; configure stdlibRoot explicitly",
	);
}
export async function loadProgram(
	entryFile: string,
	options: LoadProgramOptions = {},
): Promise<Program> {
	const fs = options.fileSystem ?? diskFileSystem;
	const sources = new Map<string, string>();
	for (const [file, text] of options.sources ?? []) {
		const canonical = await canonicalPath(file, fs, true);
		if (sources.has(canonical))
			throw new Error(`Duplicate source overlay: ${file}`);
		sources.set(canonical, text);
	}
	const resolveSource = async (file: string): Promise<string> => {
		const canonical = await canonicalPath(file, fs, true);
		if (sources.has(canonical)) return canonical;
		return canonicalPath(file, fs);
	};
	const entryPath = await resolveSource(entryFile);
	const projectRoot = await canonicalPath(
		options.projectRoot ?? path.dirname(entryPath),
		fs,
		true,
	);
	if (!isInside(projectRoot, entryPath))
		throw new LanguageError(
			{ file: entryPath, line: 1, column: 1 },
			"Entry file escapes its project root",
		);
	let stdRootPromise: Promise<string> | undefined;
	const stdRoot = (): Promise<string> =>
		(stdRootPromise ??= options.stdlibRoot
			? canonicalPath(options.stdlibRoot, fs)
			: defaultStdlibRoot(fs));
	const modules: SourceModule[] = [],
		loaded = new Map<string, SourceModule>(),
		loading = new Set<string>();
	async function load(
		file: string,
		id: string,
		trusted: boolean,
		at?: Span,
	): Promise<SourceModule> {
		if (loading.has(file))
			throw new LanguageError(
				at ?? { file, line: 1, column: 1 },
				"Cyclic imports are not supported in this prototype",
			);
		if (trusted && sources.has(file))
			throw new LanguageError(
				at ?? { file, line: 1, column: 1 },
				"Editor overlays cannot replace trusted standard library modules",
			);
		const previous = loaded.get(file);
		if (previous) {
			if (previous.trusted !== trusted)
				throw new LanguageError(
					at ?? previous.ast.span,
					"Module trust cannot be changed by importing the same file",
				);
			return previous;
		}
		const source = new SourceText(
			file,
			sources.get(file) ?? (await fs.readFile(file)),
		);
		options.onSource?.(source);
		const ast = parse(source.text, file);
		const module: SourceModule = {
			id,
			file,
			trusted,
			ast,
			imports: new Map(),
			source,
		};
		loaded.set(file, module);
		loading.add(file);
		for (const declaration of ast.declarations) {
			if (declaration.kind !== "use") continue;
			const requested = declaration.path;
			const fail = (message: string): never => {
				throw new LanguageError(
					declaration.span,
					message,
					declaration.range,
				);
			};
			if (
				!requested ||
				requested.includes("\\") ||
				requested.includes("\0") ||
				requested.split("/").includes("..") ||
				path.isAbsolute(requested)
			)
				fail(
					"Module paths must be relative package paths without parent traversal",
				);
			const standard = requested.startsWith("std/");
			if (requested.startsWith("std/internal/") && !trusted)
				fail("std/internal is a trusted native boundary");
			let target: string, root: string;
			try {
				root = standard ? await stdRoot() : projectRoot;
				const base = standard
					? root
					: requested.startsWith("./")
						? path.dirname(file)
						: projectRoot;
				target = await resolveSource(
					path.resolve(base, `${requested}.noma`),
				);
			} catch (error) {
				if (!missing(error)) throw error;
				return fail(`Module not found: ${requested}`);
			}
			if (!isInside(root, target))
				fail("Module path escapes its package root");
			const dependency = await load(
				target,
				standard
					? requested
					: `app/${path.relative(projectRoot, target).replaceAll("\\", "/")}`,
				standard,
				declaration.span,
			);
			if (module.imports.has(declaration.alias))
				fail(`Duplicate alias '${declaration.alias}'`);
			module.imports.set(declaration.alias, dependency);
		}
		loading.delete(file);
		modules.push(module);
		return module;
	}
	const entry = await load(entryPath, "app/main", false);
	return { entry, modules };
}
export function declarations(
	module: SourceModule,
): Map<string, Exclude<Declaration, { kind: "use" }>> {
	const result = new Map<string, Exclude<Declaration, { kind: "use" }>>();
	for (const declaration of module.ast.declarations) {
		if (declaration.kind === "use") continue;
		if (
			result.has(declaration.name) ||
			module.imports.has(declaration.name)
		)
			throw new LanguageError(
				declaration.span,
				`Duplicate declaration '${declaration.name}'`,
				declaration.nameRange ?? declaration.range,
			);
		result.set(declaration.name, declaration);
	}
	return result;
}
