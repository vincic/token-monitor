'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  agentLifecycleCapabilityMatrix,
  capabilityForAgentLifecycleClient
} = require('../../src/shared/agentLifecycleCapabilities');

test('exact adapters require doctor success before active lifecycle capability', () => {
  assert.equal(capabilityForAgentLifecycleClient('codex').capability, 'presence_only');
  const exact = capabilityForAgentLifecycleClient('codex', { doctor: { codex: { capability: 'exact' } } });
  assert.equal(exact.capability, 'exact');
  assert.equal(exact.reason, 'codex_doctor_passed');
});

test('presence-only and attribution-only clients are honest about unsupported LEDs', () => {
  assert.equal(capabilityForAgentLifecycleClient('antigravity').capability, 'presence_only');
  assert.equal(capabilityForAgentLifecycleClient('copilot').reason, 'copilot_stable_hooks_unproven');
  assert.equal(capabilityForAgentLifecycleClient('herdr').capability, 'surface_only');
  assert.equal(capabilityForAgentLifecycleClient('openrouter').capability, 'attribution_only');
  assert.equal(capabilityForAgentLifecycleClient('deepseek').reason, 'model_provider_not_lifecycle_adapter');
});

test('matrix returns reason-coded capability records', () => {
  const matrix = agentLifecycleCapabilityMatrix({ clientIds: ['claude', 'copilot', 'ollama'], doctor: { claude: { ok: true } } });
  assert.equal(matrix.claude.capability, 'exact');
  assert.equal(matrix.copilot.capability, 'presence_only');
  assert.equal(matrix.ollama.capability, 'attribution_only');
});
