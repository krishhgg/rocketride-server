# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Install requirement files through depends() before the test suites start.

Usage: engine preinstall_deps.py REQUIREMENTS_FILE [REQUIREMENTS_FILE ...]

Each file goes through depends(), the call a node makes when it loads, so the
engine's constraints, overrides, excludes and hooks apply exactly as they do
then. A file that cannot be installed is reported and the rest still install:
the node's own depends() call raises the same error when something loads it,
so a broken node fails where it fails today and does not stop unrelated suites.
"""

import sys
import time

from depends import depends


def main(paths: list[str]) -> int:
    """Run depends() on each file in order and print a summary; always return 0."""
    start = time.monotonic()
    failed = []
    for path in paths:
        try:
            depends(path)
        except Exception as e:  # noqa: BLE001 - reported here, raised again where the node loads
            failed.append(path)
            print(f'Could not pre-install {path}: {e}', flush=True)

    elapsed = time.monotonic() - start
    print(f'Pre-installed {len(paths) - len(failed)} of {len(paths)} requirement files in {elapsed:.0f}s', flush=True)
    for path in failed:
        print(f'  not installed: {path}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
