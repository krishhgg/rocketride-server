# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Run the real Wave loop against a scripted model, fake project tools and a dict memory.

What is real: the Wave driver (rocketride_agent, planner, executor, formatters) loaded
from this repo's source, ``AgentBase.run_agent``, ``ChatBase.chat`` (JSON parsing and
retries), ``Question.getPrompt`` and ``Config``. What is fake: the model, the tools, the
memory store and the engine instance.

The model is a *policy*: a function that receives the exact prompt the real code built
and returns the text a model would send back. Policies only react to what the prompt
contains, so when two versions of Wave behave differently on the same policy, the
difference comes from Wave, not from the script.

These tests need the engine's Python (``./builder nodes:test``), where ``rocketlib`` and
the ``ai`` package import. Elsewhere the importing test module is skipped.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

from ai.common.agent._internal.host import ToolNotFoundError
from ai.common.chat import ChatBase
from ai.common.schema import Question

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_rocketride'

# A private package name, so loading the source never collides with the engine's own
# copy of the node or with test_result_summary.py's stubbed load.
_PKG = 'agent_rocketride_under_test'

# Phrases the real code puts in prompts. Policies use them to tell prompts apart.
RETRY_MARKER = 'previous response returned invalid JSON'
SYNTHESIS_MARKER = 'Information gathered:'
RESULTS_MARKER = 'Previous tool results:'

TASK_TOKEN = 'tk_7f3c9a1e_private_task_token'

Policy = Callable[[str], str]


def load_wave() -> SimpleNamespace:
    """Load the Wave node's modules from source, once per test session.

    The package is registered but its ``__init__`` is not executed: it imports the
    engine glue (IGlobal, IInstance), and the loop needs none of it.

    Returns:
        A namespace with the ``agent``, ``planner`` and ``executor`` modules.
    """
    if f'{_PKG}.rocketride_agent' not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            _PKG, _NODE_DIR / '__init__.py', submodule_search_locations=[str(_NODE_DIR)]
        )
        sys.modules[_PKG] = importlib.util.module_from_spec(spec)
        # Dependency order, so each relative import finds its target already loaded.
        for name in ('formatters', 'executor', 'planner', 'rocketride_agent'):
            sub = importlib.util.spec_from_file_location(f'{_PKG}.{name}', _NODE_DIR / f'{name}.py')
            module = importlib.util.module_from_spec(sub)
            sys.modules[sub.name] = module
            sub.loader.exec_module(module)
    return SimpleNamespace(
        agent=sys.modules[f'{_PKG}.rocketride_agent'],
        planner=sys.modules[f'{_PKG}.planner'],
        executor=sys.modules[f'{_PKG}.executor'],
    )


# ---------------------------------------------------------------------------
# Helpers for writing policies
# ---------------------------------------------------------------------------


def reply(obj: Dict[str, Any]) -> str:
    """Format a reply the way models usually send it: one fenced JSON block."""
    return '```json\n' + json.dumps(obj) + '\n```'


def results_section(prompt: str) -> str:
    """Return the "Previous tool results" part of a planning prompt, or '' before any."""
    return prompt.split(RESULTS_MARKER, 1)[1] if RESULTS_MARKER in prompt else ''


def count_results(prompt: str, tool: str) -> int:
    """Count how many earlier results in *prompt* came from *tool*."""
    return results_section(prompt).count(f'"tool": "{tool}"')


def is_synthesis(prompt: str) -> bool:
    """True for the fallback prompt Wave sends after the wave limit or a failed plan."""
    return SYNTHESIS_MARKER in prompt


def call(tool: str, **args: Any) -> Dict[str, Any]:
    """Build one tool call in the shape the Wave prompt documents."""
    return {'tool': tool, 'args': args}


# ---------------------------------------------------------------------------
# The scripted model
# ---------------------------------------------------------------------------


@dataclass
class ModelCall:
    """One request to the model and the text it sent back."""

    prompt: str
    reply: str

    @property
    def kind(self) -> str:
        """'retry' (JSON repair), 'synthesis' (fallback answer) or 'plan'."""
        if RETRY_MARKER in self.prompt:
            return 'retry'
        if is_synthesis(self.prompt):
            return 'synthesis'
        return 'plan'


class ScriptedChat(ChatBase):
    """The real ``ChatBase.chat`` on top of a policy instead of a provider.

    Only ``chat_string`` is replaced, so JSON parsing, the repair retries and the errors
    they raise are the production code paths.
    """

    def __init__(self, policy: Policy):
        """Skip ChatBase's provider config: a scripted model has none."""
        self._model = 'scripted'
        self._modelTotalTokens = 200_000
        self._modelOutputTokens = 16_000
        self.policy = policy
        self.calls: List[ModelCall] = []
        self._lock = threading.Lock()

    def chat_string(self, prompt: str, on_chunk=None, on_finish=None, on_reasoning_chunk=None) -> str:
        """Ask the policy, and record the exchange."""
        text = self.policy(prompt)
        with self._lock:
            self.calls.append(ModelCall(prompt, text))
        return text


