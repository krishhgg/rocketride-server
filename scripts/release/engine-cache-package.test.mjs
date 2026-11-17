// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tests for the engine-cache packer. The archive writer is replaced by one
 * that records its arguments, so nothing is compressed.
 *
 * Run:
 *     node --test scripts/release/engine-cache-package.test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CACHE_FORMAT, packageEngine, platformInfo, selectEntries } from './engine-cache-package.mjs';

const HASH = 'a'.repeat(16) + 'b'.repeat(48);
const ROOT = '/home/runner/work/rocketride-server/rocketride-server';

/** The package state of a Linux build, cut down to one source of each kind. */
function linuxState(root = ROOT) {
	return {
		[`${root}/build/engine/engine`]: ['engine'],
		[`${root}/build/vcpkg_installed/x64-linux-clang-rocketride/lib`]: ['lib/libssl.so'],
		[`${root}/packages/server/engine-lib/rocketlib-python/lib`]: ['lib/python3.12/rocketlib/__init__.py'],
		[`${root}/packages/client-python/src/rocketride`]: ['rocketride/__init__.py'],
		[`${root}/build/apps/rocketride.sql`]: ['static/apps/sql/index.html'],
		[`${root}/packages/ai/src/ai`]: ['ai/__init__.py', 'ai/removed_later.py'],
		[`${root}/nodes/src/nodes/hash`]: ['nodes/hash/services.json', 'nodes/hash/removed_later.py'],
		[`${root}/build/nodes/hash/libhash.so`]: ['nodes/hash/libhash.so'],
		[`${root}/build/java/jre`]: ['java/jre/bin/java', 'java/jre/lib/modules'],
		[`${root}/build/java/core/rocketride-core-1.0.jar`]: ['java/lib/rocketride-core.jar'],
		[`${root}/build/java/core/dependency`]: ['java/lib/log4j-api-2.25.2.jar', 'java/lib/log4j-core-2.25.2.jar'],
		[`${root}/build/java/dbgconn/rocketride-dbgconn-2.0.jar`]: ['java/lib/rocketride-dbgconn.jar'],
		[`${root}/nodes/src/nodes/parse/lib/parse/tika-config.xml`]: ['java/tika-config.xml'],
		[`${root}/build/parse/rocketride-parse.jar`]: ['java/lib/rocketride-parse.jar'],
		[`${root}/build/parse/dependency`]: ['java/lib/tika-core-3.2.3.jar', 'java/lib/pdfbox-3.0.5.jar'],
	};
}

/** A repository root with the two files the packer reads. */
async function buildRoot(state) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-engine-package-'));
	await fs.mkdir(path.join(root, 'build'));
	await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '3.6.0' }));
	if (state) await fs.writeFile(path.join(root, 'build', 'state.json'), JSON.stringify(state));
	return root;
}

describe('platformInfo', () => {
	it('names the platforms as the builder does', () => {
		assert.deepEqual(platformInfo('linux', 'x64'), { name: 'linux-x64', ext: 'tar.gz' });
		assert.deepEqual(platformInfo('win32', 'x64'), { name: 'win64', ext: 'zip' });
		assert.deepEqual(platformInfo('darwin', 'arm64'), { name: 'darwin-arm64', ext: 'tar.gz' });
		assert.deepEqual(platformInfo('darwin', 'x64'), { name: 'darwin-x64', ext: 'tar.gz' });
		assert.throws(() => platformInfo('freebsd', 'x64'), /Unsupported platform/);
	});
});

