# Provider Compatibility Matrix

## Tested Configurations

| Provider | Compatibility Layer | Models Tested | Status |
|----------|-------------------|---------------|--------|
| GLM (Z.AI) | Anthropic Messages API | glm-4.5, glm-4.5-air, glm-4.6, glm-4.7, glm-5, glm-5-turbo, glm-5.1 | Working |
| GLM (Z.AI) | OpenAI Chat Completions | All models | Blocked (permission denied) |
| Minimax | OpenAI Chat Completions | MiniMax-M2, MiniMax-M2.1, MiniMax-M2.5, MiniMax-M2.7 | Working |
| Minimax | Anthropic Messages API | All models | Degraded (~40pp lower pass rate) |
| LM Studio | OpenAI Chat Completions | Model-dependent | Working (JIT load/unload) |

## Known Issues

### Minimax Anthropic Layer Degradation

Minimax's Anthropic compatibility layer at `https://api.minimaxi.chat/anthropic/v1` shows approximately 40 percentage point lower canary pass rates compared to their native OpenAI endpoint at `https://api.minimaxi.chat/v1`. This manifests as:

- Tool call parameter omission (missing required fields)
- Schema non-compliance (ignoring field constraints)
- Response format inconsistency

**Recommendation:** Use Minimax's OpenAI compatibility layer for production workloads. The Anthropic layer may improve over time but is currently unreliable for structured tool calling.

### GLM OpenAI Layer Blocked

GLM models are only accessible via the Anthropic compatibility layer at `https://api.z.ai/api/anthropic/v1`. The OpenAI endpoint returns "No permission to access model" for all models regardless of plan tier.

### Sub-1B Model Limitations

Models under 1B parameters (e.g., SmolLM2-360M) generally cannot follow multi-step tool calling instructions. These models should be excluded from canary testing or placed in a separate "compatibility" tier.

## Canary Test Methodology

Epoch has two canary modes:

### Default release canary

`pnpm run canary` runs `node canary-runner.mjs --local-only`. This is the release
gate because it does not depend on external provider credentials or network
availability. It verifies the local Epoch HTTP API surface and failure handling:

- 21 local API surface checks across tool calls and HTTP routes
- 11 local failure-mode checks for schema validation, missing tools, bad inputs,
  and fail-closed behavior
- Non-zero process exit if the local API surface or expected failure semantics break

### Provider compatibility canary

`pnpm run canary:providers` runs `node canary-runner.mjs` and exercises configured
external model providers. Use it when evaluating GLM, Minimax, LM Studio, or other
provider compatibility. These results are compatibility signals, not the default
release gate, because provider availability, credentials, and model behavior can
change independently of Epoch.

Provider runs cover the same local Epoch API assumptions plus model-facing tool-call
and schema-following tasks. Each task validates response text and structured outputs
for expected patterns such as time formats, numerical ranges, and required fields.
