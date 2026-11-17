// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tests for the engine-cache check. gh is replaced by a fake release, so
 * nothing reaches GitHub. The hash tests run the builder's real contentHash
 * (scripts/lib/fs.js) over a small tree.
 *
 * Run:
 *     node --test scripts/release/engine-cache-check.test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	BUILT_PLATFORMS,
	SOURCE_EXCLUDE,
	check,
	missingEngines,
	serverSourceHash,
	vcpkgVersion,
} from './engine-cache-check.mjs';
import { CACHE_FORMAT } from './engine-cache-package.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'owner/repo';
const HASH = 'a'.repeat(16) + 'b'.repeat(48);
const VCPKG = '2026.07.29';

/** A checkout with the builder's hash module, a server tree and a package.json. */
async function checkout({ vcpkg = VCPKG, source = 'int main() {}\n' } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-engine-check-'));
	await fs.mkdir(path.join(root, 'scripts', 'lib'), { recursive: true });
	await fs.copyFile(path.join(REPO_ROOT, 'scripts', 'lib', 'fs.js'), path.join(root, 'scripts', 'lib', 'fs.js'));
	await fs.mkdir(path.join(root, 'packages', 'server', 'engine', 'src'), { recursive: true });
	await fs.writeFile(path.join(root, 'packages', 'server', 'engine', 'src', 'main.cpp'), source);
	await fs.writeFile(path.join(root, 'packages', 'server', 'version.h'), '#define BUILD 1\n');
	await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(vcpkg ? { vcpkg: { version: vcpkg } } : {}));
	return root;
}

/**
 * A fake gh over an in-memory release that holds `hash` for `platforms`.
 * `manifest` changes what every manifest says, `drop` removes assets by name.
 */
function fakeGh({ hash = HASH, platforms = BUILT_PLATFORMS, manifest = {}, drop = [], exists = true } = {}) {
	const calls = [];
	const assets = [];
	const bodies = new Map();
	for (const { name, ext } of platforms) {
		const base = `rocketride-engine-${hash.slice(0, 16)}-${name}`;
		for (const file of [`${base}.${ext}`, `${base}.manifest.json`]) {
			if (drop.includes(file)) continue;
			const id = 100 + assets.length;
			assets.push({ id, name: file });
			bodies.set(id, {
				server: { buildHash: hash },
				vcpkg: { version: VCPKG },
				engineCache: { format: CACHE_FORMAT },
				...manifest,
			});
		}
	}
	const gh = async (args) => {
		calls.push(args);
		assert.equal(args[0], 'api');
		assert.ok(!args.includes('-X') && !args.includes('-f'), `a write: gh ${args.join(' ')}`);
		if (!exists) throw new Error('gh api: Not Found (HTTP 404)');
		if (args.includes('--paginate')) {
			return assets.map((a) => `${a.id}\t${a.name}\t2026-11-05T11:00:00Z\t0\t\n`).join('');
		}
		if (args.includes('Accept: application/octet-stream')) {
			return JSON.stringify(bodies.get(Number(args.at(-1).split('/').at(-1))));
		}
		return '4242\n';
	};
	return { gh, calls };
}

const quiet = () => {};

