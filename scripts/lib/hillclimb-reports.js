// HILLCLIMB-HARNESS
// Per-suite test reports for the CI hill climb on the fork. This whole file is
// harness: it is listed in the hill climb's harness.json and stays out of any
// upstream change.
//
// When HILLCLIMB_REPORT_DIR is set, execCommand passes every command through
// withTestReport(). A command that runs a test suite gets one more flag, so
// the suite also writes a structured report named after the builder task that
// ran it, with `__` for the task name's colon (ai:run-pytest gives
// ai__run-pytest.pytest.xml):
//   pytest     <dir>/<task>.pytest.xml    JUnit XML (--junitxml)
//   jest       <dir>/<task>.jest.json     jest's JSON results (--json --outputFile)
//   node:test  <dir>/<task>.nodetest.xml  JUnit XML from node's file reporter
//   Catch2     <dir>/<task>.catch2.xml    Catch2's XML reporter (results per test case)
//   vitest     <dir>/<task>.vitest.xml    JUnit XML from vitest's junit reporter
//   Maven      <dir>/<task>.surefire.xml  Surefire's JUnit XML, one file for the task
// engtest takes Catch2 flags only as the words of its --testArgs option, so
// its reporter flags go inside that one argument.
// Surefire has no flag for its report folder. For `mvn test` the module only
// notes where Surefire writes and when the command started. The workflow step
// `Collect test reports` then runs this file with `collect`, which joins the
// TEST-*.xml files written since that time into the task's one report.
// A task that starts its runner twice (nodes:run-pytest, docs:validate) writes
// a second file, <task>.2.<kind>.xml. `collect` joins the JUnit ones into the
// task's first file, so every suite ends with exactly one report. It also
// sets the run name in each Catch2 file to the task's name.
// Console output stays as it was. With the variable unset nothing changes.

const fs = require('fs');
const path = require('path');

const CATCH2_BINARIES = new Set(['aptest', 'engtest', 'nodetest']);
const BUILD_DIR_FLAG = '-Drocketride.build.dir=';
// Notes for `collect`. upload-artifact leaves out folders that start with a dot.
const PENDING = '.pending';
const written = new Map();

/** File path for one suite's report. A second runner call in a task gets `.2`, which `collect` joins. */
function reportPath(dir, suite, suffix) {
	// The reader cuts the name at the first dot and turns `__` back into a colon.
	const base = String(suite)
		.replace(/:/g, '__')
		.replace(/[^A-Za-z0-9_-]+/g, '-');
	const count = (written.get(base) || 0) + 1;
	written.set(base, count);
	return path.join(dir, count === 1 ? `${base}.${suffix}` : `${base}.${count}.${suffix}`);
}

/** The command's file name in lower case, without its folder or Windows extension. */
function exeName(command) {
	return String(command)
		.split(/[\\/]/)
		.pop()
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

/** The package.json script that `pnpm run <script>` starts in cwd, or '' when it cannot be read. */
function pnpmScript(args, cwd) {
	if (args[0] !== 'run' || !args[1] || !cwd) return '';
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
		return String(pkg.scripts?.[args[1]] || '');
	} catch {
		return '';
	}
}

/** Which runner a command line starts, or null when it is not a test suite. */
function detect(command, args, cwd) {
	const exe = exeName(command);
	if (args[0] === '-m' && args[1] === 'pytest') {
		const skip = args.some((a) => a === '--collect-only' || a === '--co' || a.startsWith('--junitxml'));
		return skip ? null : 'pytest';
	}
	if (exe === 'npx' && args[0] === 'jest') {
		return args.some((a) => a === '--json' || a.startsWith('--outputFile')) ? null : 'jest';
	}
	if (exe === 'node' && args.includes('--test')) {
		return args.some((a) => a.startsWith('--test-reporter=junit')) ? null : 'nodetest';
	}
	if (exe === 'pnpm') {
		const script = pnpmScript(args, cwd);
		if (!/^vitest( run)?( |$)/.test(script)) return null;
		return [script, ...args].some((a) => /--reporter|--outputFile/.test(a)) ? null : 'vitest';
	}
	if (exe === 'mvn') {
		return args.includes('test') ? 'surefire' : null;
	}
	if (CATCH2_BINARIES.has(exe)) {
		const words = args.flatMap((a) => (a.startsWith('--testArgs=') ? a.slice(11).split(/\s+/) : [a]));
		return words.some((a) => a === '--reporter' || a === '-r') ? null : 'catch2';
	}
	return null;
}

