export type Type =
	| { kind: "parameter"; name: string; id: string }
	| {
			kind:
				| "string"
				| "int32"
				| "int8"
				| "int16"
				| "int64"
				| "uint8"
				| "uint16"
				| "uint32"
				| "uint64"
				| "float32"
				| "float64"
				| "bool"
				| "void"
				| "never"
				| "tsany"
				| "meta"
				| "intrinsic"
				| "throwable";
	  }
	| { kind: "struct"; fields: ReadonlyMap<string, Type> }
	| { kind: "array"; element: Type }
	| { kind: "future"; result: Type }
	| { kind: "union"; members: Type[] };
export const STRING: Type = { kind: "string" },
	INT32: Type = { kind: "int32" },
	BOOL: Type = { kind: "bool" };
export const INT8: Type = { kind: "int8" },
	INT16: Type = { kind: "int16" },
	INT64: Type = { kind: "int64" },
	UINT8: Type = { kind: "uint8" },
	UINT16: Type = { kind: "uint16" },
	UINT32: Type = { kind: "uint32" },
	UINT64: Type = { kind: "uint64" },
	FLOAT32: Type = { kind: "float32" },
	FLOAT64: Type = { kind: "float64" };
export const VOID: Type = { kind: "void" },
	NEVER: Type = { kind: "never" },
	TSANY: Type = { kind: "tsany" };
export const THROWABLE: Type = {
	kind: "throwable",
};
export const TYPE: Type = { kind: "meta" };
export const INTRINSIC: Type = { kind: "intrinsic" };
export const EOF_TYPE: Type = {
	kind: "struct",
	fields: new Map([["eof", BOOL]]),
};
export const builtins = new Map<string, Type>([
	["string", STRING],
	["int32", INT32],
	["int8", INT8],
	["int16", INT16],
	["int64", INT64],
	["uint8", UINT8],
	["uint16", UINT16],
	["uint32", UINT32],
	["uint64", UINT64],
	["float32", FLOAT32],
	["float64", FLOAT64],
	["bool", BOOL],
	["void", VOID],
	["never", NEVER],
	["throwable", THROWABLE],
	["Type", TYPE],
]);
export function describe(type: Type): string {
	switch (type.kind) {
		case "parameter":
			return type.name;
		case "struct":
			return `struct { ${[...type.fields].map(([name, value]) => `${name}: ${describe(value)};`).join(" ")} }`;
		case "array":
			return `(${describe(type.element)})[]`;
		case "future":
			return `Future<${describe(type.result)}>`;
		case "union":
			return type.members.map(describe).join(" | ");
		default:
			return type.kind === "tsany"
				? "TSAny"
				: type.kind === "meta"
					? "Type"
					: type.kind;
	}
}
export function assignable(source: Type, target: Type): boolean {
	if (source.kind === "never") return true;
	if (source.kind === "union")
		return source.members.every((member) => assignable(member, target));
	if (target.kind === "union")
		return target.members.some((member) => assignable(source, member));
	if (source.kind !== target.kind) return false;
	if (source.kind === "parameter" && target.kind === "parameter")
		return source.id === target.id;
	if (source.kind === "struct" && target.kind === "struct")
		return (
			source.fields.size === target.fields.size &&
			[...target.fields].every(([key, type]) => {
				const field = source.fields.get(key);
				return field !== undefined && equivalent(field, type);
			})
		);
	if (source.kind === "array" && target.kind === "array")
		return equivalent(source.element, target.element);
	if (source.kind === "future" && target.kind === "future")
		return equivalent(source.result, target.result);
	return true;
}
/** Static proof for an explicit, recursively copied structural projection. */
export function projectable(source: Type, target: Type): boolean {
	if (containsFuture(source) || containsFuture(target)) return false;
	if (source.kind === "never") return true;
	if (source.kind === "union")
		return source.members.every((member) => projectable(member, target));
	if (target.kind === "union")
		return (
			projectionAlternative(
				target.members.filter((member) => projectable(source, member)),
			) !== undefined
		);
	if (source.kind !== target.kind) return false;
	if (source.kind === "parameter" && target.kind === "parameter")
		return source.id === target.id;
	if (source.kind === "struct" && target.kind === "struct")
		return [...target.fields].every(([key, type]) => {
			const field = source.fields.get(key);
			return field !== undefined && projectable(field, type);
		});
	if (source.kind === "array" && target.kind === "array")
		return projectable(source.element, target.element);
	return !["meta", "intrinsic", "tsany"].includes(source.kind);
}
/** Prefer the most specific compatible alternative, independently of union order.
 * Incomparable overlapping projections have no unambiguous representation. */
