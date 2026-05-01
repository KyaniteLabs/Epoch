#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Canary Runner v2 — Comprehensive Cross-Model Compatibility Matrix
// Tests every model across every available compatibility layer.
// Loads/unloads its own JIT models on LM Studio — never touches others'.
// ---------------------------------------------------------------------------

const EPOCH_URL = process.env.EPOCH_URL || "http://localhost:3099";
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://100.66.225.85:1234";

// Models with known parameter counts below 1B are marked as "tiny"
// and skipped by default. Use --include-tiny or INCLUDE_TINY_MODELS=1 to override.
const MODEL_TIERS = {
  "smollm2-360m-instruct": "tiny",   // 360M params
  // Add others as discovered
};

// ---- Reasoning token stripper -----------------------------------------------

function stripReasoning(text) {
  let out = text;
  // Remove <think...>...</think...> blocks (handles <think/>, <thinking>, etc.)
  out = out.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, "");
  // Remove <reasoning>...</reasoning> blocks
  out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  // Remove <|...|> special tokens (Qwen and others)
  out = out.replace(/<\|[^>]*\|>/g, "");
  return out.trim();
}

// ---- Canary tasks -----------------------------------------------------------

const CANARY_TASKS = [
  {
    id: "current-time",
    prompt:
      "Use the Epoch API at " + EPOCH_URL + " to get the current time in Tokyo, Japan. Make the actual API call and tell me the result.",
    validate: (text) => {
      const hasTokyo = /Tokyo|Asia\/Tokyo|JST|GMT\+9/i.test(text);
      const hasTime = /\d{1,2}:\d{2}/.test(text);
      return { pass: hasTokyo && hasTime, detail: `hasTokyo=${hasTokyo}, hasTime=${hasTime}` };
    },
  },
  {
    id: "pert-estimate",
    prompt:
      "I need a PERT estimate for a coding task. Best case 2 hours, most likely 5 hours, worst case 20 hours. " +
      "Use the Epoch API at " + EPOCH_URL + " to calculate this. What's the expected duration and confidence interval?",
    validate: (text) => {
      const hasExpected = /\b[5-8]\b/.test(text);
      const hasConfidence = /confidence|interval|95/i.test(text);
      const hasUnit = /hour/i.test(text);
      return { pass: hasExpected && hasConfidence, detail: `hasExpected=${hasExpected}, hasConfidence=${hasConfidence}, hasUnit=${hasUnit}` };
    },
  },
  {
    id: "business-days",
    prompt:
      "How many business days are there between May 1, 2026 and May 31, 2026 in the US? " +
      "Use the Epoch API at " + EPOCH_URL + " to calculate this exactly.",
    validate: (text) => {
      const hasNumber = (text.match(/\d+/g) || []).some((n) => {
        const v = parseInt(n, 10);
        return v >= 18 && v <= 23;
      });
      return { pass: hasNumber, detail: `hasReasonableNumber=${hasNumber}` };
    },
  },
  {
    id: "token-bridge",
    prompt:
      "I'm planning to use 100,000 tokens with Claude Sonnet 4 for a deep reasoning task with about 20 tool calls. " +
      "Use the Epoch API at " + EPOCH_URL + " to estimate how long this will take in wall-clock time.",
    validate: (text) => {
      const hasDuration = /\d+\s*(min|hour|sec|minute)/i.test(text);
      const hasEstimate = /estimat|duration|time/i.test(text);
      return { pass: hasDuration && hasEstimate, detail: `hasDuration=${hasDuration}, hasEstimate=${hasEstimate}` };
    },
  },
  {
    id: "schema-compliance",
    prompt:
      "Call the Epoch API at " + EPOCH_URL + " endpoint POST /v1/tools/monte_carlo_schedule with a single task: " +
      'name="backend-api", optimistic=3, most_likely=7, pessimistic=15. Use 5000 iterations. ' +
      "Return the p50 and p95 values from the response.",
    validate: (text) => {
      const hasP50 = /p50|50th|median/i.test(text);
      const hasP95 = /p95|95th/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasP50 && hasNumber, detail: `hasP50=${hasP50}, hasP95=${hasP95}, hasNumber=${hasNumber}` };
    },
  },
];

