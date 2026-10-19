# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
A credential that still holds a placeholder fails with the missing variable's name.

The task keeps a ${ROCKETRIDE_*} it has no value for as-is, so without this check the
placeholder text goes to the provider as the key and the user reads "Incorrect API key
provided" instead of which variable to add.
"""

import pytest

from ai.common.config import check_credential_resolved


@pytest.mark.parametrize('value', ['sk-live-key', '', None, 42, {'nested': '${ROCKETRIDE_X}'}])
def test_a_resolved_or_absent_value_passes(value):
    check_credential_resolved('llm_openai', 'apikey', value)


def test_an_unresolved_placeholder_names_the_variable_to_add():
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}')

    message = str(caught.value)
    assert message.startswith('llm_openai: apikey is set to ${ROCKETRIDE_OPENAI_KEY}')
    assert 'no variable named ROCKETRIDE_OPENAI_KEY was found' in message
    assert 'Add ROCKETRIDE_OPENAI_KEY to the org, team or user environment variables' in message
    assert '*' not in message


def test_a_placeholder_inside_a_longer_value_is_caught():
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_KEY_PART was found'):
        check_credential_resolved('embedding_openai', 'apikey', 'sk-${ROCKETRIDE_KEY_PART}')


def test_a_variable_outside_the_namespace_says_only_rocketride_names_resolve():
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_openai', 'apikey', '<REDACTED>')

    assert 'does not start with ROCKETRIDE_' in str(caught.value)
    # The engine splits error text on '*', which would cut the message short.
    assert '*' not in str(caught.value)


def test_a_placeholder_the_pipeline_wrote_names_the_variable_to_add():
    written = {'profile': 'custom', 'custom': {'apikey': '${ROCKETRIDE_OPENAI_KEY}'}}
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_OPENAI_KEY was found'):
        check_credential_resolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}', written)


def test_a_placeholder_from_a_profile_default_says_to_set_it_in_the_node():
    # Nebius profiles default apikey to ${ROCKETRIDE_NEBIUS_KEY}. Only the pipeline's own
    # text is resolved, so a saved ROCKETRIDE_NEBIUS_KEY does not fill a default; telling
    # the user to add the variable would be wrong.
    written = {'profile': 'llama-3-3-70b', 'llama-3-3-70b': {}}
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)

    message = str(caught.value)
    assert message.startswith('llm_nebius: apikey is the profile default ${ROCKETRIDE_NEBIUS_KEY}')
    assert 'Set apikey to ${ROCKETRIDE_NEBIUS_KEY} in the node settings' in message
    assert 'no variable named' not in message
    assert '*' not in message
