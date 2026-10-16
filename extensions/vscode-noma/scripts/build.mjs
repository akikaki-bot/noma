import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
const common = {
	absWorkingDir: root,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	metafile: true,
	logLevel: "info",
};
const outputs = await Promise.all([
	build({
		...common,
		entryPoints: ["src/client/extension.ts"],
		outfile: "dist/extension.cjs",
		external: ["vscode"],
	}),
	build({
		...common,
		entryPoints: ["src/server/index.ts"],
		outfile: "dist/server.cjs",
		define: { "import.meta.url": "__nomaModuleUrl" },
		banner: {
			js: 'const __nomaModuleUrl = require("node:url").pathToFileURL(__filename).href;',
		},
	}),
]);
const serverInputs = Object.keys(outputs[1].metafile.inputs);
if (
	serverInputs.some((file) =>
		/(?:^|\/)src\/(?:index|interpreter|native|values|cli)\.ts$/.test(file),
	)
)
	throw new Error("Server must use analysis-only compiler APIs");
await cp(path.resolve(root, "../../stdlib"), path.join(dist, "stdlib"), {
	recursive: true,
});

// Preserve the license notices of dependencies actually bundled into either entry.
const packages = new Map();
for (const output of outputs)
	for (const input of Object.keys(output.metafile.inputs)) {
		if (!input.includes("node_modules/")) continue;
		let directory = path.dirname(path.resolve(root, input));
		while (directory !== path.dirname(directory)) {
			try {
				const pkg = JSON.parse(
					await readFile(
						path.join(directory, "package.json"),
						"utf8",
					),
				);
				if (pkg.name) {
					packages.set(pkg.name, { pkg, directory });
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			directory = path.dirname(directory);
		}
	}
const notices = [];
for (const { pkg, directory } of [...packages.values()].sort((a, b) =>
	a.pkg.name.localeCompare(b.pkg.name),
)) {
	const licenses = (await readdir(directory)).filter((name) =>
		/^(?:licen[cs]e|notice)(?:\.|$)/i.test(name),
	);
	notices.push(
		`${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See package license"}\n${(await Promise.all(licenses.map((name) => readFile(path.join(directory, name), "utf8")))).join("\n")}`,
	);
}
await writeFile(
	path.join(dist, "THIRD_PARTY_NOTICES.txt"),
	notices.join("\n\n--------------------\n\n"),
);
await writeFile(
	path.join(dist, "build-meta.json"),
	JSON.stringify(
		outputs.map((output) => output.metafile),
		null,
		2,
	),
);
