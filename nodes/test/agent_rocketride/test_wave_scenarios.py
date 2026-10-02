# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""End-to-end scenarios for the Wave agent: one real run per known failure.

Each scenario runs the whole loop (planner prompt, JSON parsing, parallel tool
execution, memory, fallback answer) with a scripted model, then checks what the user
would get: the answer, the files, and what the model was shown. See wave_sim.py for
what is real and what is scripted.

A test marked ``fixed_by`` documents a bug that is still present: it is a strict xfail,
so it fails the suite if it starts passing unnoticed. The PR that fixes the bug removes
the marker, and the same test then has to pass. Each such test checks one bug only, so
the PRs can merge in any order.
"""

from __future__ import annotations

import json
import threading
from typing import Any

import pytest

pytest.importorskip('rocketlib', reason='needs the engine Python: ./builder nodes:test')

from .wave_sim import (  # noqa: E402
    TASK_TOKEN,
    Workspace,
    call,
    compile_project,
    count_results,
    is_synthesis,
    load_wave,
    make_driver,
    reply,
    results_section,
    run_wave,
)


def fixed_by(bug: str, change: str, raises=AssertionError):
    """Mark a scenario that fails until *change* fixes *bug*.

    Only *raises* counts as the expected failure, so a scenario whose harness breaks
    (an IndexError, a KeyError, a run that crashed) fails instead of passing as the bug.
    """
    return pytest.mark.xfail(strict=True, raises=raises, reason=f'{bug}: still present; fixed by {change}')


def require(condition: Any, message: str) -> None:
    """Fail the test outright when a scenario's setup did not happen.

    pytest.fail is not an AssertionError, so this fails even under fixed_by: a
    scenario whose setup went wrong proves nothing about the bug.
    """
    if not condition:
        pytest.fail(message)


# ---------------------------------------------------------------------------
# A small React project the scenarios work on
# ---------------------------------------------------------------------------

APP_CSS = """/* Layout for the to-do app. Edited by hand and by the agent. */
:root {
  font-family: system-ui, sans-serif;
  color: #1f2933;
}

.app {
  max-width: 640px;
  margin: 40px auto;
  padding: 0 16px;
}

.app-header {
  background: #f5f7fa;
  border-bottom: 1px solid #d9e2ec;
  padding: 16px 24px;
}

.app-header h1 {
  margin: 0;
  font-size: 24px;
}
"""

APP_TSX = """import './App.css';
import { useState } from 'react';

