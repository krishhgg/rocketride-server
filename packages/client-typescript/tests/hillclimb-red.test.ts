// Fork only: this test fails on purpose, so the push's CI run goes red on every platform. HILLCLIMB-HARNESS

import { expect, it as test } from '@jest/globals';

test('engine cache experiment: one jest test that fails', () => {
	expect('red').toBe('green');
});
