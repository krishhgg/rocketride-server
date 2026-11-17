// HILLCLIMB-HARNESS
// Per-suite test reports for the CI hill climb on the fork. This whole file is
// harness: it is listed in the hill climb's harness.json and stays out of any
// upstream change.
//
// When HILLCLIMB_REPORT_DIR is set, execCommand passes every command through
// withTestReport(). A command that runs a test suite gets one more flag, so
// the suite also writes a structured report named after the builder task that
// ran it:
//   pytest     <dir>/<task>.pytest.xml    JUnit XML (--junitxml)
//   jest       <dir>/<task>.jest.json     jest's JSON results (--json --outputFile)
//   node:test  <dir>/<task>.nodetest.xml  JUnit XML from node's file reporter
//   Catch2     <dir>/<task>.catch2.xml    Catch2's JUnit reporter
// Console output stays as it was. With the variable unset nothing changes.

const fs = require('fs');
const path = require('path');

const CATCH2_BINARIES = new Set(['aptest', 'engtest', 'nodetest']);
const written = new Map();

/** File path for one suite's report. A task that runs twice gets `.2`, `.3`. */
function reportPath(dir, suite, suffix) {
	const base = String(suite).replace(/[^A-Za-z0-9._-]+/g, '-');
	const count = (written.get(base) || 0) + 1;
	written.set(base, count);
	return path.join(dir, count === 1 ? `${base}.${suffix}` : `${base}.${count}.${suffix}`);
}

/** Which runner a command line starts, or null when it is not a test suite. */
function detect(command, args) {
	const exe = String(command)
		.split(/[\\/]/)
		.pop()
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
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
	if (CATCH2_BINARIES.has(exe)) {
		return args.some((a) => a === '--reporter' || a === '-r') ? null : 'catch2';
	}
	return null;
}

/**
 * Return the arguments to run, with a report flag added for test suites.
 *
 * @param {string} command - The command execCommand was asked to run
 * @param {Array} args - Its arguments
 * @param {Object|null} task - The builder task, which carries the task name
 * @returns {Array} args unchanged, or a copy with the report flag added
 */
function withTestReport(command, args, task) {
	const dir = process.env.HILLCLIMB_REPORT_DIR;
	if (!dir || !Array.isArray(args)) return args;
	const list = args.map(String);
	const kind = detect(command, list);
	if (!kind) return args;

	// A suite with no task name still reports, under a name the oracle rejects.
	const suite = task?._hillclimbSuite || task?._logModule || `unnamed-${kind}`;
	fs.mkdirSync(dir, { recursive: true });

	if (kind === 'pytest') {
		return [...list, `--junitxml=${reportPath(dir, suite, 'pytest.xml')}`, '-o', 'junit_family=xunit1'];
	}
	if (kind === 'jest') {
		return [...list, '--json', `--outputFile=${reportPath(dir, suite, 'jest.json')}`];
	}
	if (kind === 'catch2') {
		return [...list, '--reporter', 'console', '--reporter', `junit::out=${reportPath(dir, suite, 'catch2.xml')}`];
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

module.exports = { withTestReport };