export default function App() {
  const [todos, setTodos] = useState<string[]>([]);
  const [text, setText] = useState('');
  return (
    <div className="app">
      <header className="app-header">
        <h1>My to-dos</h1>
      </header>
      <form onSubmit={(e) => { e.preventDefault(); setTodos([...todos, text]); setText(''); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <ul>{todos.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
"""

FILES = {'src/App.css': APP_CSS, 'src/App.tsx': APP_TSX}

BLUE_CSS = APP_CSS.replace('  background: #f5f7fa;\n', '  background: #2563eb;\n  color: #ffffff;\n')
FOOTER_TSX = APP_TSX.replace('    </div>\n  );', '      <footer>Made with RocketRide</footer>\n    </div>\n  );')
SAVE_TSX = APP_TSX.replace('>Add</button>', '>Save</button>')
SUBTITLE_BROKEN = APP_TSX.replace(
    '        <h1>My to-dos</h1>\n', '        <h1>My to-dos</h1>\n        <p className="subtitle">Plan your day\n'
)
SUBTITLE_FIXED = APP_TSX.replace(
    '        <h1>My to-dos</h1>\n', '        <h1>My to-dos</h1>\n        <p className="subtitle">Plan your day</p>\n'
)

CODE_EXAMPLE = """When you add a React component, follow this shape:
export function Card({ title }: { title: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
    </div>
  );
}"""


def read(path: str):
    return call('workspace.read', path=path)


def last_result(prompt):
    """The newest entry in the prompt's "Previous tool results", or {} before any."""
    seen = results_section(prompt)
    start = seen.find('{')
    if start < 0:
        return {}
    entries, _ = json.JSONDecoder().raw_decode(seen[start:])
    return list(entries.values())[-1] if entries else {}


def answer_now(text: str):
    """A policy that finishes on its first reply."""
    return lambda prompt: reply({'thought': 'Nothing to do.', 'scratch': '', 'done': True, 'answer': text})


# ---------------------------------------------------------------------------
# The loop works: baseline behaviour every version must keep
# ---------------------------------------------------------------------------


def test_reads_then_answers():
    """A read, then an answer: two model calls, and the answer reaches the user unchanged."""

    def model(prompt):
        if not results_section(prompt):
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'It is a stylesheet.'})

    run = run_wave('What is src/App.css?', model, files=FILES)

    assert run.answer == 'It is a stylesheet.'
    assert len(run.model) == 2
    assert [c.args for c in run.tool_calls('workspace.read')] == [{'path': 'src/App.css'}]


class ReversedReads(Workspace):
    """The first read waits until the second call has completely finished."""

    def __init__(self, files):
        super().__init__(files)
        self.second_finished = threading.Event()
        self.overlapped = None

    def _invoke(self, name, args):
        if name == 'workspace.read' and args.get('path') == 'src/App.css':
            self.overlapped = self.second_finished.wait(timeout=10)
        return super()._invoke(name, args)


def test_parallel_calls_run_together_and_keep_call_order(monkeypatch):
    """Two calls in one wave run at the same time, and their results come back in call order.

    The first read finishes last, which only works if both are running at once; the
    results still list it first, under wave-0.r0. "Finished" is taken where the
    executor sees it: the moment a call's future completes.
    """
    executor = load_wave().executor
    workspace = ReversedReads(FILES)
    finished = []

    class RecordingPool(executor.ThreadPoolExecutor):
        """The executor's thread pool, noting the order in which the wave's calls complete."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.submitted = 0

        def submit(self, *args, **kwargs):
            future = super().submit(*args, **kwargs)
            index, self.submitted = self.submitted, self.submitted + 1

            def completed(_future):
                finished.append(index)
                if index == 1:
                    workspace.second_finished.set()

            future.add_done_callback(completed)
            return future

    monkeypatch.setattr(executor, 'ThreadPoolExecutor', RecordingPool)

    def model(prompt):
        if not results_section(prompt):
            return reply(
                {'thought': 'Read both.', 'scratch': '', 'tool_calls': [read('src/App.css'), read('src/App.tsx')]}
            )
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'Read both files.'})

    run = run_wave('Read both files.', model, workspace=workspace)

    assert workspace.overlapped, 'the reads did not run at the same time'
    assert finished == [1, 0], 'the second call should complete first'
    results = run.trace['waves'][0]['results']
    assert [r['key'] for r in results] == ['wave-0.r0', 'wave-0.r1']
    assert run.stored['wave-0.r0']['path'] == 'src/App.css'
    assert run.stored['wave-0.r1']['path'] == 'src/App.tsx'


def test_the_fake_compiler_reports_both_kinds_of_unmatched_tag():
    """The kit's compiler answers ok false with a line number, for an opening or a closing tag left over."""
    opened = compile_project({'src/App.tsx': 'const a = 1;\n<p>text\n'})
    closed = compile_project({'src/App.tsx': 'const a = 1;\ntext</p>\n'})

    assert opened['ok'] is False and opened['diagnostics'][0]['line'] == 2
    assert closed['ok'] is False and closed['diagnostics'][0]['line'] == 2
    assert compile_project({'src/App.tsx': '<p>text</p>'}) == {'ok': True, 'diagnostics': []}


def test_memory_ref_can_feed_a_tool_argument():
    """A whole-argument {{memory.ref}} tag hands stored data to a tool without the model reading it."""

    def model(prompt):
        if not results_section(prompt):
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
        if not count_results(prompt, 'workspace.write'):
            copy = call(
                'workspace.write', path='src/Copy.css', content='{{memory.ref:wave-0.r0:text:content}}', baseRevision=0
            )
            return reply({'thought': 'Copy it.', 'scratch': '', 'tool_calls': [copy]})
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'Copied.'})

    run = run_wave('Copy src/App.css to src/Copy.css.', model, files=FILES)

    assert run.files['src/Copy.css'] == APP_CSS


# ---------------------------------------------------------------------------
# W1: tool results cut to 80 characters
# ---------------------------------------------------------------------------


def header_blue(prompt):
    """Edit the header colour if the stylesheet is visible; otherwise peek at it first."""
    if is_synthesis(prompt):
        return 'I could not finish the change.'
    seen = results_section(prompt)
    if not seen:
        return reply({'thought': 'Read the files.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
    if count_results(prompt, 'workspace.write'):
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'The header is now blue.'})
    if 'background: #f5f7fa' in seen:
        write = call('workspace.write', path='src/App.css', content=BLUE_CSS, baseRevision=1)
        return reply({'thought': 'Change the colour.', 'scratch': '', 'tool_calls': [write]})
    peek = call('memory.peek', key='wave-0.r0', path='content')
    return reply({'thought': 'The file is cut off; read the rest.', 'scratch': '', 'tool_calls': [peek]})


@fixed_by('W1', 'fix: show whole tool results')
def test_model_sees_the_whole_file():
    """After one read, the next prompt holds the rule to edit, so no extra round is needed."""
    run = run_wave('Make the page header background blue.', header_blue, files=FILES)

    assert 'background: #f5f7fa' in results_section(run.prompts()[1])
    assert len(run.prompts()) == 3  # read, write, answer
    assert run.files['src/App.css'] == BLUE_CSS


# ---------------------------------------------------------------------------
# W2: configured instructions sent twice
# ---------------------------------------------------------------------------


@fixed_by('W2', 'fix: send instructions once')
def test_configured_instructions_appear_once():
    """A node instruction is part of every prompt exactly once."""
    rule = 'Use the colors defined in src/theme.css.'
    run = run_wave('Say OK.', answer_now('OK'), config={'instructions': [rule]})

    assert run.prompts()[0].count(rule) == 1


# ---------------------------------------------------------------------------
# W9: instruction indentation flattened
# ---------------------------------------------------------------------------


@fixed_by('W9', 'fix: keep indentation in prompt instructions')
def test_instruction_code_keeps_its_indentation():
    """A code example in the node instructions reaches the model with its nesting intact."""
    run = run_wave('Say OK.', answer_now('OK'), config={'instructions': [CODE_EXAMPLE]})

    # getPrompt indents every instruction line by 8 spaces; the example's own 4 must survive on top.
    assert '            <div className="card">' in run.prompts()[0].splitlines()


# ---------------------------------------------------------------------------
# W4: nothing checks the shape of the model's reply
# ---------------------------------------------------------------------------


@fixed_by('W4', 'fix: check the shape of every plan')
def test_done_as_the_string_false_is_not_done():
    """``"done": "false"`` means not done: the write runs and the run continues."""

    def model(prompt):
        if not results_section(prompt):
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.tsx')]})
        if count_results(prompt, 'workspace.write'):
            return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'Added the footer.'})
        write = call('workspace.write', path='src/App.tsx', content=FOOTER_TSX, baseRevision=1)
        return reply({'thought': 'Add it.', 'scratch': '', 'done': 'false', 'tool_calls': [write]})

    run = run_wave('Add a footer that says "Made with RocketRide".', model, files=FILES)

    assert run.files['src/App.tsx'] == FOOTER_TSX
    assert run.answer == 'Added the footer.'


