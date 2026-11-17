# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The staged ai tree holds no file that the source tree no longer has."""

import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
# The builder exports ROCKETRIDE_DIST_ROOT when it writes somewhere else than <repo>/dist.
DIST_ROOT = Path(os.environ.get('ROCKETRIDE_DIST_ROOT') or REPO_ROOT / 'dist')
STAGED_AI = DIST_ROOT / 'server' / 'ai'

# Removed from packages/ai/src/ai. A build must not bring it back.
REMOVED = ['hillclimb_probe.txt']


@pytest.mark.parametrize('name', REMOVED)
def test_removed_source_file_is_not_staged(name):
    """A file deleted from packages/ai/src/ai is absent from dist/server/ai after the build."""
    if not STAGED_AI.is_dir():
        pytest.skip(f'{STAGED_AI} does not exist, so there is no staged tree to check')
    staged = STAGED_AI / name
    assert not staged.exists(), f'{staged} exists, but packages/ai/src/ai/{name} was removed'