class LLMChannel:
    """Stands in for the engine's LLM node: its ask handler runs ``chat.chat(question)``."""

    def __init__(self, chat: ScriptedChat):
        self.chat = chat

    def invoke(self, ask: Any) -> Any:
        return self.chat.chat(ask.question)


# ---------------------------------------------------------------------------
# Fake project tools
# ---------------------------------------------------------------------------

# The browser port's tool descriptors, trimmed to the tools these scenarios use.
TOOL_DESCRIPTORS: List[Dict[str, Any]] = [
    {
        'name': 'workspace.list',
        'description': 'List project files with their current revisions.',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'workspace.read',
        'description': 'Read a project file and its revision. Read before changing an existing file.',
        'inputSchema': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']},
    },
    {
        'name': 'workspace.write',
        'description': (
            'Create or replace a UTF-8 project file. baseRevision must match the current file revision, or 0 to create.'
        ),
        'inputSchema': {
            'type': 'object',
            'properties': {
                'path': {'type': 'string'},
                'content': {'type': 'string'},
                'baseRevision': {'type': 'integer'},
            },
            'required': ['path', 'content', 'baseRevision'],
        },
    },
    {
        'name': 'workspace.compile',
        'description': 'Compile the current project. Returns ok and file/line diagnostics.',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
]


def compile_project(files: Dict[str, str]) -> Dict[str, Any]:
    """A stand-in compiler with one rule: every ``<p`` needs a ``</p>``, and the reverse."""
    for path, text in sorted(files.items()):
        opened, closed = len(re.findall(r'<p[ >]', text)), text.count('</p>')
        if opened != closed:
            tag = r'<p[ >]' if opened > closed else r'</p>'
            line = next(i for i, ln in enumerate(text.splitlines(), 1) if re.search(tag, ln))
            if opened > closed:
                message = "JSX element 'p' has no corresponding closing tag."
            else:
                message = "Expected corresponding JSX closing tag for '</p>'."
            return {'ok': False, 'diagnostics': [{'file': path, 'line': line, 'message': message}]}
    return {'ok': True, 'diagnostics': []}


@dataclass
class ToolCallRecord:
    """One tool invocation as the host saw it."""

    tool: str
    args: Dict[str, Any]
    result: Any = None
    error: Optional[str] = None


class Workspace:
    """An in-memory project behind the ``workspace.*`` tools.

    Args:
        files: Starting files, path to text. Every file starts at revision 1.
        hold: Tool names whose calls block until :attr:`release` is set, so a test can
            hold a call open without sleeping.
    """

    def __init__(self, files: Dict[str, str], hold: Optional[set] = None):
        self.list = TOOL_DESCRIPTORS
        self.files: Dict[str, Dict[str, Any]] = {p: {'content': c, 'revision': 1} for p, c in files.items()}
        self.calls: List[ToolCallRecord] = []
        self.hold = hold or set()
        self.release = threading.Event()
        self._lock = threading.Lock()

    def text(self) -> Dict[str, str]:
        """Return the current file contents, path to text."""
        return {p: f['content'] for p, f in self.files.items()}

    def invoke(self, name: str, args: Dict[str, Any]) -> Any:
        record = ToolCallRecord(name, dict(args or {}))
        with self._lock:
            self.calls.append(record)
        try:
            record.result = self._invoke(name, args or {})
            return record.result
        except Exception as exc:
            record.error = f'{type(exc).__name__}: {exc}'
            raise

    def _invoke(self, name: str, args: Dict[str, Any]) -> Any:
        if name in self.hold:
            self.release.wait()
        if name == 'workspace.list':
            return {'files': [{'path': p, 'revision': f['revision']} for p, f in sorted(self.files.items())]}
        if name == 'workspace.read':
            f = self.files.get(args.get('path'))
            if f is None:
                raise FileNotFoundError(args.get('path'))
            return {'path': args['path'], 'content': f['content'], 'revision': f['revision']}
        if name == 'workspace.write':
            path, base = args.get('path'), args.get('baseRevision')
            # Calls in one wave run in parallel: check and update the revision together.
            with self._lock:
                current = self.files.get(path, {'revision': 0})['revision']
                if base != current:
                    return {'ok': False, 'error': f'conflict: {path} is at revision {current}, not {base}'}
                self.files[path] = {'content': args.get('content', ''), 'revision': current + 1}
            return {'ok': True, 'path': path, 'revision': current + 1}
        if name == 'workspace.compile':
            return compile_project(self.text())
        # Same type and message as the engine host's catalog miss.
        raise ToolNotFoundError(f'Tool {name} not found in tool catalog (owning node re-queried)')


class Memory:
    """The memory channel's three calls, over a dict. Every write is also logged."""

    def __init__(self):
        self.data: Dict[str, Any] = {}
        self.writes: List[tuple] = []

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        self.data[key] = value
        self.writes.append((key, value))
        return {'ok': True}

    def get(self, key: str) -> Dict[str, Any]:
        if key in self.data:
            return {'ok': True, 'value': self.data[key]}
        return {'ok': False, 'error': f'key {key!r} not found'}

    def clear(self, key: str) -> Dict[str, Any]:
        self.data.pop(key, None)
        return {'ok': True}


class EngineInstance:
    """Records what Wave sends to the UI (SSE events) and to the answers lane."""

    def __init__(self):
        self.pipeId = 1
        self.events: List[Dict[str, Any]] = []
        self.answers: List[str] = []

    def sendSSE(self, type: str, **data: Any) -> None:
        self.events.append({'type': type, **data})

    def writeAnswers(self, answer: Any) -> None:
        self.answers.append(answer.getText())


# ---------------------------------------------------------------------------
# Running a scenario
# ---------------------------------------------------------------------------


@dataclass
class Run:
    """Everything one Wave run did, for assertions."""

    answer: str
    meta: Dict[str, Any]
    trace: Any
    model: List[ModelCall]
    tools: List[ToolCallRecord]
    files: Dict[str, str]
    events: List[Dict[str, Any]]
    memory: Dict[str, Any]
    stored: Dict[str, Any]
    seconds: float
    stack: List[Dict[str, Any]] = field(default_factory=list)

    def prompts(self, kind: str = 'plan') -> List[str]:
        """Return the prompts of one kind ('plan', 'retry' or 'synthesis'), in order."""
        return [c.prompt for c in self.model if c.kind == kind]

    def tool_calls(self, tool: str) -> List[ToolCallRecord]:
        """Return the calls made to one tool, in order."""
        return [c for c in self.tools if c.tool == tool]


def make_driver(config: Optional[Dict[str, Any]] = None) -> Any:
    """Build a RocketRideDriver from node config, through the real Config merge."""
    wave = load_wave()
    glb = SimpleNamespace(logicalType='agent_rocketride', connConfig=dict(config or {}))
    return wave.agent.RocketRideDriver(SimpleNamespace(glb=glb))


def run_wave(
    task: str,
    policy: Policy,
    *,
    files: Optional[Dict[str, str]] = None,
    config: Optional[Dict[str, Any]] = None,
    workspace: Optional[Workspace] = None,
    driver: Any = None,
) -> Run:
    """Run one Wave turn and return what happened.

    Args:
        task: The user's request.
        policy: The scripted model.
        files: Starting project files (ignored when *workspace* is given).
        config: Node config, as a pipeline would set it (e.g. ``{'max_waves': 3}``).
        workspace: A prepared Workspace, when a test needs to control it.
        driver: An existing driver, when a test runs several turns on one node.
    """
    driver = driver or make_driver(config)
    chat = ScriptedChat(policy)
    workspace = workspace or Workspace(files or {})
    memory = Memory()
    instance = EngineInstance()
    iinstance = SimpleNamespace(
        # Preset, so run_agent skips discovering real host services.
        _agent_host=SimpleNamespace(llm=LLMChannel(chat), tools=workspace, memory=memory),
        IEndpoint=SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'taskId': TASK_TOKEN})),
        instance=instance,
        IGlobal=driver._iGlobal,
    )
    question = Question()
    question.addQuestion(task)

    started = time.perf_counter()
    payload = driver.run_agent(iinstance, question, emit_answers_lane=True)
    seconds = time.perf_counter() - started

    stack = payload.get('stack', [])
    trace = next((s['payload'] for s in stack if s.get('kind') == 'RocketRide.agent.raw.v1'), None)
    return Run(
        answer=payload.get('content', ''),
        meta=payload.get('meta', {}),
        trace=trace,
        model=list(chat.calls),
        tools=list(workspace.calls),
        files=workspace.text(),
        events=list(instance.events),
        memory=dict(memory.data),
        # Every value the run wrote, by the key the model knows it under (a run may
        # store keys under a private prefix, and may clear them when it ends).
        stored={key.rsplit('/', 1)[-1]: value for key, value in memory.writes},
        seconds=seconds,
        stack=stack,
    )