@fixed_by('W4', 'fix: check the shape of every plan')
def test_done_with_tool_calls_runs_the_calls_first():
    """A reply that writes and finishes in one go: the write happens, and no extra round is needed."""

    def model(prompt):
        if not results_section(prompt):
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.tsx')]})
        write = call('workspace.write', path='src/App.tsx', content=SAVE_TSX, baseRevision=1)
        return reply(
            {
                'thought': 'Write and finish.',
                'scratch': '',
                'done': True,
                'answer': 'Renamed Add to Save.',
                'tool_calls': [write],
            }
        )

    run = run_wave('Rename the Add button to Save.', model, files=FILES)

    assert run.files['src/App.tsx'] == SAVE_TSX
    assert run.answer == 'Renamed Add to Save.'
    assert len(run.model) == 2


@fixed_by('W4', 'fix: check the shape of every plan')
def test_call_written_as_text_is_skipped_not_fatal():
    """One malformed entry is reported back to the model; the good call still runs."""

    def model(prompt):
        if not results_section(prompt):
            return reply(
                {
                    'thought': 'Read both.',
                    'scratch': '',
                    'tool_calls': ['workspace.read src/App.css', read('src/App.tsx')],
                }
            )
        return reply({'thought': 'Found it.', 'scratch': '', 'done': True, 'answer': 'The header is in App.tsx.'})

    run = run_wave('Where is the header markup?', model, files=FILES)

    assert run.answer == 'The header is in App.tsx.'
    assert [c.args for c in run.tool_calls('workspace.read')] == [{'path': 'src/App.tsx'}]
    assert 'tool_calls[0]' in results_section(run.prompts()[1])


