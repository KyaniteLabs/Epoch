#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Function-Calling Canary
// Tests models through proper tool-use / function-calling interfaces.
// Models get tool definitions, generate structured tool calls, the runtime
// executes them against Epoch, and results get fed back for summarization.
// ---------------------------------------------------------------------------

const EPOCH_URL = process.env.EPOCH_URL || "http://localhost:3099";

// ---- Fetch tool definitions from OpenAPI spec -------------------------------

async function fetchToolDefinitions() {
  const res = await fetch(`${EPOCH_URL}/openapi.json`);
  const spec = await res.json();
  const tools = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith("/v1/tools/")) continue;
    const toolName = path.replace("/v1/tools/", "");
    const post = methods.post;
    const inputSchema = post.requestBody?.content?.["application/json"]?.schema || { type: "object" };

    tools.push({
      name: toolName,
      description: post.summary || toolName,
      inputSchema,
    });
  }

  return tools;
}

// ---- Convert OpenAPI schemas to OpenAI function format ----------------------

function openApiToOpenAITools(tools) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---- Convert OpenAPI schemas to Anthropic tool format -----------------------

function openApiToAnthropicTools(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ---- Canary task definitions ------------------------------------------------
// Each task defines a user prompt and validation on the final model response.

const CANARY_TASKS = [
  {
    id: "current-time",
    prompt: "What time is it right now in Tokyo, Japan?",
    validate: (text) => {
      const hasTokyo = /Tokyo|Asia\/Tokyo|JST|GMT\+9/i.test(text);
      const hasTime = /\d{1,2}:\d{2}/.test(text);
      return { pass: hasTokyo && hasTime, detail: `hasTokyo=${hasTokyo}, hasTime=${hasTime}` };
    },
  },
  {
    id: "pert-estimate",
    prompt: "I need a PERT estimate. Best case 2 hours, most likely 5 hours, worst case 20 hours. What's the expected duration and confidence interval?",
    validate: (text) => {
      const hasExpected = /\b[5-8]\b/.test(text);
      const hasConfidence = /confidence|interval|95/i.test(text);
      const hasUnit = /hour/i.test(text);
      return { pass: hasExpected && hasConfidence, detail: `hasExpected=${hasExpected}, hasConfidence=${hasConfidence}, hasUnit=${hasUnit}` };
    },
  },
  {
    id: "business-days",
    prompt: "How many business days are there between May 1, 2026 and May 31, 2026 in the US?",
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
    prompt: "I'm planning to use 100,000 tokens with Claude Sonnet 4 for a deep reasoning task with about 20 tool calls. How long will this take?",
    validate: (text) => {
      const hasDuration = /\d+\s*(min|hour|sec|minute)/i.test(text);
      const hasEstimate = /estimat|duration|time/i.test(text);
      return { pass: hasDuration && hasEstimate, detail: `hasDuration=${hasDuration}, hasEstimate=${hasEstimate}` };
    },
  },
  {
    id: "schema-compliance",
    prompt: "Run a Monte Carlo schedule simulation with a single task: name='backend-api', optimistic=3, most_likely=7, pessimistic=15. Use 5000 iterations. Tell me the p50 and p95.",
    validate: (text) => {
      const hasP50 = /p50|50th|median/i.test(text);
      const hasP95 = /p95|95th/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasP50 && hasNumber, detail: `hasP50=${hasP50}, hasP95=${hasP95}, hasNumber=${hasNumber}` };
    },
  },
];

// ---- Tool executor — calls Epoch API ----------------------------------------

