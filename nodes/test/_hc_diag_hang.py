# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Diagnostic only, not for merging: show what a stuck xdist worker is doing.

Some Windows nodes:run-pytest jobs hang before any test starts: pytest-xdist
prints `created: 4/4 workers` and never `N workers [M items]`, and the job
sits silent until its timeout.

An xdist worker's own output does not reach the job log while it collects
(pytest captures it), so the work is split:

- Each worker, at import, arms faulthandler and a timer. If it is still
  collecting after HC_DIAG_FIRST seconds (600 by default), faulthandler
  writes every thread's C-level stack into `<worker>-<pid>.fault.txt`, and
  the timer writes every Python thread's stack, the state of depends()'s
  install lock and its progress sidecar into `<worker>-<pid>.txt`, both in
  RUNNER_TEMP/hc-diag (faulthandler's file is written even when no Python
  thread can run). It repeats every 600 seconds, at most 6 times.
- The controller prints, through pytest's terminal reporter (the channel of
  `created: 4/4 workers`), one line per worker when it finishes collecting,
  and, while any worker has not, every worker's dump files plus the uv, pip,
  python and engine processes, 60 seconds after each worker dump.

Every printed line starts with `HC-DIAG`.
"""

import faulthandler
import glob
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback

_WORKER = os.environ.get('PYTEST_XDIST_WORKER')
_FIRST = float(os.environ.get('HC_DIAG_FIRST', '600'))
_EVERY = 600.0
_TIMES = 6
_T0 = time.monotonic()
_DIR = os.path.join(os.environ.get('RUNNER_TEMP') or tempfile.gettempdir(), 'hc-diag')
_done = threading.Event()
_fault = None


# ----------------------------------------------------------------------------- worker


def _stacks(out):
    """Write the stack of every Python thread but this one."""
    names = {t.ident: t.name for t in threading.enumerate()}
    for ident, frame in sys._current_frames().items():
        if ident == threading.get_ident():
            continue
        out.append(f'thread {names.get(ident, "?")} ({ident}):')
        for entry in traceback.format_stack(frame):
            out.extend('  ' + line[:400] for line in entry.rstrip().splitlines())


def _lock_state(out):
    """Write the install lock, its progress sidecar and this process's part."""
    dep = sys.modules.get('depends')
    if dep is None:
        out.append('depends is not imported in this process')
        return
    try:
        cache = dep.engine_cache_dir()
    except Exception as e:  # noqa: BLE001
        out.append(f'engine_cache_dir failed: {e!r}')
        return
    for name in ('install.lock', 'install.progress'):
        path = os.path.join(cache, name)
        try:
            st = os.stat(path)
        except OSError:
            out.append(f'{name}: absent')
            continue
        try:
            with open(path, 'rb') as f:
                data = f.read(300)
        except OSError as e:
            data = f'unreadable: {e!r}'
        out.append(f'{name}: size={st.st_size} age={time.time() - st.st_mtime:.0f}s data={data!r}')
    out.append(
        f'this process holds the lock: {bool(getattr(dep, "_progress_path", None))}; '
        f'last progress: {getattr(dep, "_last_sidecar_message", None)!r}; '
        f'requirements done here: {len(getattr(dep, "_processed", ()))}'
    )


def _watch_worker():
    """Write a dump file while this worker is still collecting."""
    if _done.wait(_FIRST):
        return
    path = os.path.join(_DIR, f'{_WORKER}-{os.getpid()}.txt')
    for i in range(_TIMES):
        out = [f'still collecting after {time.monotonic() - _T0:.0f}s (dump {i + 1} of {_TIMES})']
        for part in (_stacks, _lock_state):
            try:
                part(out)
            except Exception as e:  # noqa: BLE001
                out.append(f'{part.__name__} failed: {e!r}')
        try:
            with open(path, 'a', encoding='utf-8') as f:
                f.write('\n'.join(out) + '\n')
        except OSError:
            pass
        if _done.wait(_EVERY):
            return


