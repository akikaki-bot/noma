export type Type =
	| {
			kind:
				| "string"
				| "int32"
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
	| { kind: "union"; members: Type[] };
export const STRING: Type = { kind: "string" },
	INT32: Type = { kind: "int32" },
	BOOL: Type = { kind: "bool" };
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
	["bool", BOOL],
	["void", VOID],
	["never", NEVER],
	["throwable", THROWABLE],
	["Type", TYPE],
]);
export function describe(type: Type): string {
	switch (type.kind) {
		case "struct":
			return `struct { ${[...type.fields].map(([name, value]) => `${name}: ${describe(value)};`).join(" ")} }`;
		case "array":
			return `(${describe(type.element)})[]`;
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
	return true;
}
/** Static proof for an explicit, recursively copied structural projection. */
export function projectable(source: Type, target: Type): boolean {
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
	if (source.kind === "struct" && pattern.kind === "struct")
		return [...pattern.fields].every(([key, type]) => {
			const field = source.fields.get(key);
			return field !== undefined && patternCovers(field, type);
		});
	if (source.kind === "array" && pattern.kind === "array")
		return patternCovers(source.element, pattern.element);
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
	if (type.kind === "array") return containsTSAny(type.element);
	if (type.kind === "struct")
		return [...type.fields.values()].some(containsTSAny);
	if (type.kind === "union") return type.members.some(containsTSAny);
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
