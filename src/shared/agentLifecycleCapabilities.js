'use strict';

const EXACT_ADAPTERS = new Set(['claude', 'codex', 'hermes', 'opencode']);
const PRESENCE_ONLY_CLIENTS = new Set(['antigravity', 'copilot']);
const SURFACE_ONLY_CLIENTS = new Set(['herdr']);
const ATTRIBUTION_ONLY_PROVIDERS = new Set([
  'ollama',
  'openrouter',
  'deepseek',
  'third-party',
  'thirdParty',
  'mimo',
  'grok',
  'kimi',
  'zai',
  'zai-team',
  'volcengine',
  'minimax',
  'qoder',
  'qoder-cn',
  'kiro',
  'workbuddy',
  'commandcode'
]);

function capabilityForAgentLifecycleClient(clientId, options = {}) {
  const id = String(clientId || '').trim();
  const doctor = options.doctor || {};
  if (EXACT_ADAPTERS.has(id)) {
    const passed = doctor[id]?.ok === true || doctor[id]?.capability === 'exact' || options.doctorPassed === true;
    return {
      clientId: id,
      capability: passed ? 'exact' : 'presence_only',
      reason: passed ? `${id}_doctor_passed` : `${id}_doctor_required`
    };
  }
  if (PRESENCE_ONLY_CLIENTS.has(id)) {
    return {
      clientId: id,
      capability: 'presence_only',
      reason: `${id}_stable_hooks_unproven`
    };
  }
  if (SURFACE_ONLY_CLIENTS.has(id)) {
    return {
      clientId: id,
      capability: 'surface_only',
      reason: 'herdr_is_origin_enrichment'
    };
  }
  if (ATTRIBUTION_ONLY_PROVIDERS.has(id)) {
    return {
      clientId: id,
      capability: 'attribution_only',
      reason: 'model_provider_not_lifecycle_adapter'
    };
  }
  return {
    clientId: id,
    capability: 'unknown',
    reason: 'unknown_client'
  };
}

function agentLifecycleCapabilityMatrix(options = {}) {
  const ids = options.clientIds || [
    'claude',
    'codex',
    'hermes',
    'opencode',
    'antigravity',
    'copilot',
    'herdr',
    'ollama',
    'openrouter',
    'deepseek'
  ];
  return Object.fromEntries(ids.map((id) => [id, capabilityForAgentLifecycleClient(id, options)]));
}

module.exports = {
  agentLifecycleCapabilityMatrix,
  capabilityForAgentLifecycleClient
};