def _arm_worker():
    """Start faulthandler's dump and the timer in an xdist worker."""
    global _fault
    try:
        os.makedirs(_DIR, exist_ok=True)
        _fault = open(os.path.join(_DIR, f'{_WORKER}-{os.getpid()}.fault.txt'), 'w')
        faulthandler.dump_traceback_later(_FIRST, repeat=True, file=_fault)
    except Exception:  # noqa: BLE001
        pass
    threading.Thread(target=_watch_worker, name='hc-diag', daemon=True).start()


def pytest_collection_finish(session):  # noqa: ARG001
    """Stop the dumps once this worker has collected."""
    _done.set()
    try:
        faulthandler.cancel_dump_traceback_later()
    except Exception:  # noqa: BLE001
        pass


# ----------------------------------------------------------------------------- controller


def _processes():
    """The uv, pip, python and engine processes, one line each."""
    if os.name == 'nt':
        script = (
            'Get-CimInstance Win32_Process | '
            "Where-Object { $_.Name -match '^(uv|pip|python|engine)' } | "
            "ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, "
            '$_.CreationDate, $_.CommandLine }'
        )
        cmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
    else:
        cmd = ['ps', '-eo', 'pid,ppid,etimes,args']
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
    except Exception as e:  # noqa: BLE001
        return [f'process list failed: {e!r}']
    lines = out.splitlines()
    if os.name != 'nt':
        lines = [x for x in lines if any(k in x for k in ('uv', 'pip', 'python', 'engine'))]
    return ['proc ' + x.strip()[:400] for x in lines[:200]]


class _Controller:
    """xdist controller side: report collection and print the workers' dumps."""

    def __init__(self, config):
        """Remember the terminal reporter and start the timer."""
        self.tr = config.pluginmanager.get_plugin('terminalreporter')
        self.ready = set()
        self.collected = set()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        threading.Thread(target=self._watch, name='hc-diag', daemon=True).start()

    def _line(self, text):
        try:
            with self.lock:
                self.tr.write_line(f'HC-DIAG {text}')
        except Exception:  # noqa: BLE001
            pass

    def pytest_xdist_newgateway(self, gateway):
        """Note each worker when its gateway is made (before any collects)."""
        self.ready.add(gateway.id)

    def pytest_xdist_node_collection_finished(self, node, ids):
        """Print when each worker finished collecting."""
        self.collected.add(node.gateway.id)
        self._line(f'controller: {node.gateway.id} collected {len(ids)} items after {time.monotonic() - _T0:.0f}s')
        if self.ready and self.collected >= self.ready:
            self.stop.set()

    def pytest_sessionfinish(self, session, exitstatus):  # noqa: ARG002
        """Stop the timer."""
        self.stop.set()

    def _watch(self):
        if self.stop.wait(_FIRST + 60):
            return
        for i in range(_TIMES):
            left = sorted(self.ready - self.collected) or ['(no worker reported ready)']
            self._line(
                f'controller: still collecting after {time.monotonic() - _T0:.0f}s: '
                f'{", ".join(left)} (dump {i + 1} of {_TIMES})'
            )
            for path in sorted(glob.glob(os.path.join(_DIR, '*.txt'))):
                self._line(f'file {os.path.basename(path)}:')
                try:
                    with open(path, encoding='utf-8', errors='replace') as f:
                        for line in f.read().splitlines()[-400:]:
                            self._line('  ' + line[:400])
                except OSError as e:
                    self._line(f'  unreadable: {e!r}')
            for line in _processes():
                self._line(line)
            if self.stop.wait(_EVERY):
                return


def pytest_sessionstart(session):
    """Start the controller side in an xdist controller."""
    config = session.config
    if _WORKER or not config.pluginmanager.has_plugin('dsession'):
        return
    for path in glob.glob(os.path.join(_DIR, '*.txt')):
        try:
            os.remove(path)  # an earlier pytest run in this job
        except OSError:
            pass
    config.pluginmanager.register(_Controller(config), 'hc-diag-controller')


if _WORKER:
    _arm_worker()