describe('selectEntries', () => {
	it('leaves out what a downloading build makes again, and nothing else', () => {
		const { kept, dropped } = selectEntries(linuxState(), ROOT);

		assert.deepEqual(Object.keys(dropped), [
			`${ROOT}/packages/ai/src/ai`,
			`${ROOT}/nodes/src/nodes/hash`,
			`${ROOT}/build/java/core/rocketride-core-1.0.jar`,
			`${ROOT}/build/java/core/dependency`,
			`${ROOT}/build/java/dbgconn/rocketride-dbgconn-2.0.jar`,
			`${ROOT}/nodes/src/nodes/parse/lib/parse/tika-config.xml`,
			`${ROOT}/build/parse/rocketride-parse.jar`,
			`${ROOT}/build/parse/dependency`,
		]);
		const files = Object.values(kept).flat();
		assert.ok(!files.some((file) => file.includes('removed_later')));
		assert.deepEqual(files, [
			'engine',
			'lib/libssl.so',
			'lib/python3.12/rocketlib/__init__.py',
			'rocketride/__init__.py',
			'static/apps/sql/index.html',
			'nodes/hash/libhash.so',
			'java/jre/bin/java',
			'java/jre/lib/modules',
		]);
	});

	it('leaves out every jar a downloading build makes with Maven, and keeps the JRE', () => {
		// A consumer with the same server hash and an upgraded dependency would
		// otherwise keep the archive's log4j-core-2.25.2.jar beside its own
		const { kept, dropped } = selectEntries(linuxState(), ROOT);
		const files = Object.values(kept).flat();

		assert.deepEqual(
			files.filter((file) => file.startsWith('java/')),
			['java/jre/bin/java', 'java/jre/lib/modules']
		);
		assert.ok(!files.some((file) => file.endsWith('.jar')));
		assert.deepEqual(
			Object.values(dropped)
				.flat()
				.filter((file) => file.startsWith('java/'))
				.sort(),
			[
				'java/lib/log4j-api-2.25.2.jar',
				'java/lib/log4j-core-2.25.2.jar',
				'java/lib/pdfbox-3.0.5.jar',
				'java/lib/rocketride-core.jar',
				'java/lib/rocketride-dbgconn.jar',
				'java/lib/rocketride-parse.jar',
				'java/lib/tika-core-3.2.3.jar',
				'java/tika-config.xml',
			]
		);
	});

	it('refuses a state with a jar staged from a source it does not know', () => {
		// A renamed Maven build directory must not bring the jars back
		const state = linuxState();
		delete state[`${ROOT}/build/parse/dependency`];
		state[`${ROOT}/build/tika/dependency`] = ['java/lib/tika-core-3.2.3.jar'];
		assert.throws(() => selectEntries(state, ROOT), /java\/lib\/tika-core-3\.2\.3\.jar is staged from a source/);

		// Nor may anything else join dist/server/java unnoticed
		const other = { ...linuxState(), [`${ROOT}/packages/java/conf`]: ['java/conf/logging.xml'] };
		assert.throws(() => selectEntries(other, ROOT), /java\/conf\/logging\.xml is staged from a source/);
	});

	it('keeps a file from a Maven build directory that lands outside java/lib', () => {
		const state = { ...linuxState(), [`${ROOT}/build/parse/native`]: ['lib/libtika-native.so'] };
		const { kept } = selectEntries(state, ROOT);
		assert.deepEqual(kept[`${ROOT}/build/parse/native`], ['lib/libtika-native.so']);
	});

	it('keeps a compiled node library, which lands beside the node source', () => {
		const { kept } = selectEntries(linuxState(), ROOT);
		assert.deepEqual(kept[`${ROOT}/build/nodes/hash/libhash.so`], ['nodes/hash/libhash.so']);
	});

	it('keeps a node source that stages outside nodes/ and outside java/', () => {
		const state = { ...linuxState(), [`${ROOT}/nodes/src/nodes/hash/data/table.bin`]: ['lib/hash-table.bin'] };
		const { kept } = selectEntries(state, ROOT);
		assert.deepEqual(kept[`${ROOT}/nodes/src/nodes/hash/data/table.bin`], ['lib/hash-table.bin']);
	});

	it('reads a Windows state: backslashes, and a drive letter in either case', () => {
		const state = {
			'D:\\a\\rr\\rr\\build\\engine\\Release\\engine.exe': ['engine.exe'],
			'D:\\a\\rr\\rr\\packages\\ai\\src\\ai': ['ai\\__init__.py', 'ai\\common\\removed_later.py'],
			'D:\\a\\rr\\rr\\nodes\\src\\nodes\\hash': ['nodes\\hash\\services.json'],
			'D:\\a\\rr\\rr\\build\\nodes\\hash\\hash.dll': ['nodes\\hash\\hash.dll'],
			'D:\\a\\rr\\rr\\build\\java\\jre': ['java\\jre\\bin\\java.exe'],
			'D:\\a\\rr\\rr\\build\\java\\core\\dependency': ['java\\lib\\log4j-core-2.25.2.jar'],
			'D:\\a\\rr\\rr\\build\\parse\\rocketride-parse.jar': ['java\\lib\\rocketride-parse.jar'],
		};
		const { kept, dropped } = selectEntries(state, 'd:\\a\\rr\\rr');

		assert.deepEqual(Object.values(kept).flat(), [
			'engine.exe',
			'nodes\\hash\\hash.dll',
			'java\\jre\\bin\\java.exe',
		]);
		assert.equal(Object.keys(dropped).length, 4);
	});

	it('does not take a sibling directory for one of the trees', () => {
		const state = { ...linuxState(), [`${ROOT}/packages/ai/src-extra`]: ['ai/extra.py'] };
		const { kept } = selectEntries(state, ROOT);
		assert.deepEqual(kept[`${ROOT}/packages/ai/src-extra`], ['ai/extra.py']);
	});

	it('refuses a state in which one of the trees is missing', () => {
		const state = linuxState();
		delete state[`${ROOT}/packages/ai/src/ai`];
		assert.throws(() => selectEntries(state, ROOT), /nothing staged from packages\/ai\/src/);

		// The same state read from another root matches no tree at all
		assert.throws(() => selectEntries(linuxState(), '/somewhere/else'), /nothing staged from/);
	});
});

