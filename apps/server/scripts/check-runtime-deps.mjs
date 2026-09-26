#!/usr/bin/env node
/**
 * Fails the build when the compiled server bundle imports a third-party package that
 * apps/server/package.json does not declare.
 *
 * Why this exists: tsdown bundles the @reactive-resume/* workspace packages but leaves every
 * third-party import external (see tsdown.config.ts), and the Docker runtime stage installs
 * ONLY this package's dependencies. So any dependency added to a workspace package (api, db,
 * resume, …) that reaches the server graph MUST be repeated here — a convention nothing
 * previously enforced. It failed silently twice in one feature branch (pg-boss, then
 * wink-porter2-stemmer): dev runs resolve against the hoisted workspace node_modules, so the
 * gap only surfaces as a crash-loop of the production container. This check moves that
 * failure to build time, where the Dockerfile's builder stage runs it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(serverDir, "dist");

const packageJson = JSON.parse(readFileSync(resolve(serverDir, "package.json"), "utf-8"));
const declared = new Set(Object.keys(packageJson.dependencies ?? {}));
const builtins = new Set(builtinModules);

// Static import/export statements at line starts plus dynamic import("…") calls. The bundle
// is generated code, so statement-anchored matching is reliable; a loose "from" regex is not
// (string literals in bundled source contain the word).
const statementRe = /^(?:import|export)[^"';]*?from\s*["']([^"'./][^"']*)["']|^import\s*["']([^"'./][^"']*)["']/gm;
const dynamicRe = /import\(\s*["']([^"'./][^"']*)["']\s*\)/g;

function packageName(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const specifiers = new Set();
for (const filename of readdirSync(distDir)) {
	if (!filename.endsWith(".mjs")) continue;
	const source = readFileSync(resolve(distDir, filename), "utf-8");
	for (const match of source.matchAll(statementRe)) specifiers.add(match[1] ?? match[2]);
	for (const match of source.matchAll(dynamicRe)) specifiers.add(match[1]);
}

const missing = [...new Set([...specifiers].filter(Boolean).map(packageName))]
	.filter((name) => !name.startsWith("node:") && !name.startsWith("#") && !builtins.has(name))
	.filter((name) => !name.startsWith("@reactive-resume/"))
	.filter((name) => !declared.has(name))
	.sort();

if (missing.length > 0) {
	console.error(
		"The server bundle imports third-party packages that apps/server/package.json does not declare.\n" +
			"The Docker runtime stage installs only this package's dependencies, so the container would crash at boot.\n" +
			`Add to apps/server/package.json dependencies: ${missing.join(", ")}`,
	);
	process.exit(1);
}

console.info(`Runtime dependency check passed: every bundle external is declared (${declared.size} deps).`);