// ---- API call helpers -------------------------------------------------------

async function callAnthropic(baseURL, authToken, model, messages) {
  const res = await fetch(`${baseURL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": authToken,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: 2048, messages }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.map((c) => c.text || "").join("") || "";
}

async function callOpenAI(baseURL, authToken, model, messages) {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ model, max_tokens: 2048, messages, temperature: 0.3 }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---- LM Studio model management -------------------------------------------

async function lmStudioLoad(modelId) {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  });
  const data = await res.json();
  if (data.status !== "loaded") throw new Error(`Load failed: ${JSON.stringify(data)}`);
  return data;
}

async function lmStudioUnload(instanceId) {
  await fetch(`${LM_STUDIO_URL}/api/v1/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_id: instanceId }),
  });
}

async function lmStudioListLoaded() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v0/models`);
  const data = await res.json();
  return data.data?.filter((m) => m.state === "loaded").map((m) => m.id) || [];
}

// ---- Epoch API health & discovery -------------------------------------------

async function checkEpochHealth() {
  try {
    const res = await fetch(`${EPOCH_URL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, version: data.version, tools: data.tools };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchEpochTools() {
  try {
    const res = await fetch(`${EPOCH_URL}/openapi.json`);
    if (!res.ok) return [];
    const spec = await res.json();
    const paths = spec.paths || {};
    return Object.keys(paths)
      .filter((p) => p.startsWith("/v1/tools/"))
      .map((p) => p.replace("/v1/tools/", ""));
  } catch {
    return [];
  }
}

// ---- Runner -----------------------------------------------------------------

async function runCanary(provider, task) {
  const toolContext = availableTools.length > 0
    ? `\n\nAvailable Epoch API tools (POST ${EPOCH_URL}/v1/tools/{name}): ${availableTools.join(", ")}. Use JSON request bodies.`
    : "";
  const messages = [
    { role: "system", content: `You are a helpful assistant with access to the Epoch Time Estimation API at ${EPOCH_URL}.${toolContext}` },
    { role: "user", content: task.prompt },
  ];
  try {
    let response;
    if (provider.apiType === "anthropic") {
      response = await callAnthropic(provider.baseURL, provider.authToken, provider.model, messages);
    } else {
      response = await callOpenAI(provider.baseURL, provider.authToken, provider.model, messages);
    }
    const cleaned = stripReasoning(response);
    const validation = task.validate(cleaned);
    return {
      provider: provider.name,
      model: provider.model,
      apiType: provider.apiType,
      task: task.id,
      status: validation.pass ? "PASS" : "FAIL",
      detail: validation.detail,
      responsePreview: cleaned.slice(0, 200),
    };
  } catch (err) {
    return {
      provider: provider.name,
      model: provider.model,
      apiType: provider.apiType,
      task: task.id,
      status: "ERROR",
      detail: err.message,
      responsePreview: "",
    };
  }
}

async function runProviderMatrix(provider, results) {
  console.log(`\n--- ${provider.name} (${provider.apiType}) ---`);
  for (const task of CANARY_TASKS) {
    process.stdout.write(`  ${task.id}... `);
    const result = await runCanary(provider, task);
    results.push(result);
    const icon = result.status === "PASS" ? "OK" : result.status === "FAIL" ? "FAIL" : "ERR";
    console.log(`${icon} — ${result.detail}`);
  }
}