@fixed_by('W4', 'fix: check the shape of every plan')
def test_openai_style_call_is_understood():
    """OpenAI's function-call shape, ``{"name", "arguments": "<json text>"}``, is read as a call too.

    Wave asks for ``{"tool", "args"}``, but a model trained on function calling can answer in this shape.
    """

    def model(prompt):
        if not results_section(prompt):
            native = {'name': 'workspace.read', 'arguments': '{"path": "src/App.css"}'}
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [native]})
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'Read the stylesheet.'})

    run = run_wave('Read the stylesheet.', model, files=FILES)

    assert [c.args for c in run.tool_calls('workspace.read')] == [{'path': 'src/App.css'}]
    assert run.answer == 'Read the stylesheet.'


@fixed_by('W4', 'fix: check the shape of every plan')
def test_reply_with_neither_done_nor_calls_gets_one_retry():
    """An unusable reply is sent back once with what was wrong, instead of ending the run."""

    def model(prompt):
        if 'Your previous reply was not usable' in prompt:
            return reply({'thought': 'Answer.', 'scratch': '', 'done': True, 'answer': 'It is a stylesheet.'})
        return reply({'thought': 'Thinking about it.', 'scratch': ''})

    run = run_wave('What is src/App.css?', model, files=FILES)

    assert run.answer == 'It is a stylesheet.'


# ---------------------------------------------------------------------------
# W3: bad replies end the run with "LLM error"
# ---------------------------------------------------------------------------


def prose_json(prompt):
    if is_synthesis(prompt):
        return 'I could not finish.'
    if not results_section(prompt):
        return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
    final = reply({'thought': 'Answer.', 'scratch': '', 'done': True, 'answer': 'src/App.css has 4 rules.'})
    return 'Here is my plan:\n' + final + '\nHope that helps!'


@fixed_by('W3', 'fix: parse JSON replies wrapped in prose')
def test_sentence_around_the_json_is_still_understood():
    """A polite sentence before and after the fenced JSON costs no repair round."""
    run = run_wave('How many CSS rules does src/App.css have?', prose_json, files=FILES)

    assert run.answer == 'src/App.css has 4 rules.'
    assert run.prompts('retry') == []


# A file short enough that every version of Wave shows it whole, so these scenarios test
# only what happens after the empty reply, not how results are summarized.
THEME = {'src/theme.txt': 'primary: #2563eb'}


def empty_after_read(prompt):
    """Read once, then send nothing: what a model does when its output budget runs out."""
    if is_synthesis(prompt):
        if '#2563eb' in prompt:
            return 'The primary colour is #2563eb.'
        return 'I could not tell from what was gathered.'
    if not results_section(prompt):
        return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/theme.txt')]})
    return ''


@fixed_by('W3', 'fix: fail fast on an empty model reply')
def test_empty_reply_is_not_resent():
    """An empty reply is not sent back with a "fix your JSON" note."""
    run = run_wave('What is the primary colour?', empty_after_read, files=THEME)

    assert run.prompts('retry') == []


@fixed_by('W3', 'fix: answer from gathered work when planning fails')
def test_failed_plan_answers_from_gathered_work():
    """When planning fails, the user gets an answer built from what was already read."""
    run = run_wave('What is the primary colour?', empty_after_read, files=THEME)

    assert not run.answer.startswith('LLM error')
    assert '#2563eb' in run.answer


