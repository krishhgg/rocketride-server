#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Ask whether the `engine-cache` release already holds the engine of this
 * checkout for every platform CI builds.
 *
 * A prerelease run that only feeds the engine cache compiles the engine on
 * three platforms. Most pushes to develop leave packages/server alone, so
 * their engine is in the cache already and that build would upload the same
 * engines again. `_init.yaml` runs this before the build, and prerelease.yaml
 * skips the build when the answer is yes.
 *
 * The answer is yes only when, for every platform, the release has the
 * archive and a manifest that `builder server:download` would accept for this
 * checkout (the same full `server.buildHash` and `vcpkg.version`), written by
 * the current packer (`engineCache.format`, see engine-cache-package.mjs). A
 * full archive from before the packer, or one an older packer made, is
 * therefore built again and replaced.
 *
 * The hash is computed with the builder's own `contentHash` from the checkout
 * (scripts/lib/fs.js, which needs no installed package), over packages/server
 * without the two generated version files, as `server:download` computes it.
 *
 * Whatever goes wrong, the answer is no and the exit code is 0: the check
 * may cost a build, it must never stop one.
 *
 * Usage, from the root of the checkout to build:
 *   node scripts/release/engine-cache-check.mjs [--root=.]
 *
 * Needs `gh`, GH_TOKEN with contents: read, and GH_REPO (owner/name). In a
 * workflow step it sets the outputs `server_hash` (empty when it could not be
 * computed) and `engine_cached` (`true` or `false`).
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_FORMAT, platformInfo } from './engine-cache-package.mjs';
import { engineAssetName, listAssets, runGh } from './engine-cache-publish.mjs';

/** The platforms the build matrix of _build.yaml compiles: ubuntu, windows and macos (arm64). */
export const BUILT_PLATFORMS = [
	platformInfo('linux', 'x64'),
	platformInfo('win32', 'x64'),
	platformInfo('darwin', 'arm64'),
];

/** Left out of the server source hash, as SOURCE_EXCLUDE in packages/server/scripts/tasks.js. */
export const SOURCE_EXCLUDE = ['version.h', 'version.rc'];

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The server source hash of a checkout, as `server:download` computes it.
 *
 * @param {string} root - The repository root
 * @returns {Promise<string>}
 */
export async function serverSourceHash(root) {
	const require = createRequire(path.join(root, 'scripts', 'lib', 'fs.js'));
	const { contentHash } = require('./fs.js');
	const hash = await contentHash(path.join(root, 'packages', 'server'), { exclude: SOURCE_EXCLUDE });
	if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
		throw new Error(`packages/server did not hash to a SHA-256 hex digest (${JSON.stringify(hash)})`);
	}
	return hash;
}

/**
 * The vcpkg version a build of this checkout uses, or null when package.json
 * does not name one. The builder then falls back to a default of its own,
 * which is not repeated here: no version means the cache is not trusted.
 */
export async function vcpkgVersion(root) {
	const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
	return typeof pkg?.vcpkg?.version === 'string' ? pkg.vcpkg.version : null;
}

/**
 * What the cache lacks for this source, per platform.
 *
 * @param {Object} opts
 * @param {string} opts.hash - The full server source hash
 * @param {string} opts.vcpkg - The vcpkg version
 * @param {string} opts.repo - owner/name
 * @param {Array<{name: string, ext: string}>} [opts.platforms]
 * @param {Function} [opts.gh] - Runs gh with an argument list, resolves with stdout
 * @returns {Promise<Array<{platform: string, why: string}>>} Empty when every
 *   platform's engine is there
 */
export async function missingEngines({ hash, vcpkg, repo, platforms = BUILT_PLATFORMS, gh = runGh }) {
	const assets = await listAssets(gh, repo);
	const missing = [];

	for (const { name: platform, ext } of platforms) {
		const archive = engineAssetName(hash, platform, ext);
		const manifest = assets.find((asset) => asset.name === engineAssetName(hash, platform, 'manifest.json'));
		const lacks = (why) => missing.push({ platform, why });

		if (!assets.some((asset) => asset.name === archive)) {
			lacks(`no ${archive}`);
			continue;
		}
		if (!manifest) {
			lacks(`no manifest beside ${archive}`);
			continue;
		}

		let state;
		try {
			state = JSON.parse(
				await gh([
					'api',
					'-H',
					'Accept: application/octet-stream',
					`repos/${repo}/releases/assets/${manifest.id}`,
				])
			);
		} catch (error) {
			lacks(`${manifest.name} cannot be read (${error.message})`);
			continue;
		}

		// The asset names carry 16 characters of the hash; the builder compares all of it
		if (state?.server?.buildHash !== hash) lacks(`${manifest.name} is for ${state?.server?.buildHash}`);
		else if (state?.vcpkg?.version !== vcpkg)
			lacks(`${manifest.name} was built with vcpkg ${state?.vcpkg?.version}`);
		else if (state?.engineCache?.format !== CACHE_FORMAT) {
			lacks(`${manifest.name} has archive format ${state?.engineCache?.format ?? 'none'}, not ${CACHE_FORMAT}`);
		}
	}
	return missing;
}

/**
 * Hash the checkout and ask the cache. Never throws.
 *
 * @param {Object} opts
 * @param {string} opts.root - The repository root
 * @param {string} opts.repo - owner/name
 * @param {Function} [opts.gh]
 * @param {Function} [opts.log]
 * @returns {Promise<{hash: string, cached: boolean}>} `hash` is '' when it could not be computed
 */
export async function check({ root, repo, gh = runGh, log = console.log }) {
	let hash = '';
	try {
		hash = await serverSourceHash(root);
		log(`Server source hash: ${hash}`);

		const vcpkg = await vcpkgVersion(root);
		if (!vcpkg) {
			log('package.json names no vcpkg version, so the cache is not asked.');
			return { hash, cached: false };
		}

		const missing = await missingEngines({ hash, vcpkg, repo, gh });
		for (const { platform, why } of missing) log(`${platform}: ${why}`);
		if (missing.length) return { hash, cached: false };

		const names = BUILT_PLATFORMS.map((platform) => platform.name).join(', ');
		log(`The engine cache has ${hash.slice(0, 16)} (vcpkg ${vcpkg}) for ${names}.`);
		return { hash, cached: true };
	} catch (error) {
		log(`::warning::The engine cache could not be checked, so the engine is built: ${error.message}`);
		return { hash, cached: false };
	}
}

/** Parse argv, check, and set the step outputs. */
async function main() {
	const args = process.argv.slice(2);
	const rootArg = args.find((a) => a.startsWith('--root='));
	const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;

	if (args.some((a) => !/^--root=./.test(a)) || !repo) {
		console.error('Usage: GH_REPO=owner/name engine-cache-check.mjs [--root=<repository>]');
		process.exitCode = 2;
		return;
	}

	const { hash, cached } = await check({ root: path.resolve(rootArg ? rootArg.slice('--root='.length) : '.'), repo });
	console.log(cached ? 'Nothing to build for the engine cache.' : 'The engine has to be built for the cache.');
	if (process.env.GITHUB_OUTPUT) {
		await fs.appendFile(process.env.GITHUB_OUTPUT, `server_hash=${hash}\nengine_cached=${cached}\n`);
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
