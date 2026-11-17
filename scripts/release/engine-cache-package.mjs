#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Package the engine a CI build just compiled for the `engine-cache` release.
 *
 * `builder package` archives every file the build staged into dist/server. For
 * a release that is right. For the cache it is not: a cached engine is keyed
 * by the server source hash alone, so a build whose packages/server matches
 * downloads it whatever the rest of its checkout holds. The archive is
 * extracted over dist/server, and `ai:sync` and `nodes:sync` then copy the
 * checkout's files without removing others (`mirror: false`), so a file the
 * archive's commit had under packages/ai or nodes, and the checkout deleted,
 * stayed in dist/server and could be imported by a test.
 *
 * So the cache archive leaves out what those two tasks stage from source. A
 * build that downloads it stages both trees from its own checkout, as it
 * already did for every file that still exists. Everything compiled from
 * packages/server stays, the C++ node libraries under nodes/ included.
 *
 * The Java libraries are left out for the same reason. Their sources are
 * packages/java/lib and the parse node's lib/parse, neither of them under
 * packages/server, and `java:sync` and `parse:sync` copy the Maven
 * dependencies without removing others. A CI build that downloads the engine
 * starts with no `java.srcHash` or `parse.srcHash` in its state (the download
 * restores neither), so it runs Maven and stages every jar again
 * (`nodes:submodule-build` > `parse:submodule-build` > `java:submodule-build`).
 * With the archive's jars underneath, a dependency the checkout upgraded or
 * dropped stayed in dist/server/java/lib beside the new one, and the engine
 * puts every jar it finds there on the class path. The JRE stays: it is a
 * download, not built from the checkout, and `java:sync` mirrors it.
 *
 * Writes into the output directory, in this order:
 *   engine-tested-<platform>.json                         this platform's engine tests passed
 *   rocketride-server-v<version>-<platform>.tar.gz|zip    the archive
 *   rocketride-server-v<version>-<platform>.manifest.json the build state, read by `server:download`
 *
 * The first file exists before the archive is made, so the publisher can tell
 * a platform that never got this far from one whose archive went missing.
 *
 * Usage, from the repository root, after `builder server:test` passed:
 *   node scripts/release/engine-cache-package.mjs [--root=.] [--out=dist/engine-cache]
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * What a build that downloaded the engine makes again from its own checkout
 * without removing other files: where the files come from, and where they
 * land under dist/server. A source is left out when it lies in one of these
 * and every file of it landed in that place.
 *
 * `required` names the two trees the strategy rests on: a state without them
 * is not packaged.
 */
export const REBUILT = [
	{ source: 'packages/ai/src', dist: 'ai', required: true },
	{ source: 'nodes/src/nodes', dist: 'nodes', required: true },
	// parse:sync: the parse jar, its Maven dependencies and tika-config.xml
	{ source: 'nodes/src/nodes/parse/lib/parse', dist: 'java' },
	{ source: 'build/parse', dist: 'java/lib' },
	// java:sync: rocketride-core with its dependencies, and rocketride-dbgconn
	{ source: 'build/java/core', dist: 'java/lib' },
	{ source: 'build/java/dbgconn', dist: 'java/lib' },
];

/**
 * Written to the manifest as `engineCache.format`, and raised whenever REBUILT
 * changes, so a full archive, or one an older packer made, can be told from
 * this one's by its manifest alone. `server:download` does not read it.
 */
export const CACHE_FORMAT = 1;

/** The one part of dist/server/java a downloading build does not make itself. */
const JAVA_KEPT = 'java/jre/';

const HASH_RE = /^[0-9a-f]{64}$/;

