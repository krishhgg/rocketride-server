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
 * already did for every file that still exists. Everything compiled stays,
 * the C++ node libraries under nodes/ included.
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
 * What a build that downloaded the engine stages again from its own checkout
 * without removing other files: the source tree, and where it lands under
 * dist/server.
 */
export const SOURCE_STAGED = [
	{ source: 'packages/ai/src', dist: 'ai' },
	{ source: 'nodes/src/nodes', dist: 'nodes' },
];

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
 * one of SOURCE_STAGED and every file of it landed in that tree's place. A
 * node source that stages elsewhere (the parse node's tika-config.xml goes to
 * java/) is kept: nothing says a downloading build stages it again.
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
		const tree = SOURCE_STAGED.find(({ source: dir }) => {
			const prefix = normalize(`${base}/${dir}`);
			return at === prefix || at.startsWith(`${prefix}/`);
		});
		const inPlace = tree && files.every((file) => normalize(file).startsWith(`${tree.dist}/`));
		if (inPlace) {
			dropped[source] = files;
			seen.add(tree.source);
		} else {
			kept[source] = files;
		}
	}

	// A renamed tree or a changed state layout must not turn this back into
	// the full archive without anyone noticing
	for (const { source } of SOURCE_STAGED) {
		if (!seen.has(source)) {
			throw new Error(
				`The package state has nothing staged from ${source}, so the cache archive is not packaged`
			);
		}
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
	const trees = SOURCE_STAGED.map((tree) => tree.source).join(' and ');
	log(`Packaging ${files.length} file(s), leaving out ${left} staged from ${trees}`);
	await fs.rm(archivePath, { force: true });
	await (archive ?? builderArchive(root))(archivePath, path.join(root, 'dist', 'server'), files);

	// As `builder package` writes it, with the package state the archive holds.
	// After the archive: a manifest that can be read means its archive is there.
	const manifest = { ...state, server: { ...state.server }, package: kept };
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