# ---------------------------------------------------------------------------
# W5: memory cleared before the answer is filled in
# ---------------------------------------------------------------------------


@fixed_by('W5', 'fix: finish before clearing memory')
def test_answer_can_use_a_key_the_same_reply_removes():
    """Removing a key and embedding it in the answer in one reply still renders the data."""

    def model(prompt):
        if not results_section(prompt):
            return reply({'thought': 'List.', 'scratch': '', 'tool_calls': [call('workspace.list')]})
        answer = 'Files:\n\n{{memory.ref:wave-0.r0:markdown_table:files}}'
        return reply({'thought': 'Show.', 'scratch': '', 'remove': ['wave-0.r0'], 'done': True, 'answer': answer})

    run = run_wave("Show me the project's files as a table.", model, files=FILES)

    assert 'src/App.css' in run.answer
    # And the key is still removed, once the answer has used it.
    assert not any(key.endswith('wave-0.r0') for key in run.memory)


@fixed_by('W5', 'fix: finish before clearing memory')
def test_missing_reference_is_marked_not_blank():
    """A tag pointing at nothing says so, instead of leaving a silent gap."""
    run = run_wave('Show the data.', answer_now('Data: {{memory.ref:wave-7.r0:markdown_table}}'))

    assert '[missing data: wave-7.r0]' in run.answer


# ---------------------------------------------------------------------------
# W6 and W7: the fallback answer at the wave limit
# ---------------------------------------------------------------------------


def counts_but_never_finishes(prompt):
    """Works out the answer, writes it in scratch, then keeps checking until the limit."""
    if is_synthesis(prompt):
        if 'There are 4 CSS rules' in prompt:
            return 'src/App.css has 4 CSS rules.'
        return 'I could not determine how many rules the stylesheet has.'
    if not results_section(prompt):
        return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
    if 'There are 4 CSS rules' not in prompt:
        return reply(
            {
                'thought': 'Count them.',
                'scratch': 'There are 4 CSS rules: :root, .app, .app-header, .app-header h1.',
                'tool_calls': [read('src/App.tsx')],
            }
        )
    return reply({'thought': 'Check again.', 'scratch': '', 'tool_calls': [read('src/App.tsx')]})


@fixed_by('W6', 'fix: give the fallback answer the scratch notes')
def test_fallback_answer_uses_the_scratch_notes():
    """The count the model wrote down survives into the answer forced by the wave limit."""
    run = run_wave(
        'How many CSS rules does src/App.css have?', counts_but_never_finishes, files=FILES, config={'max_waves': 3}
    )

    assert run.answer == 'src/App.css has 4 CSS rules.'


@fixed_by('W7', 'fix: record why the run stopped')
def test_run_records_why_it_stopped():
    """A forced answer says so: the trace carries the stop reason, and so does the last status event."""
    run = run_wave(
        'How many CSS rules does src/App.css have?', counts_but_never_finishes, files=FILES, config={'max_waves': 3}
    )
    finished = run_wave('Say OK.', answer_now('OK'))

    assert run.trace.get('stop_reason') == 'max_waves'
    assert run.events[-1].get('stop_reason') == 'max_waves'
    assert finished.trace.get('stop_reason') == 'done'


# ---------------------------------------------------------------------------
# W12: the model never sees the calls it made
# ---------------------------------------------------------------------------


@fixed_by('W12', 'fix: show the model its own calls')
def test_prompt_shows_what_each_call_sent():
    """After a write, the model can see what it wrote, not only "ok"."""
    run = run_wave('Make the page header background blue.', header_blue, files=FILES)

    assert '#2563eb' in results_section(run.prompts()[-1])


@fixed_by('W12', 'fix: show the model its own calls')
def test_repeating_a_failed_call_is_pointed_out():
    """The same failing call twice: the second result says it repeats the first."""

    def model(prompt):
        attempts = count_results(prompt, 'workspace.read')
        if attempts < 2:
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/Missing.css')]})
        return reply({'thought': 'Stop.', 'scratch': '', 'done': True, 'answer': 'src/Missing.css does not exist.'})

    run = run_wave('Read src/Missing.css.', model, files=FILES)

    assert 'wave-0.r0' in results_section(run.prompts()[-1]).split('"wave-1.r0"', 1)[1]


