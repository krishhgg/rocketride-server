# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Diagnostic only, not for merging: show what a stuck xdist worker is doing.

Some Windows nodes:run-pytest jobs hang before any test starts: pytest-xdist
prints `created: 4/4 workers` and never `N workers [M items]`, and the job
sits silent until its timeout. Importing this module in an xdist worker arms
a timer. If the worker is still collecting after HC_DIAG_FIRST seconds (600
by default), it prints, through the engine's monitorStatus (which reaches the
job log while pytest captures output):

- the stack of every Python thread in the worker,
- the state of depends()'s install lock and its progress sidecar,
- the uv, pip, python and engine processes with their command lines,

then again every 600 seconds, at most 6 times. faulthandler writes the
stacks into a file under RUNNER_TEMP at the same moments, for a worker whose
Python threads cannot run. pytest_collection_finish stops both and prints how
long collection took. Every printed line starts with `HC-DIAG`.
"""

import faulthandler
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback

try:
    from engLib import monitorStatus as _monitor
except Exception:  # noqa: BLE001 - outside the engine there is no monitor
    _monitor = None

_WORKER = os.environ.get('PYTEST_XDIST_WORKER')
_FIRST = float(os.environ.get('HC_DIAG_FIRST', '600'))
_EVERY = 600.0
_TIMES = 6
_T0 = time.monotonic()
_done = threading.Event()
_file = None
_PROC_RE = r'^(uv|pip|python|engine)'


def _emit(line):
    """Print one diagnostic line where the job log shows it."""
    text = f'HC-DIAG {_WORKER} pid={os.getpid()} {line}'
    if _monitor is not None:
        try:
            _monitor(text)
        except Exception:  # noqa: BLE001
            pass
    try:
        os.write(2, (text + '\n').encode('utf-8', 'replace'))
    except OSError:
        pass


def _stacks():
    """Print the stack of every Python thread."""
    names = {t.ident: t.name for t in threading.enumerate()}
    for ident, frame in sys._current_frames().items():
        if ident == threading.get_ident():
            continue  # this dump's own thread
        _emit(f'thread {names.get(ident, "?")} ({ident}):')
        for entry in traceback.format_stack(frame):
            for line in entry.rstrip().splitlines():
                _emit('  ' + line[:400])


def _lock_state():
    """Print the install lock, its progress sidecar and this process's part."""
    dep = sys.modules.get('depends')
    if dep is None:
        _emit('depends is not imported in this process')
        return
    try:
        cache = dep.engine_cache_dir()
    except Exception as e:  # noqa: BLE001
        _emit(f'engine_cache_dir failed: {e!r}')
        return
    for name in ('install.lock', 'install.progress'):
        path = os.path.join(cache, name)
        try:
            st = os.stat(path)
        except OSError:
            _emit(f'{name}: absent')
            continue
        try:
            with open(path, 'rb') as f:
                data = f.read(300)
        except OSError as e:
            data = f'unreadable: {e!r}'
        _emit(f'{name}: size={st.st_size} age={time.time() - st.st_mtime:.0f}s data={data!r}')
    _emit(
        f'this process holds the lock: {bool(getattr(dep, "_progress_path", None))}; '
        f'last progress: {getattr(dep, "_last_sidecar_message", None)!r}; '
        f'requirements done here: {len(getattr(dep, "_processed", ()))}'
    )


def _processes():
    """Print the uv, pip, python and engine processes."""
    if os.name == 'nt':
        script = (
            'Get-CimInstance Win32_Process | '
            f"Where-Object {{ $_.Name -match '{_PROC_RE}' }} | "
            "ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, "
            '$_.CreationDate, $_.CommandLine }'
        )
        cmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
    else:
        cmd = ['ps', '-eo', 'pid,ppid,etimes,args']
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
    except Exception as e:  # noqa: BLE001
        _emit(f'process list failed: {e!r}')
        return
    lines = out.splitlines()
    if os.name != 'nt':
        lines = [x for x in lines if any(k in x for k in ('uv', 'pip', 'python', 'engine'))]
    for line in lines[:200]:
        _emit('proc ' + line.strip()[:400])


def _watch():
    """Dump while the worker is still collecting."""
    if _done.wait(_FIRST):
        return
    for i in range(_TIMES):
        _emit(f'still collecting after {time.monotonic() - _T0:.0f}s (dump {i + 1} of {_TIMES})')
        for part in (_stacks, _lock_state, _processes):
            try:
                part()
            except Exception as e:  # noqa: BLE001
                _emit(f'{part.__name__} failed: {e!r}')
        if _done.wait(_EVERY):
            return


def _arm():
    """Start the timer and faulthandler's dump in an xdist worker."""
    global _file
    if not _WORKER:
        return
    try:
        folder = os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()
        _file = open(os.path.join(folder, f'hc-diag-{_WORKER}-{os.getpid()}.txt'), 'w')
        faulthandler.dump_traceback_later(_FIRST, repeat=True, file=_file)
    except Exception as e:  # noqa: BLE001
        _emit(f'faulthandler not armed: {e!r}')
    threading.Thread(target=_watch, name='hc-diag', daemon=True).start()


def pytest_collection_finish(session):
    """Stop the dumps once this worker has collected."""
    _done.set()
    try:
        faulthandler.cancel_dump_traceback_later()
    except Exception:  # noqa: BLE001
        pass
    if _WORKER:
        _emit(f'collection finished after {time.monotonic() - _T0:.0f}s, {len(session.items)} items')


_arm()
