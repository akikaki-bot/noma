import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
await build({
	absWorkingDir: root,
	entryPoints: ["test/host/index.ts"],
	outfile: "dist/host-test.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["vscode"],
});
const runDirectory = await mkdtemp(path.join(dist, "host-test-"));
const workspace = path.join(runDirectory, "workspace");
await mkdir(workspace);
await writeFile(
	path.join(workspace, "helper.noma"),
	"pub fn answer(value: int32) -> int32 { return value; }",
);
await writeFile(
	path.join(workspace, "main.noma"),
	'use "helper" as h;\nfn main() -> int32 {\n let value: int32 = 2;\n return h.answer(value);\n}\n',
);

let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (
	!executable &&
	process.platform === "win32" &&
	process.env.NOMA_TEST_DOWNLOAD_VSCODE !== "1"
) {
	for (const base of [
		process.env.LOCALAPPDATA &&
			path.join(process.env.LOCALAPPDATA, "Programs"),
		process.env.ProgramFiles,
	].filter(Boolean)) {
		const candidate = path.join(base, "Microsoft VS Code", "Code.exe");
		try {
			await access(candidate);
			executable = candidate;
			break;
		} catch {
			/* Try the next install. */
		}
	}
}
await runTests({
	...(process.env.VSCODE_TEST_VERSION
		? { version: process.env.VSCODE_TEST_VERSION }
		: {}),
	...(executable ? { vscodeExecutablePath: executable } : {}),
	cachePath: path.join(dist, "vscode-test"),
	extensionDevelopmentPath: root,
	extensionTestsPath: path.join(dist, "host-test.cjs"),
	extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
	launchArgs: [
		workspace,
		"--disable-extensions",
		"--user-data-dir",
		path.join(runDirectory, "user-data"),
		"--extensions-dir",
		path.join(runDirectory, "extensions"),
	],
});
