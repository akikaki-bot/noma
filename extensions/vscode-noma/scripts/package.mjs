import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
	await readFile(new URL("package.json", root), "utf8"),
);
await mkdir(new URL("dist/", root), { recursive: true });
const output = fileURLToPath(
	new URL(`dist/${manifest.name}-${manifest.version}.vsix`, root),
);
const require = createRequire(import.meta.url);
const cli = path.join(
	path.dirname(require.resolve("@vscode/vsce/package.json")),
	"vsce",
);
const result = spawnSync(
	process.execPath,
	[
		cli,
		"package",
		"--no-dependencies",
		"--allow-missing-repository",
		"--skip-license",
		"--out",
		output,
	],
	{ cwd: fileURLToPath(root), stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