/**
 * Return the arguments to run, with a report flag added for test suites.
 *
 * @param {string} command - The command execCommand was asked to run
 * @param {Array} args - Its arguments
 * @param {Object|null} task - The builder task, which carries the task name
 * @param {string} [cwd] - The command's working directory, read for `pnpm run`
 * @returns {Array} args unchanged, or a copy with the report flag added
 */
function withTestReport(command, args, task, cwd) {
	const dir = process.env.HILLCLIMB_REPORT_DIR;
	if (!dir || !Array.isArray(args)) return args;
	const list = args.map(String);
	const kind = detect(command, list, cwd);
	if (!kind) return args;

	// A suite with no task name still reports, under a name the oracle rejects.
	const suite = task?._hillclimbSuite || task?._logModule || `unnamed-${kind}`;
	fs.mkdirSync(dir, { recursive: true });

	if (kind === 'surefire') {
		const build = list.find((a) => a.startsWith(BUILD_DIR_FLAG));
		const target = build ? build.slice(BUILD_DIR_FLAG.length) : path.join(cwd || '.', 'target');
		const to = reportPath(dir, suite, 'surefire.xml');
		const note = { from: path.join(target, 'surefire-reports'), since: Date.now(), to };
		fs.mkdirSync(path.join(dir, PENDING), { recursive: true });
		fs.writeFileSync(path.join(dir, PENDING, `${path.basename(to)}.json`), JSON.stringify(note));
		return args;
	}
	if (kind === 'pytest') {
		return [...list, `--junitxml=${reportPath(dir, suite, 'pytest.xml')}`, '-o', 'junit_family=xunit1'];
	}
	if (kind === 'jest') {
		return [...list, '--json', `--outputFile=${reportPath(dir, suite, 'jest.json')}`];
	}
	if (kind === 'vitest') {
		// pnpm hands every argument after the script name to the script. Naming a
		// reporter replaces vitest's defaults, so those are named again here.
		const file = reportPath(dir, suite, 'vitest.xml').replace(/\\/g, '/');
		const defaults = ['--reporter=default'];
		if (process.env.GITHUB_ACTIONS === 'true') defaults.push('--reporter=github-actions');
		return [...list, ...defaults, '--reporter=junit', `--outputFile.junit=${file}`];
	}
	if (kind === 'catch2') {
		const file = reportPath(dir, suite, 'catch2.xml');
		// Catch2 3 takes several reporters: console keeps the log as it was, and
		// the XML reporter writes a result for every test case and section.
		const flags = ['--reporter', 'console', '--reporter', `xml::out=${file}`];
		if (exeName(command) !== 'engtest') return [...list, ...flags];
		// engtest splits --testArgs on whitespace, so a path with a space cannot be passed.
		if (/\s/.test(file)) return args;
		const at = list.findIndex((a) => a.startsWith('--testArgs='));
		if (at === -1) return [...list, `--testArgs=${flags.join(' ')}`];
		return list.map((a, i) => (i === at ? `${a} ${flags.join(' ')}` : a));
	}

	// node:test pairs each --test-reporter with a --test-reporter-destination
	// in order, so the reporter already there gets `stdout` before the file
	// reporter is added. Node options must come before the test files.
	const junit = ['--test-reporter=junit', `--test-reporter-destination=${reportPath(dir, suite, 'nodetest.xml')}`];
	const out = [...list];
	const first = out.findIndex((a) => a.startsWith('--test-reporter='));
	if (first === -1) {
		const spec = ['--test-reporter=spec', '--test-reporter-destination=stdout'];
		out.splice(out.indexOf('--test') + 1, 0, ...spec, ...junit);
		return out;
	}
	const paired = (out[first + 1] || '').startsWith('--test-reporter-destination');
	if (!paired) out.splice(first + 1, 0, '--test-reporter-destination=stdout');
	out.splice(first + 2, 0, ...junit);
	return out;
}