async function executeToolCall(toolName, args) {
  try {
    const res = await fetch(`${EPOCH_URL}/v1/tools/${toolName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: { isError: true, message: err.message } };
  }
}

// ---- Reasoning token stripper -----------------------------------------------

function stripReasoning(text) {
  let out = text;
  out = out.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, "");
  out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  out = out.replace(/<\|[^>]*\|>/g, "");
  return out.trim();
}

// ---- OpenAI function-calling runner -----------------------------------------

async function runOpenAIWithTools(baseURL, authToken, model, toolDefs, task) {
  const openaiTools = openApiToOpenAITools(toolDefs);
  const messages = [{ role: "user", content: task.prompt }];

  // Up to 3 rounds of tool calling
  for (let round = 0; round < 3; round++) {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: openaiTools,
        tool_choice: "auto",
        max_tokens: 2048,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    const assistantMsg = choice.message;

    // Add assistant message to conversation
    messages.push(assistantMsg);

    // Check if model made tool calls
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // No tool calls — model gave a direct answer
      return stripReasoning(assistantMsg.content || "");
    }

    // Execute each tool call
    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function.name;
      let toolArgs;
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }

      const result = await executeToolCall(toolName, toolArgs);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // If we exhausted rounds, return the last message
  const last = messages[messages.length - 1];
  return stripReasoning(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
}

// ---- Anthropic tool-use runner -----------------------------------------------

async function runAnthropicWithTools(baseURL, authToken, model, toolDefs, task) {
  const anthropicTools = openApiToAnthropicTools(toolDefs);
  const messages = [{ role: "user", content: task.prompt }];

  for (let round = 0; round < 3; round++) {
    const res = await fetch(`${baseURL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": authToken,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        tools: anthropicTools,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // Process content blocks
    const textBlocks = [];
    const toolUseBlocks = [];

    for (const block of data.content || []) {
      if (block.type === "text") textBlocks.push(block.text);
      if (block.type === "tool_use") toolUseBlocks.push(block);
    }

    // Add assistant response to messages
    messages.push({ role: "assistant", content: data.content });

    if (toolUseBlocks.length === 0) {
      // No tool calls — return text
      return stripReasoning(textBlocks.join(""));
    }

    // Execute tool calls and add results
    const toolResults = [];
    for (const tub of toolUseBlocks) {
      const result = await executeToolCall(tub.name, tub.input || {});
      toolResults.push({
        type: "tool_result",
        tool_use_id: tub.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  const last = messages[messages.length - 1];
  const content = last.content;
  if (typeof content === "string") return stripReasoning(content);
  if (Array.isArray(content)) {
    const texts = content.filter(b => b.type === "tool_result").map(b => b.content);
    return stripReasoning(texts.join(" "));
  }
  return "";
}

// ---- LM Studio model management ---------------------------------------------

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://100.66.225.85:1234";

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

// ---- Provider test runner ---------------------------------------------------

async function runProviderCanary(provider, toolDefs, task) {
  try {
    let response;
    if (provider.apiType === "anthropic") {
      response = await runAnthropicWithTools(provider.baseURL, provider.authToken, provider.model, toolDefs, task);
    } else {
      response = await runOpenAIWithTools(provider.baseURL, provider.authToken, provider.model, toolDefs, task);
    }
    const validation = task.validate(response);
    return {
      provider: provider.name,
      model: provider.model,
      apiType: provider.apiType,
      task: task.id,
      status: validation.pass ? "PASS" : "FAIL",
      detail: validation.detail,
      responsePreview: response.slice(0, 300),
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

async function runProviderMatrix(provider, toolDefs, results) {
  console.log(`\n--- ${provider.name} (${provider.apiType}) ---`);
  for (const task of CANARY_TASKS) {
    process.stdout.write(`  ${task.id}... `);
    const result = await runProviderCanary(provider, toolDefs, task);
    results.push(result);
    const icon = result.status === "PASS" ? "OK" : result.status === "FAIL" ? "FAIL" : "ERR";
    console.log(`${icon} — ${result.detail}`);
  }
}

// ---- Summary printer --------------------------------------------------------

function printSummary(results) {
  console.log(`\n\n${"=".repeat(70)}`);
  console.log(`SUMMARY — ${results.length} function-calling canaries`);
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
      if (f.responsePreview) console.log(`    Preview: ${f.responsePreview.slice(0, 200)}...`);
    }
  }
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log("Fetching tool definitions from Epoch OpenAPI spec...");
  const toolDefs = await fetchToolDefinitions();
  console.log(`Loaded ${toolDefs.length} tool definitions`);

  const results = [];

  // ---- Phase 0: Epoch API direct tests (same as before) --------------------
  console.log("\n--- Phase 0: Epoch Surface Tests (API directly) ---");
  const surfaceTests = [
    { name: "get_current_time", body: { timezone: "Asia/Tokyo" }, validate: (d) => d.timezone === "Asia/Tokyo" && /\d{1,2}:\d{2}/.test(d.humanReadable) },
    { name: "pert_estimate", body: { optimistic: 2, most_likely: 5, pessimistic: 20, unit: "hours" }, validate: (d) => d.expected > 5 && d.confidence95.length === 2 },
    { name: "count_business_days", body: { start_date: "2026-05-01", end_date: "2026-05-31", country: "US" }, validate: (d) => d.businessDays >= 18 && d.businessDays <= 23 },
    { name: "token_time_bridge", body: { tokens: 100000, model: "claude-sonnet-4-20250514", tool_calls: 20, reasoning_depth: "deep" }, validate: (d) => d.estimatedSeconds > 0 && d.estimatedMinutes > 0 },
    { name: "monte_carlo_schedule", body: { tasks: [{ name: "backend-api", optimistic: 3, most_likely: 7, pessimistic: 15 }], iterations: 5000 }, validate: (d) => parseFloat(d.p50) > 0 && parseFloat(d.p95) > 0 },
  ];

  for (const test of surfaceTests) {
    process.stdout.write(`  ${test.name}... `);
    try {
      const res = await fetch(`${EPOCH_URL}/v1/tools/${test.name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(test.body) });
      const json = await res.json();
      if (!json.ok) { results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: json.error?.message || "unknown", responsePreview: "" }); console.log(`ERR — ${json.error?.message}`); continue; }
      const pass = test.validate(json.data);
      results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: pass ? "PASS" : "FAIL", detail: `validate=${pass}`, responsePreview: JSON.stringify(json.data).slice(0, 200) });
      console.log(pass ? "OK" : "FAIL");
    } catch (err) {
      results.push({ provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: err.message, responsePreview: "" });
      console.log(`ERR — ${err.message}`);
    }
  }

  // ---- Phase 1: GLM (Anthropic tool-use layer) -----------------------------
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
      }, toolDefs, results);
    }
  } else {
    console.log("\nGLM_AUTH_TOKEN not set — skipping GLM providers");
  }

  // ---- Phase 2: Minimax (both OpenAI and Anthropic tool-use layers) --------
  const minimaxKey = process.env.MINIMAX_API_KEY;
  if (minimaxKey) {
    const minimaxModels = ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"];

    for (const model of minimaxModels) {
      await runProviderMatrix({
        name: `Minimax/${model}`,
        apiType: "openai",
        baseURL: "https://api.minimaxi.chat/v1",
        authToken: minimaxKey,
        model,
      }, toolDefs, results);
    }

    for (const model of minimaxModels) {
      await runProviderMatrix({
        name: `Minimax-Anthropic/${model}`,
        apiType: "anthropic",
        baseURL: "https://api.minimaxi.chat/anthropic/v1",
        authToken: minimaxKey,
        model,
      }, toolDefs, results);
    }
  } else {
    console.log("\nMINIMAX_API_KEY not set — skipping Minimax providers");
  }

  // ---- Phase 3: LM Studio local models (OpenAI function-calling) -----------
  const jitModels = ["gemma-4-e2b-it", "lfm2-8b-a1b", "qwen3.5-2b"];
  const preLoaded = await lmStudioListLoaded();
  console.log(`\n--- LM Studio JIT Phase (pre-loaded: ${preLoaded.join(", ")}) ---`);

  for (const modelId of jitModels) {
    console.log(`\n  >> Loading ${modelId}...`);
    try {
      await lmStudioLoad(modelId);
      console.log(`  >> Loaded ${modelId}`);
    } catch (err) {
      console.log(`  >> SKIP ${modelId}: ${err.message}`);
      continue;
    }

    await runProviderMatrix({
      name: `LMStudio/${modelId}`,
      apiType: "openai",
      baseURL: `${LM_STUDIO_URL}/v1`,
      authToken: "lm-studio",
      model: modelId,
    }, toolDefs, results);

    console.log(`  >> Unloading ${modelId}...`);
    await lmStudioUnload(modelId);
    console.log(`  >> Unloaded ${modelId}`);
  }

  // Verify no pollution
  const postLoaded = await lmStudioListLoaded();
  const polluted = postLoaded.filter((m) => !preLoaded.includes(m));
  if (polluted.length > 0) {
    console.log(`\n  WARNING: Models left loaded: ${polluted.join(", ")}`);
    for (const m of polluted) { await lmStudioUnload(m); console.log(`  Cleaned up: ${m}`); }
  } else {
    console.log(`\n  LM Studio clean.`);
  }

  // ---- Summary -------------------------------------------------------------
  printSummary(results);
}

main().catch(console.error);
