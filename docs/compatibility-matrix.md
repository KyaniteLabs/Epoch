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

The canary runner (`canary-runner.mjs`) tests 5 tasks against each model:
1. **current-time** — Tool call to get current time in Tokyo
2. **pert-estimate** — PERT calculation via API
3. **business-days** — Business day counting
4. **token-bridge** — Token-to-time estimation
5. **schema-compliance** — Direct POST with exact schema

Each test validates the response text for expected patterns (time format, numerical ranges, key phrases).