/** Write the JUnit files as one document: every file's suites under a single <testsuites>. */
function joinJUnit(files, to) {
	const parts = files.map((file) =>
		fs
			.readFileSync(file, 'utf8')
			.replace(/^\uFEFF/, '')
			.replace(/^\s*<\?xml[^>]*\?>/, '')
			.replace(/^\s*<testsuites\b[^>]*>/, '')
			.replace(/<\/testsuites>\s*$/, '')
			.trim()
	);
	fs.writeFileSync(to, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${parts.join('\n')}\n</testsuites>\n`);
}

/** Surefire's TEST-*.xml files in a folder, written at or after a time. */
function surefireFiles(from, since) {
	if (!fs.existsSync(from)) return [];
	return fs
		.readdirSync(from)
		.filter((name) => /^TEST-.*\.xml$/.test(name))
		.sort()
		.map((name) => path.join(from, name))
		.filter((file) => fs.statSync(file).mtimeMs >= since);
}

/**
 * Give each Catch2 XML report the task's name as its run name.
 *
 * Catch2 writes the executable name it was handed. engtest and nodetest hand it
 * bytes from freed memory, and Catch2 lets some characters through that XML
 * forbids, so the file does not always parse. The bytes are read as latin1 so
 * nothing else in the file changes.
 */
function nameCatch2Runs(dir) {
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith('.catch2.xml')) continue;
		try {
			const file = path.join(dir, name);
			const suite = name.split('.')[0].replace(/__/g, ':');
			const text = fs.readFileSync(file, 'latin1');
			const named = text.replace(/(<Catch2TestRun name=")[^"]*(")/, (_all, open, close) => open + suite + close);
			if (named !== text) fs.writeFileSync(file, named, 'latin1');
		} catch (err) {
			console.log(`::warning::could not name the Catch2 run in ${name}: ${err.message}`);
		}
	}
}

/** Join <task>.2.<kind>.xml, .3 and so on into <task>.<kind>.xml, for the JUnit kinds a runner writes. */
function joinNumbered(dir) {
	const groups = new Map();
	for (const name of fs.readdirSync(dir).sort()) {
		const m = /^([^.]+)\.(\d+)\.((?:pytest|nodetest|vitest)\.xml)$/.exec(name);
		if (!m) continue;
		const first = `${m[1]}.${m[3]}`;
		groups.set(first, [...(groups.get(first) || []), { n: Number(m[2]), name }]);
	}
	for (const [first, rest] of groups) {
		try {
			const extra = rest.sort((a, b) => a.n - b.n).map((r) => path.join(dir, r.name));
			const to = path.join(dir, first);
			joinJUnit(fs.existsSync(to) ? [to, ...extra] : extra, to);
			for (const file of extra) fs.rmSync(file);
			console.log(`${first}: joined ${extra.length} more file(s) of the same task`);
		} catch (err) {
			console.log(`::warning::could not join the reports of ${first}: ${err.message}`);
		}
	}
}

/**
 * Finish the report folder after the test steps, then list what it holds.
 *
 * A problem with one report is printed as a warning and never fails the step.
 *
 * @param {string} dir - The report folder (HILLCLIMB_REPORT_DIR)
 */
function collectReports(dir) {
	if (!dir || !fs.existsSync(dir)) {
		console.log('No report folder, nothing to collect');
		return;
	}
	const pending = path.join(dir, PENDING);
	const notes = fs.existsSync(pending) ? fs.readdirSync(pending).sort() : [];
	for (const name of notes) {
		try {
			const note = JSON.parse(fs.readFileSync(path.join(pending, name), 'utf8'));
			// Two seconds of slack for file systems that round a file's time down.
			const files = surefireFiles(note.from, note.since - 2000);
			console.log(`${path.basename(note.to)}: ${files.length} Surefire file(s) in ${note.from}`);
			if (files.length) joinJUnit(files, note.to);
		} catch (err) {
			console.log(`::warning::could not collect ${name}: ${err.message}`);
		}
	}
	fs.rmSync(pending, { recursive: true, force: true });
	nameCatch2Runs(dir);
	joinNumbered(dir);
	for (const name of fs.readdirSync(dir).sort()) {
		console.log(`${String(fs.statSync(path.join(dir, name)).size).padStart(10)}  ${name}`);
	}
}

if (require.main === module) {
	if (process.argv[2] !== 'collect') {
		console.error('Usage: node scripts/lib/hillclimb-reports.js collect');
		process.exit(2);
	}
	collectReports(process.env.HILLCLIMB_REPORT_DIR);
}

module.exports = { withTestReport, collectReports };