function printSummary(results) {
  console.log(`\n\n${"=".repeat(70)}`);
  console.log(`SUMMARY — ${results.length} canaries`);
  console.log(`${"=".repeat(70)}`);

  const byProvider = {};
  for (const r of results) {
    const key = `${r.provider} [${r.apiType}]`;
    if (!byProvider[key]) byProvider[key] = { pass: 0, fail: 0, error: 0, total: 0 };
    byProvider[key].total++;
    if (r.status === "PASS") byProvider[key].pass++;
    else if (r.status === "FAIL") byProvider[key].fail++;
    else byProvider[key].error++;
  }

  for (const [name, counts] of Object.entries(byProvider)) {
    const pct = Math.round((counts.pass / counts.total) * 100);
    const bar = "=".repeat(counts.pass) + "-".repeat(counts.fail) + "x".repeat(counts.error);
    console.log(`  ${name.padEnd(40)} ${String(pct).padStart(3)}% (${counts.pass}/${counts.total}) [${bar}]`);
  }

  const totalPass = results.filter((r) => r.status === "PASS").length;
  const totalFail = results.filter((r) => r.status === "FAIL").length;
  const totalError = results.filter((r) => r.status === "ERROR").length;
  console.log(`\n  TOTAL: ${totalPass} pass, ${totalFail} fail, ${totalError} error out of ${results.length}`);

  const failures = results.filter((r) => r.status !== "PASS");
  if (failures.length > 0) {
    console.log(`\nFAILURES & ERRORS:`);
    for (const f of failures) {
      console.log(`\n  [${f.status}] ${f.provider} / ${f.task}`);
      console.log(`    Detail: ${f.detail}`);
      if (f.responsePreview) console.log(`    Preview: ${f.responsePreview.slice(0, 150)}...`);
    }
  }
}

// ---- Main -------------------------------------------------------------------

