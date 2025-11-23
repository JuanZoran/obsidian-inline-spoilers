import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync } from "fs";

const banner =
`/*!
 * Inline Spoilers for Obsidian
 * https://github.com/logonoff/obsidian-inline-spoilers
 * SPDX-License-Identifier: GPL-3.0-or-later
 */`;

const prod = (process.argv[2] === "production");

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "build/main.js",
	minify: prod,
});

// 确保 build 目录存在
mkdirSync("build", { recursive: true });

// 复制 manifest.json 和 styles.css 到 build 目录
const copyFiles = () => {
	copyFileSync("manifest.json", "build/manifest.json");
	copyFileSync("styles.css", "build/styles.css");
};

if (prod) {
	await context.rebuild();
	copyFiles();
	process.exit(0);
} else {
	copyFiles();
	await context.watch();
}