describe('packageEngine', () => {
	it('writes the marker, then the archive without what a build makes again, then the manifest', async () => {
		const root = await buildRoot();
		const state = {
			server: { buildHash: HASH, releases: { cached: true } },
			vcpkg: { version: '2026.07.29' },
			nodes: { hash: { buildHash: 'c'.repeat(64), buildType: 'Release', from: 'local' } },
			package: linuxState(root),
		};
		await fs.writeFile(path.join(root, 'build', 'state.json'), JSON.stringify(state));
		const out = path.join(root, 'dist', 'engine-cache');

		const calls = [];
		const archive = async (file, cwd, files) => {
			// The marker is there before the archive is made, the manifest is not
			calls.push({ file, cwd, files, before: (await fs.readdir(out)).sort() });
			await fs.writeFile(file, 'archive');
		};
		const result = await packageEngine({
			root,
			out,
			platform: platformInfo('linux', 'x64'),
			archive,
			log: () => {},
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].cwd, path.join(root, 'dist', 'server'));
		assert.deepEqual(calls[0].before, ['engine-tested-linux-x64.json']);
		assert.ok(calls[0].files.includes('nodes/hash/libhash.so'));
		assert.ok(!calls[0].files.some((file) => file.startsWith('ai/') || file.includes('removed_later')));
		assert.ok(!calls[0].files.some((file) => file.startsWith('java/lib/') || file === 'java/tika-config.xml'));
		assert.ok(calls[0].files.includes('java/jre/bin/java'));
		assert.deepEqual(result, {
			platform: 'linux-x64',
			hash: HASH,
			archive: path.join(out, 'rocketride-server-v3.6.0-linux-x64.tar.gz'),
			manifest: path.join(out, 'rocketride-server-v3.6.0-linux-x64.manifest.json'),
			files: 8,
			left: 12,
		});

		assert.deepEqual((await fs.readdir(out)).sort(), [
			'engine-tested-linux-x64.json',
			'rocketride-server-v3.6.0-linux-x64.manifest.json',
			'rocketride-server-v3.6.0-linux-x64.tar.gz',
		]);
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'engine-tested-linux-x64.json'), 'utf8')), {
			platform: 'linux-x64',
			buildHash: HASH,
		});

		// What server:download reads is unchanged; the package state is the archive's
		const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
		assert.equal(manifest.server.buildHash, HASH);
		assert.equal(manifest.server.releases, undefined);
		assert.deepEqual(manifest.engineCache, { format: CACHE_FORMAT });
		assert.deepEqual(manifest.vcpkg, state.vcpkg);
		assert.deepEqual(manifest.nodes, state.nodes);
		assert.equal(manifest.package[`${root}/packages/ai/src/ai`], undefined);
		assert.equal(manifest.package[`${root}/build/parse/dependency`], undefined);
		assert.deepEqual(manifest.package[`${root}/build/java/jre`], ['java/jre/bin/java', 'java/jre/lib/modules']);
		assert.deepEqual(manifest.package[`${root}/build/engine/engine`], ['engine']);
	});

	it('leaves the marker and no manifest when the archive cannot be written', async () => {
		const root = await buildRoot();
		const state = { server: { buildHash: HASH }, package: linuxState(root) };
		await fs.writeFile(path.join(root, 'build', 'state.json'), JSON.stringify(state));
		const out = path.join(root, 'out');
		const archive = async () => {
			throw new Error('disk full');
		};

		await assert.rejects(
			packageEngine({ root, out, platform: platformInfo('win32', 'x64'), archive, log: () => {} }),
			/disk full/
		);
		assert.deepEqual(await fs.readdir(out), ['engine-tested-win64.json']);
	});

	it('writes nothing for a state without a usable hash', async () => {
		const root = await buildRoot({ server: { buildHash: 'abc' }, package: linuxState() });
		const out = path.join(root, 'out');

		await assert.rejects(packageEngine({ root, out, archive: async () => {}, log: () => {} }), /server.buildHash/);
		await assert.rejects(fs.readdir(out), /ENOENT/);
	});
});