describe('what the check assumes about the repository', () => {
	it('leaves the same files out of the hash as server:download', async () => {
		const tasks = await fs.readFile(path.join(REPO_ROOT, 'packages', 'server', 'scripts', 'tasks.js'), 'utf8');
		const [, list] = tasks.match(/^const SOURCE_EXCLUDE = (\[[^\]]*\]);$/m) ?? [];
		assert.ok(list, 'SOURCE_EXCLUDE is no longer a one-line list in packages/server/scripts/tasks.js');
		assert.deepEqual(JSON.parse(list.replace(/'/g, '"')), SOURCE_EXCLUDE);
	});

	it('asks for the platforms the build matrix compiles', async () => {
		const build = await fs.readFile(path.join(REPO_ROOT, '.github', 'workflows', '_build.yaml'), 'utf8');
		const matrix = [...build.matchAll(/^ {10}- platform: (\S+)$/gm)].map((match) => match[1]);
		assert.deepEqual(matrix, ['ubuntu', 'windows', 'macos']);
		assert.match(build, /runner: macos-15\n/, 'the macOS runner changed: check that it is still arm64');
		assert.deepEqual(
			BUILT_PLATFORMS.map((platform) => platform.name),
			['linux-x64', 'win64', 'darwin-arm64']
		);
	});
});

describe('serverSourceHash', () => {
	it('hashes packages/server with the builder, without the generated version files', async () => {
		const root = await checkout();
		const hash = await serverSourceHash(root);
		assert.match(hash, /^[0-9a-f]{64}$/);

		await fs.writeFile(path.join(root, 'packages', 'server', 'version.h'), '#define BUILD 2\n');
		await fs.writeFile(path.join(root, 'packages', 'server', 'version.rc'), 'FILEVERSION 2\n');
		assert.equal(await serverSourceHash(root), hash);

		// A CRLF checkout is the same source
		await fs.writeFile(path.join(root, 'packages', 'server', 'engine', 'src', 'main.cpp'), 'int main() {}\r\n');
		assert.equal(await serverSourceHash(root), hash);

		await fs.writeFile(path.join(root, 'packages', 'server', 'engine', 'src', 'main.cpp'), 'int main() { }\n');
		assert.notEqual(await serverSourceHash(root), hash);
	});

	it('refuses a checkout without packages/server', async () => {
		const root = await checkout();
		await fs.rm(path.join(root, 'packages'), { recursive: true });
		await assert.rejects(serverSourceHash(root), /did not hash to a SHA-256/);
	});
});

describe('vcpkgVersion', () => {
	it('reads the version from package.json, and has no default of its own', async () => {
		assert.equal(await vcpkgVersion(await checkout()), VCPKG);
		assert.equal(await vcpkgVersion(await checkout({ vcpkg: null })), null);
	});
});

describe('missingEngines', () => {
	const ask = (fake) => missingEngines({ hash: HASH, vcpkg: VCPKG, repo: REPO, gh: fake.gh });

	it('finds nothing missing when every platform has its archive and a matching manifest', async () => {
		const fake = fakeGh();
		assert.deepEqual(await ask(fake), []);
		// The release id, the asset list, and one manifest per platform: reads only
		assert.equal(fake.calls.length, 2 + BUILT_PLATFORMS.length);
	});

	it('names a platform the cache does not have', async () => {
		const missing = await ask(fakeGh({ platforms: BUILT_PLATFORMS.slice(0, 2) }));
		assert.deepEqual(
			missing.map((m) => m.platform),
			['darwin-arm64']
		);
	});

	it('names a platform whose archive or manifest is gone', async () => {
		const base = `rocketride-engine-${HASH.slice(0, 16)}`;
		const missing = await ask(fakeGh({ drop: [`${base}-win64.zip`, `${base}-linux-x64.manifest.json`] }));
		assert.deepEqual(missing, [
			{ platform: 'linux-x64', why: `no manifest beside ${base}-linux-x64.tar.gz` },
			{ platform: 'win64', why: `no ${base}-win64.zip` },
		]);
	});

	it('does not take another source for this one because 16 characters match', async () => {
		const other = HASH.slice(0, 16) + 'c'.repeat(48);
		const missing = await ask(fakeGh({ manifest: { server: { buildHash: other } } }));
		assert.equal(missing.length, 3);
		assert.match(missing[0].why, /is for a{16}c{48}$/);
	});

	it('does not take an engine built with another vcpkg', async () => {
		const missing = await ask(fakeGh({ manifest: { vcpkg: { version: '2024.11.16' } } }));
		assert.equal(missing.length, 3);
		assert.match(missing[0].why, /was built with vcpkg 2024\.11\.16$/);
	});

	it('does not take a full archive, or one an older packer made', async () => {
		const full = await ask(fakeGh({ manifest: { engineCache: undefined } }));
		assert.equal(full.length, 3);
		assert.match(full[0].why, /has archive format none, not \d+$/);

		const older = await ask(fakeGh({ manifest: { engineCache: { format: CACHE_FORMAT - 1 } } }));
		assert.equal(older.length, 3);
	});
});

describe('check', () => {
	it('says cached when the cache has the engine of this checkout for every platform', async () => {
		const root = await checkout();
		const hash = await serverSourceHash(root);
		const lines = [];

		const result = await check({ root, repo: REPO, gh: fakeGh({ hash }).gh, log: (line) => lines.push(line) });

		assert.deepEqual(result, { hash, cached: true });
		assert.match(lines.at(-1), /^The engine cache has [0-9a-f]{16} \(vcpkg 2026\.07\.29\) for linux-x64, win64, /);
	});

	it('says not cached after a change under packages/server', async () => {
		const before = await serverSourceHash(await checkout());
		const root = await checkout({ source: 'int main() { return 1; }\n' });

		const result = await check({ root, repo: REPO, gh: fakeGh({ hash: before }).gh, log: quiet });

		assert.equal(result.cached, false);
		assert.notEqual(result.hash, before);
	});

	it('says not cached when one platform is missing', async () => {
		const root = await checkout();
		const hash = await serverSourceHash(root);
		const fake = fakeGh({ hash, platforms: BUILT_PLATFORMS.slice(1) });
		assert.deepEqual(await check({ root, repo: REPO, gh: fake.gh, log: quiet }), { hash, cached: false });
	});

	it('says not cached, without asking, when package.json names no vcpkg version', async () => {
		const root = await checkout({ vcpkg: null });
		const fake = fakeGh({ hash: await serverSourceHash(root) });
		const result = await check({ root, repo: REPO, gh: fake.gh, log: quiet });
		assert.equal(result.cached, false);
		assert.deepEqual(fake.calls, []);
	});

	it('says not cached, with a warning and the hash, when the release cannot be read', async () => {
		const root = await checkout();
		const lines = [];
		const result = await check({
			root,
			repo: REPO,
			gh: fakeGh({ exists: false }).gh,
			log: (line) => lines.push(line),
		});
		assert.deepEqual(result, { hash: await serverSourceHash(root), cached: false });
		assert.match(lines.at(-1), /^::warning::The engine cache could not be checked, so the engine is built: /);
	});

	it('says not cached, with no hash, when the checkout cannot be hashed', async () => {
		const root = await checkout();
		await fs.rm(path.join(root, 'scripts'), { recursive: true });
		const lines = [];
		const result = await check({ root, repo: REPO, gh: fakeGh().gh, log: (line) => lines.push(line) });
		assert.deepEqual(result, { hash: '', cached: false });
		assert.match(lines.at(-1), /^::warning::/);
	});
});