async function main() {
  // Health check — fail fast if Epoch isn't running
  console.log("Checking Epoch API health...");
  const health = await checkEpochHealth();
  if (!health.ok) {
    console.error(`ERROR: Epoch API not reachable at ${EPOCH_URL}: ${health.error}`);
    console.error("Start the server first: node dist/index.js serve");
    process.exit(1);
  }
  console.log(`Epoch API v${health.version} — ${health.tools} tools loaded`);

  const availableTools = await fetchEpochTools();
  console.log(`Available tools: ${availableTools.join(", ") || "(could not fetch)"}`);

  const results = [];

  // ---- Phase 0: Surface tests (Epoch API directly — validates MCP/CLI/HTTP) --
  console.log("\n--- Phase 0: Epoch Surface Tests (API directly) ---");
  const surfaceTests = [
    {
      name: "get_current_time",
      body: { timezone: "Asia/Tokyo" },
      validate: (data) => data.timezone === "Asia/Tokyo" && /\d{2}:\d{2}/.test(data.humanReadable),
    },
    {
      name: "pert_estimate",
      body: { optimistic: 2, most_likely: 5, pessimistic: 20, unit: "hours" },
      validate: (data) => data.expected > 5 && data.expected < 15 && data.confidence95.length === 2,
    },
    {
      name: "count_business_days",
      body: { start_date: "2026-05-01", end_date: "2026-05-31", country: "US" },
      validate: (data) => data.businessDays >= 18 && data.businessDays <= 23,
    },
    {
      name: "token_time_bridge",
      body: { tokens: 100000, model: "claude-sonnet-4-20250514", tool_calls: 20, reasoning_depth: "deep" },
      validate: (data) => data.estimatedSeconds > 0 && data.estimatedMinutes > 0,
    },
    {
      name: "monte_carlo_schedule",
      body: { tasks: [{ name: "backend-api", optimistic: 3, most_likely: 7, pessimistic: 15 }], iterations: 5000 },
      validate: (data) => parseFloat(data.p50) > 0 && parseFloat(data.p95) > 0,
    },
  ];

  for (const test of surfaceTests) {
    process.stdout.write(`  ${test.name}... `);
    try {
      const res = await fetch(`${EPOCH_URL}/v1/tools/${test.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(test.body),
      });
      const json = await res.json();
      if (!json.ok) {
        results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: json.error?.message || "unknown error", responsePreview: "" });
        console.log(`ERR — ${json.error?.message}`);
        continue;
      }
      const pass = test.validate(json.data);
      results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: pass ? "PASS" : "FAIL", detail: `validate=${pass}`, responsePreview: JSON.stringify(json.data).slice(0, 200) });
      console.log(pass ? "OK" : "FAIL — validation failed");
    } catch (err) {
      results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: err.message, responsePreview: "" });
      console.log(`ERR — ${err.message}`);
    }
  }

  // ---- Phase 1: GLM (Anthropic layer only — OpenAI blocked) ----------------
  const glmToken = process.env.GLM_AUTH_TOKEN;
  if (glmToken) {
    const glmModels = ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5-turbo", "glm-5.1"];
    for (const model of glmModels) {
      await runProviderMatrix({
        name: `GLM/${model}`,
        apiType: "anthropic",
        baseURL: "https://api.z.ai/api/anthropic/v1",
        authToken: glmToken,
        model,
      }, results);
    }
  } else {
    console.log("GLM_AUTH_TOKEN not set — skipping GLM providers");
  }

  // ---- Phase 2: Minimax (both OpenAI and Anthropic layers) -----------------
  const minimaxKey = process.env.MINIMAX_API_KEY;
  if (minimaxKey) {
    const minimaxModels = ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"];

    // Test OpenAI compatibility layer
    for (const model of minimaxModels) {
      await runProviderMatrix({
        name: `Minimax/${model}`,
        apiType: "openai",
        baseURL: "https://api.minimaxi.chat/v1",
        authToken: minimaxKey,
        model,
      }, results);
    }

    // Test Anthropic compatibility layer
    for (const model of minimaxModels) {
      await runProviderMatrix({
        name: `Minimax-Anthropic/${model}`,
        apiType: "anthropic",
        baseURL: "https://api.minimaxi.chat/anthropic/v1",
        authToken: minimaxKey,
        model,
      }, results);
    }
  } else {
    console.log("MINIMAX_API_KEY not set — skipping Minimax providers");
  }

  // ---- Phase 3: LM Studio JIT models --------------------------------------
  const jitModels = ["smollm2-360m-instruct", "gemma-4-e2b-it", "lfm2-8b-a1b", "qwen3.5-2b"];

  // Snapshot currently loaded models (belong to other projects)
  const preLoaded = await lmStudioListLoaded();
  console.log(`\n--- LM Studio JIT Phase (pre-loaded by others: ${preLoaded.join(", ")}) ---`);

  for (const modelId of jitModels) {
    console.log(`\n  >> Loading ${modelId}...`);
    try {
      await lmStudioLoad(modelId);
      console.log(`  >> Loaded ${modelId}`);
    } catch (err) {
      console.log(`  >> SKIP ${modelId}: ${err.message}`);
      continue;
    }

    // Check tier — skip canary for tiny models unless overridden
    const tier = MODEL_TIERS[modelId];
    if (tier === "tiny" && !process.env.INCLUDE_TINY_MODELS) {
      console.log(`  >> SKIP canary for ${modelId} (sub-1B model, set INCLUDE_TINY_MODELS=1 to test)`);
    } else {
      // Run canary against this model
      await runProviderMatrix({
        name: `LMStudio/${modelId}`,
        apiType: "openai",
        baseURL: `${LM_STUDIO_URL}/v1`,
        authToken: "lm-studio",
        model: modelId,
      }, results);
    }

    // Unload immediately
    console.log(`  >> Unloading ${modelId}...`);
    await lmStudioUnload(modelId);
    console.log(`  >> Unloaded ${modelId}`);
  }

  // Verify we didn't pollute the server
  const postLoaded = await lmStudioListLoaded();
  const polluted = postLoaded.filter((m) => !preLoaded.includes(m));
  if (polluted.length > 0) {
    console.log(`\n  WARNING: Models left loaded that shouldn't be: ${polluted.join(", ")}`);
    for (const m of polluted) {
      await lmStudioUnload(m);
      console.log(`  Cleaned up: ${m}`);
    }
  } else {
    console.log(`\n  LM Studio clean — no leftover models.`);
  }

  // ---- Summary -------------------------------------------------------------
  printSummary(results);
}

main().catch(console.error);