/** The platform name and archive type, as `getPlatformInfo` in packages/server/scripts/tasks.js names them. */
export function platformInfo(platform = process.platform, arch = process.arch) {
	if (platform === 'win32') return { name: 'win64', ext: 'zip' };
	if (platform === 'darwin') return { name: `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`, ext: 'tar.gz' };
	if (platform === 'linux') return { name: 'linux-x64', ext: 'tar.gz' };
	throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/** Forward slashes, no trailing one, and one case for a Windows path. */
function normalize(p) {
	const slashed = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
	return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * Split the build's package state into what the cache archive keeps and what
 * it leaves out.
 *
 * The state maps each staged source (a directory or one file, absolute) to
 * the files it put under dist/server. A source is left out when it lies in
 * one of REBUILT and every file of it landed in that entry's place. A compiled
 * node library comes from build/nodes, so it is kept.
 *
 * @param {Object<string, string[]>} packageState - `package` of build/state.json
 * @param {string} root - The repository root the build ran in
 * @returns {{kept: Object<string, string[]>, dropped: Object<string, string[]>}}
 */
export function selectEntries(packageState, root) {
	const base = normalize(root);
	const kept = {};
	const dropped = {};
	const seen = new Set();

	for (const [source, files] of Object.entries(packageState)) {
		const at = normalize(source);
		const entry = REBUILT.find(({ source: dir, dist }) => {
			const prefix = normalize(`${base}/${dir}`);
			if (at !== prefix && !at.startsWith(`${prefix}/`)) return false;
			return files.every((file) => normalize(file).startsWith(`${dist}/`));
		});
		if (entry) {
			dropped[source] = files;
			seen.add(entry.source);
		} else {
			kept[source] = files;
		}
	}

	// A renamed tree or a changed state layout must not turn this back into
	// the full archive without anyone noticing
	for (const { source, required } of REBUILT) {
		if (required && !seen.has(source)) {
			throw new Error(
				`The package state has nothing staged from ${source}, so the cache archive is not packaged`
			);
		}
	}
	// The same for the Java libraries: a jar staged from a place REBUILT does
	// not list would be cached and then sit beside the one a build makes
	const jar = Object.values(kept)
		.flat()
		.map(normalize)
		.find((file) => file.startsWith('java/') && !file.startsWith(JAVA_KEPT));
	if (jar) {
		throw new Error(
			`${jar} is staged from a source the packer does not know, so the cache archive is not packaged: ` +
				'outside java/jre, a downloading build makes dist/server/java itself'
		);
	}
	if (!Object.keys(kept).length) throw new Error('Nothing left to package for the cache');

	return { kept, dropped };
}

/** The builder's own archive writer, so `server:download` reads what it always has. */
function builderArchive(root) {
	const require = createRequire(path.join(root, 'scripts', 'lib', 'download.js'));
	return require('./download.js').createArchive;
}

/**
 * Write the marker, the archive and the manifest for this build.
 *
 * @param {Object} opts
 * @param {string} opts.root - The repository root the build ran in
 * @param {string} opts.out - Output directory
 * @param {{name: string, ext: string}} [opts.platform]
 * @param {Function} [opts.archive] - (archivePath, cwd, files) => Promise, the builder's by default
 * @param {Function} [opts.log]
 * @returns {Promise<{platform: string, hash: string, archive: string, manifest: string, files: number, left: number}>}
 */
export async function packageEngine({ root, out, platform = platformInfo(), archive, log = console.log }) {
	const state = JSON.parse(await fs.readFile(path.join(root, 'build', 'state.json'), 'utf8'));
	const hash = state?.server?.buildHash;
	if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
		throw new Error(`build/state.json: server.buildHash is not a SHA-256 hex digest (${JSON.stringify(hash)})`);
	}
	if (!state.package || typeof state.package !== 'object') {
		throw new Error('build/state.json has no package state; build the server first');
	}
	const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

	await fs.mkdir(out, { recursive: true });
	await fs.writeFile(
		path.join(out, `engine-tested-${platform.name}.json`),
		JSON.stringify({ platform: platform.name, buildHash: hash }) + '\n'
	);

	const { kept, dropped } = selectEntries(state.package, root);
	const files = [...new Set(Object.values(kept).flat())];
	const left = Object.values(dropped).flat().length;

	const base = `rocketride-server-v${version}-${platform.name}`;
	const archivePath = path.join(out, `${base}.${platform.ext}`);
	const manifestPath = path.join(out, `${base}.manifest.json`);

	log(`${platform.name}: buildHash ${hash}`);
	log(`Packaging ${files.length} file(s), leaving out ${left} a downloading build makes again:`);
	for (const { source } of REBUILT) {
		const prefix = normalize(`${normalize(root)}/${source}`);
		const count = Object.entries(dropped)
			.filter(([from]) => normalize(from) === prefix || normalize(from).startsWith(`${prefix}/`))
			.reduce((sum, [, list]) => sum + list.length, 0);
		log(`  ${count} from ${source}`);
	}
	await fs.rm(archivePath, { force: true });
	await (archive ?? builderArchive(root))(archivePath, path.join(root, 'dist', 'server'), files);

	// As `builder package` writes it, with the package state the archive holds.
	// After the archive: a manifest that can be read means its archive is there.
	const manifest = { ...state, server: { ...state.server }, package: kept, engineCache: { format: CACHE_FORMAT } };
	delete manifest.server.releases;
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

	log(`Wrote ${path.basename(archivePath)} and ${path.basename(manifestPath)}`);
	return { platform: platform.name, hash, archive: archivePath, manifest: manifestPath, files: files.length, left };
}

/** Parse argv and package. */
async function main() {
	const args = process.argv.slice(2);
	const value = (name, fallback) => {
		const arg = args.find((a) => a.startsWith(`--${name}=`));
		return arg ? arg.slice(name.length + 3) : fallback;
	};
	const unknown = args.filter((a) => !/^--(root|out)=./.test(a));
	if (unknown.length) {
		console.error('Usage: engine-cache-package.mjs [--root=<repository>] [--out=<directory>]');
		process.exitCode = 2;
		return;
	}

	const root = path.resolve(value('root', '.'));
	await packageEngine({ root, out: path.resolve(value('out', path.join(root, 'dist', 'engine-cache'))) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