# ---------------------------------------------------------------------------
# W13: no way to check its work
# ---------------------------------------------------------------------------


def adds_subtitle(prompt):
    """Writes a broken subtitle and tries to finish at once, every time it thinks it is done.

    It never reads the rules. It checks its work only when the run refuses to end, and fixes
    the code only when a check reports an error, so the scenario tests the enforcement, not
    the prompt wording.
    """
    if is_synthesis(prompt):
        return 'I could not finish.'
    if not results_section(prompt):
        return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.tsx')]})
    if not count_results(prompt, 'workspace.write'):
        write = call('workspace.write', path='src/App.tsx', content=SUBTITLE_BROKEN, baseRevision=1)
        return reply({'thought': 'Add it.', 'scratch': '', 'tool_calls': [write]})
    last = last_result(prompt)
    if last.get('tool') == 'reply-check':
        return reply({'thought': 'Check it.', 'scratch': '', 'tool_calls': [call('workspace.compile')]})
    if last.get('tool') == 'workspace.compile' and 'ok: false' in last.get('summary', ''):
        write = call('workspace.write', path='src/App.tsx', content=SUBTITLE_FIXED, baseRevision=2)
        return reply({'thought': 'Close the tag.', 'scratch': '', 'tool_calls': [write]})
    return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'Added the subtitle.'})


@fixed_by('W13', 'fix: require a passing check when a check tool is set')
def test_check_tool_catches_a_broken_edit():
    """With a check tool configured, the run ends on code that compiles."""
    run = run_wave(
        'Add a subtitle under the header that says "Plan your day".',
        adds_subtitle,
        files=FILES,
        config={'verify_tool': 'workspace.compile'},
    )

    calls = [c.tool for c in run.tools]
    require('workspace.write' in calls, 'the run never made the edit')
    assert 'workspace.compile' in calls, 'the run never ran the check'
    last_write = len(calls) - 1 - calls[::-1].index('workspace.write')
    last_check = len(calls) - 1 - calls[::-1].index('workspace.compile')
    assert last_check > last_write, 'the run ended without checking its last change'
    assert run.tools[last_check].result['ok'], 'the last check the agent saw did not pass'
    assert compile_project(run.files)['ok']
    assert 'Plan your day</p>' in run.files['src/App.tsx']
    assert run.answer == 'Added the subtitle.'


# ---------------------------------------------------------------------------
# W8: the tool time limit is never applied
# ---------------------------------------------------------------------------


@fixed_by('W8', 'fix: apply the tool time limit')
def test_stuck_tool_does_not_hold_the_turn(monkeypatch):
    """A tool that never answers is reported as timed out and the turn goes on."""
    monkeypatch.setattr(load_wave().executor, '_TOOL_TIMEOUT_S', 0.2)
    workspace = Workspace(FILES, hold={'workspace.compile'})

    def model(prompt):
        seen = results_section(prompt)
        if not seen:
            return reply({'thought': 'Check it.', 'scratch': '', 'tool_calls': [call('workspace.compile')]})
        return reply(
            {
                'thought': 'Report.',
                'scratch': '',
                'done': True,
                'answer': 'The check timed out.' if 'TimeoutError' in seen else 'It compiles.',
            }
        )

    box = {}

    def run():
        try:
            box['run'] = run_wave('Compile it.', model, workspace=workspace)
        except Exception as exc:  # re-raised below, so a crash is not read as the bug
            box['error'] = exc

    worker = threading.Thread(target=run)
    worker.start()
    try:
        # Wait for the run to finish, but never past 5 s: today's code waits for the tool forever.
        worker.join(timeout=5)
        finished_while_stuck = not worker.is_alive()
    finally:
        workspace.release.set()  # let the stuck call return so its thread can end
        worker.join(timeout=10)

    if 'error' in box:
        raise RuntimeError('run_wave failed in the worker thread') from box['error']
    assert finished_while_stuck
    assert box['run'].answer == 'The check timed out.'


# ---------------------------------------------------------------------------
# W11: two runs on one node share state
# ---------------------------------------------------------------------------