export function projectionAlternative(candidates: Type[]): Type | undefined {
	return candidates.find((candidate) =>
		candidates.every((other) => projectable(candidate, other)),
	);
}
export function equivalent(a: Type, b: Type): boolean {
	return assignable(a, b) && assignable(b, a);
}
/** Pattern coverage is a test of shape, not an implicit conversion or projection. */
export function patternCovers(source: Type, pattern: Type): boolean {
	if (source.kind === "never") return true;
	if (source.kind === "union")
		return source.members.every((member) => patternCovers(member, pattern));
	if (pattern.kind === "union")
		return pattern.members.some((member) => patternCovers(source, member));
	if (source.kind !== pattern.kind) return false;
	if (source.kind === "parameter" && pattern.kind === "parameter")
		return source.id === pattern.id;
	if (source.kind === "struct" && pattern.kind === "struct")
		return [...pattern.fields].every(([key, type]) => {
			const field = source.fields.get(key);
			return field !== undefined && patternCovers(field, type);
		});
	if (source.kind === "array" && pattern.kind === "array")
		return patternCovers(source.element, pattern.element);
	if (source.kind === "future" && pattern.kind === "future")
		return equivalent(source.result, pattern.result);
	return true;
}
export function union(types: Type[]): Type {
	const members: Type[] = [];
	for (const type of types.flatMap((t) =>
		t.kind === "union" ? t.members : [t],
	)) {
		if (
			type.kind === "never" ||
			members.some((other) => equivalent(type, other))
		)
			continue;
		members.push(type);
	}
	return members.length === 0
		? NEVER
		: members.length === 1
			? members[0]!
			: { kind: "union", members };
}
export function containsTSAny(type: Type): boolean {
	if (type.kind === "tsany") return true;
	if (type.kind === "future") return containsTSAny(type.result);
	if (type.kind === "array") return containsTSAny(type.element);
	if (type.kind === "struct")
		return [...type.fields.values()].some(containsTSAny);
	if (type.kind === "union") return type.members.some(containsTSAny);
	return false;
}
/** Affine values cannot pass through any operation that copies storage. */
export function containsFuture(type: Type): boolean {
	if (type.kind === "future") return true;
	if (type.kind === "array") return containsFuture(type.element);
	if (type.kind === "struct")
		return [...type.fields.values()].some(containsFuture);
	if (type.kind === "union") return type.members.some(containsFuture);
	return false;
}
export function variants(type: Type): Type[] {
	return type.kind === "union"
		? type.members
		: type.kind === "never"
			? []
			: [type];
}
/** Conservative overlap check; array types overlap at least at the empty array. */
export function overlaps(a: Type, b: Type): boolean {
	if (a.kind === "never" || b.kind === "never") return false;
	// An unconstrained parameter can instantiate to any runtime type.
	if (a.kind === "parameter" || b.kind === "parameter") return true;
	if (a.kind === "union")
		return a.members.some((member) => overlaps(member, b));
	if (b.kind === "union")
		return b.members.some((member) => overlaps(a, member));
	if (a.kind !== b.kind) return false;
	if (a.kind === "struct" && b.kind === "struct") {
		return [...a.fields].every(
			([key, field]) =>
				!b.fields.has(key) || overlaps(field, b.fields.get(key)!),
		);
	}
	return true;
}

/** Capture-free substitution by declaration identity, including nested shapes. */
export function substitute(
	type: Type,
	bindings: ReadonlyMap<string, Type>,
): Type {
	switch (type.kind) {
		case "parameter":
			return bindings.get(type.id) ?? type;
		case "array":
			return {
				kind: "array",
				element: substitute(type.element, bindings),
			};
		case "future":
			return {
				kind: "future",
				result: substitute(type.result, bindings),
			};
		case "struct":
			return {
				kind: "struct",
				fields: new Map(
					[...type.fields].map(([name, field]) => [
						name,
						substitute(field, bindings),
					]),
				),
			};
		case "union":
			return union(
				type.members.map((member) => substitute(member, bindings)),
			);
		default:
			return type;
	}
}
