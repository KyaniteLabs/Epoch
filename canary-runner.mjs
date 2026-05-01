#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Canary Runner
// Tests different LLM models' ability to discover and use Epoch tools.
// Reads API keys from environment variables — never hardcodes them.
// ---------------------------------------------------------------------------

const EPOCH_URL = process.env.EPOCH_URL || "http://localhost:3099";

// ---- Provider definitions ---------------------------------------------------

const PROVIDERS = [
  // Anthropic-compatible providers
  {
    name: "GLM-5.1",
    apiType: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic/v1",
    authToken: process.env.GLM_AUTH_TOKEN,
    model: "glm-5.1",
  },
  {
    name: "GLM-5-turbo",
    apiType: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic/v1",
    authToken: process.env.GLM_AUTH_TOKEN,
    model: "glm-5-turbo",
  },
  {
    name: "Minimax-M2.7",
    apiType: "openai",
    baseURL: "https://api.minimaxi.chat/v1",
    authToken: process.env.MINIMAX_API_KEY,
    model: "MiniMax-M2.7",
  },
  // Tali Scale / LM Studio providers loaded separately via --tali flag
];

// ---- Canary tasks -----------------------------------------------------------

const CANARY_TASKS = [
  {
    id: "discover",
    prompt:
      "What tools are available in the Epoch API? List them all with their descriptions. The API is at " + EPOCH_URL + ". Check the /llms.txt and /openapi.json endpoints.",
    validate: (text) => {
      const toolNames = [
        "get_current_time", "convert_timezone", "parse_duration", "time_math",
        "add_business_days", "count_business_days", "pert_estimate",
        "cocomo_estimate", "sprint_forecast", "critical_path",
        "monte_carlo_schedule", "reference_class_estimate",
        "calibrate_estimates", "token_time_bridge",
      ];
      const found = toolNames.filter((t) => text.toLowerCase().includes(t.replace(/_/g, " ")) || text.includes(t));
      return { pass: found.length >= 10, detail: `Found ${found.length}/14 tools: ${found.join(", ")}` };
    },
  },
  {
    id: "current-time",
    prompt:
      "Use the Epoch API at " + EPOCH_URL + " to get the current time in Tokyo, Japan. Make the actual API call and tell me the result.",
    validate: (text) => {
      const hasTokyo = text.includes("Tokyo") || text.includes("Asia/Tokyo") || text.includes("JST") || text.includes("GMT+9");
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
      const hasExpected = text.includes("5") || text.includes("6") || text.includes("7") || text.includes("7.17");
      const hasConfidence = text.includes("confidence") || text.includes("interval") || text.includes("95");
      const hasUnit = text.includes("hour") || text.includes("Hour");
      return { pass: hasExpected && hasConfidence, detail: `hasExpected=${hasExpected}, hasConfidence=${hasConfidence}, hasUnit=${hasUnit}` };
    },
  },
  {
    id: "business-days",
    prompt:
      "How many business days are there between May 1, 2026 and May 31, 2026 in the US? " +
      "Use the Epoch API at " + EPOCH_URL + " to calculate this exactly.",
    validate: (text) => {
      const hasNumber = /\d+/.test(text) && (text.match(/\d+/g) || []).some((n) => {
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
      const hasEstimate = text.includes("estimat") || text.includes("duration") || text.includes("time");
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
      const hasP50 = text.includes("p50") || text.includes("50th") || text.includes("median");
      const hasP95 = text.includes("p95") || text.includes("95th");
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasP50 && hasNumber, detail: `hasP50=${hasP50}, hasP95=${hasP95}, hasNumber=${hasNumber}` };
    },
  },
];

// ---- API call helpers -------------------------------------------------------

async function callAnthropic(provider, messages) {
  const res = await fetch(`${provider.baseURL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.authToken,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.map((c) => c.text || "").join("") || "";
}

async function callOpenAI(provider, messages) {
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.authToken}`,
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      messages,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callModel(provider, messages) {
  if (provider.apiType === "anthropic") return callAnthropic(provider, messages);
  return callOpenAI(provider, messages);
}

// ---- Runner -----------------------------------------------------------------

async function runCanary(provider, task) {
  const messages = [{ role: "user", content: task.prompt }];

  try {
    const response = await callModel(provider, messages);
    const validation = task.validate(response);

    return {
      provider: provider.name,
      model: provider.model,
      task: task.id,
      apiType: provider.apiType,
      status: validation.pass ? "PASS" : "FAIL",
      detail: validation.detail,
      responsePreview: response.slice(0, 300),
    };
  } catch (err) {
    return {
      provider: provider.name,
      model: provider.model,
      task: task.id,
      apiType: provider.apiType,
      status: "ERROR",
      detail: err.message,
      responsePreview: "",
    };
  }
}

async function main() {
  // Filter to providers that have auth tokens
  const activeProviders = PROVIDERS.filter((p) => {
    if (p.authToken && p.authToken !== "lm-studio") return true;
    if (p.apiType === "openai") return true; // LM Studio doesn't need real key
    return false;
  });

  console.log(`\nEpoch Canary Runner`);
  console.log(`==================`);
  console.log(`Providers: ${activeProviders.length}`);
  console.log(`Tasks: ${CANARY_TASKS.length}`);
  console.log(`Total canaries: ${activeProviders.length * CANARY_TASKS.length}\n`);

  const results = [];

  // Run all canaries
  for (const provider of activeProviders) {
    console.log(`\n--- ${provider.name} (${provider.apiType}) ---`);
    for (const task of CANARY_TASKS) {
      process.stdout.write(`  ${task.id}... `);
      const result = await runCanary(provider, task);
      results.push(result);
      const icon = result.status === "PASS" ? "OK" : result.status === "FAIL" ? "FAIL" : "ERR";
      console.log(`${icon} — ${result.detail}`);
    }
  }

  // Summary
  console.log(`\n\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);

  const byProvider = {};
  for (const r of results) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { pass: 0, fail: 0, error: 0, total: 0 };
    byProvider[r.provider].total++;
    if (r.status === "PASS") byProvider[r.provider].pass++;
    else if (r.status === "FAIL") byProvider[r.provider].fail++;
    else byProvider[r.provider].error++;
  }

  for (const [name, counts] of Object.entries(byProvider)) {
    const pct = Math.round((counts.pass / counts.total) * 100);
    const bar = "=".repeat(counts.pass) + "-".repeat(counts.fail) + "x".repeat(counts.error);
    console.log(`  ${name.padEnd(22)} ${pct}% (${counts.pass}/${counts.total}) [${bar}]`);
  }

  const totalPass = results.filter((r) => r.status === "PASS").length;
  const totalFail = results.filter((r) => r.status === "FAIL").length;
  const totalError = results.filter((r) => r.status === "ERROR").length;
  console.log(`\n  TOTAL: ${totalPass} pass, ${totalFail} fail, ${totalError} error out of ${results.length}`);

  // Print failure details
  const failures = results.filter((r) => r.status !== "PASS");
  if (failures.length > 0) {
    console.log(`\n\nFAILURES & ERRORS:`);
    for (const f of failures) {
      console.log(`\n  [${f.status}] ${f.provider} / ${f.task}`);
      console.log(`    Detail: ${f.detail}`);
      if (f.responsePreview) {
        console.log(`    Response: ${f.responsePreview.slice(0, 200)}...`);
      }
    }
  }
}

main().catch(console.error);