@fixed_by('W11', 'fix: keep run state per run')
def test_overlapping_runs_keep_their_own_repeat_tracking():
    """A second run starting mid-way through the first must not hide the first run's repeats."""
    driver = make_driver()
    first_has_a_result = threading.Event()
    second_is_done = threading.Event()
    box = {}

    def first(prompt):
        if not results_section(prompt):
            return reply({'thought': 'Read it.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
        if count_results(prompt, 'workspace.read') == 1:
            first_has_a_result.set()
            # The point of the test: this run continues only after the second run has finished.
            box['overlapped'] = second_is_done.wait(timeout=10)
            return reply({'thought': 'Read it again.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'done'})

    def second(prompt):
        reads = count_results(prompt, 'workspace.read')
        if reads == 0:
            return reply({'thought': 'Read.', 'scratch': '', 'tool_calls': [read('src/App.tsx')]})
        if reads == 1:
            return reply({'thought': 'Read.', 'scratch': '', 'tool_calls': [read('src/App.css')]})
        return reply({'thought': 'Done.', 'scratch': '', 'done': True, 'answer': 'done'})

    def run_first():
        try:
            box['run'] = run_wave('Read twice.', first, files=FILES, driver=driver)
        except Exception as exc:  # re-raised below, so a crash is not read as the bug
            box['error'] = exc

    worker = threading.Thread(target=run_first)
    worker.start()
    try:
        got_a_result = first_has_a_result.wait(timeout=10)
        if got_a_result:
            box['second'] = run_wave('Read both.', second, files=FILES, driver=driver)
    finally:
        second_is_done.set()  # never leave the first run waiting
        worker.join(timeout=10)

    if 'error' in box:
        raise RuntimeError('the first run failed in the worker thread') from box['error']
    require(got_a_result, 'the first run never got its first result')
    require(box.get('overlapped'), 'the runs did not overlap, so this run proves nothing')
    # The first run read src/App.css twice; its second read must be flagged as a repeat of its first.
    last_prompt = box['run'].prompts()[-1]
    assert 'identical to wave-0.r0' in results_section(last_prompt)
    # And the second run read two different files: neither may be called a repeat, as it
    # would be if the first run's tables (results or calls) leaked into it.
    second_seen = results_section(box['second'].prompts()[-1])
    assert 'identical to' not in second_seen
    assert 'Same tool and arguments' not in second_seen


# ---------------------------------------------------------------------------
# W15: the prompt never explains memory.ref in tool arguments
# ---------------------------------------------------------------------------


@fixed_by('W15', 'fix: document memory.ref tool arguments')
def test_prompt_explains_memory_ref_as_a_tool_argument():
    """The model is told it can pass stored data into a tool with a {{memory.ref}} tag."""
    run = run_wave('Say OK.', answer_now('OK'))

    assert '(tool argument)' in run.prompts()[0]


# ---------------------------------------------------------------------------
# W10: the task's private token in the answer metadata
# ---------------------------------------------------------------------------


def crash(**kwargs):
    raise RuntimeError('the agent crashed')


def ending(run) -> str:
    """How the run ended, read from the answer's stack."""
    kinds = [entry.get('kind') for entry in run.stack]
    if 'RocketRide.agent.guard.v1' in kinds:
        return 'guard'
    if 'RocketRide.agent.error.v1' in kinds:
        return 'error'
    return 'answer'


@fixed_by('W10', 'fix: keep the task token out of agent answers')
@pytest.mark.parametrize('end', ['answer', 'guard', 'error'])
def test_task_token_is_not_in_the_answer_metadata(end):
    """The token that controls the task never reaches the answer a parent agent reads, however the run ends.

    The answer, an answer refused by the require_tool_call guard, and a crash each
    build their own metadata, so each is checked.
    """
    driver = make_driver({'require_tool_call': True} if end == 'guard' else None)
    if end == 'error':
        driver._run = crash
    run = run_wave('Say OK.', answer_now('OK'), driver=driver)

    require(ending(run) == end, f'the run ended by {ending(run)!r}, not {end!r}')
    assert TASK_TOKEN not in json.dumps(run.meta)
