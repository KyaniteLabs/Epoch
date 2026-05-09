#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Function-Calling Canary v3 — Deep Diagnostic Edition
//
// Comprehensive model-tool integration testing with:
//   - Full reasoning/thinking trace capture
//   - Multi-step comorbidity tasks (chained tool calls)
//   - Model confusion pattern detection
//   - Parameter accuracy scoring
//   - Per-round payload logging
//   - Failure pattern taxonomy
//
// Outputs:
//   - Human-readable console summary
//   - canary-report.json with full traces
// ---------------------------------------------------------------------------

const EPOCH_URL = process.env.EPOCH_URL || "http://localhost:3099";
const REPORT_PATH = process.env.CANARY_REPORT || "canary-report.json";

// ---- Telemetry collector -----------------------------------------------------

const telemetry = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  epochUrl: EPOCH_URL,
  results: [],
  surfaceTests: [],
  failureModeTests: [],
  confusionPatterns: [],
  environment: {
    GLM_AUTH_TOKEN: !!process.env.GLM_AUTH_TOKEN,
    MINIMAX_API_KEY: !!process.env.MINIMAX_API_KEY,
    LM_STUDIO_URL: process.env.LM_STUDIO_URL || "http://localhost:1234",
  },
};

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
    tools.push({ name: toolName, description: post.summary || toolName, inputSchema });
  }

  return tools;
}

// ---- Schema converters ------------------------------------------------------

function openApiToOpenAITools(tools) {
  return tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function openApiToAnthropicTools(tools) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// ---- Reasoning extractor ----------------------------------------------------

function extractReasoning(data) {
  const traces = [];

  // OpenAI o-series reasoning
  if (data.choices?.[0]?.message?.reasoning_content) {
    traces.push({ source: "openai_reasoning", content: data.choices[0].message.reasoning_content });
  }

  // Anthropic thinking blocks
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "thinking") {
        traces.push({ source: "anthropic_thinking", content: block.thinking });
      }
    }
  }

  return traces;
}

// ---- Extended task definitions (15 core + 5 multi-step chain) ----------------

const CANARY_TASKS = [
  // ---- Core single-tool tasks (5 original) ---------------------------------
  {
    id: "current-time",
    prompt: "What time is it right now in Tokyo, Japan?",
    expectedTools: ["get_current_time"],
    validate: (text) => {
      const hasTokyo = /Tokyo|Asia\/Tokyo|JST|GMT\+9/i.test(text);
      const hasTime = /\d{1,2}:\d{2}/.test(text);
      return { pass: hasTokyo && hasTime, detail: `hasTokyo=${hasTokyo}, hasTime=${hasTime}` };
    },
  },
  {
    id: "pert-estimate",
    prompt: "I need a PERT estimate. Best case 2 hours, most likely 5 hours, worst case 20 hours. What's the expected duration and confidence interval?",
    expectedTools: ["pert_estimate"],
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
    expectedTools: ["count_business_days"],
    validate: (text) => {
      const hasNumber = (text.match(/\d+/g) || []).some((n) => { const v = parseInt(n, 10); return v >= 18 && v <= 23; });
      return { pass: hasNumber, detail: `hasReasonableNumber=${hasNumber}` };
    },
  },
  {
    id: "token-bridge",
    prompt: "I'm planning to use 100,000 tokens with Claude Sonnet 4 for a deep reasoning task with about 20 tool calls. How long will this take?",
    expectedTools: ["token_time_bridge"],
    validate: (text) => {
      const hasDuration = /\d+\s*(min|hour|sec|minute)/i.test(text);
      const hasEstimate = /estimat|duration|time/i.test(text);
      return { pass: hasDuration && hasEstimate, detail: `hasDuration=${hasDuration}, hasEstimate=${hasEstimate}` };
    },
  },
  {
    id: "monte-carlo",
    prompt: "Run a Monte Carlo schedule simulation with a single task: name='backend-api', optimistic=3, most_likely=7, pessimistic=15. Use 5000 iterations. Tell me the p50 and p95.",
    expectedTools: ["monte_carlo_schedule"],
    validate: (text) => {
      const hasP50 = /p50|50th|median/i.test(text);
      const hasP95 = /p95|95th/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasP50 && hasNumber, detail: `hasP50=${hasP50}, hasP95=${hasP95}, hasNumber=${hasNumber}` };
    },
  },

  // ---- Extended single-tool tasks (10 more) --------------------------------
  {
    id: "convert-timezone",
    prompt: "Convert 2026-06-15T14:30:00Z to Japan time. What's the local time in Tokyo?",
    expectedTools: ["convert_timezone"],
    validate: (text) => {
      const hasTokyo = /Tokyo|Asia\/Tokyo|JST/i.test(text);
      const hasTime = /23:30|\d{1,2}:\d{2}/.test(text);
      return { pass: hasTokyo && hasTime, detail: `hasTokyo=${hasTokyo}, hasTime=${hasTime}` };
    },
  },
  {
    id: "parse-duration",
    prompt: "How many seconds is '3d14h30m'? Parse that duration string for me.",
    expectedTools: ["parse_duration"],
    validate: (text) => {
      const hasSeconds = /\d[\d,]*\d/.test(text);
      const hasHours = /hour|3\s*day|14\s*hour|30\s*min/i.test(text);
      return { pass: hasSeconds && hasHours, detail: `hasSeconds=${hasSeconds}, hasHours=${hasHours}` };
    },
  },
  {
    id: "time-math-diff",
    prompt: "How many days between January 1, 2026 and March 15, 2026?",
    expectedTools: ["time_math"],
    validate: (text) => {
      const hasDays = /\b7[0-9]\b|\b8[0-3]\b/.test(text); // 73 days
      return { pass: hasDays, detail: `hasDays=${hasDays}` };
    },
  },
  {
    id: "add-business-days",
    prompt: "Starting from June 1, 2026, what date is 15 business days later in Germany?",
    expectedTools: ["add_business_days"],
    validate: (text) => {
      const hasDate = /2026-06-\d{2}|June\s+\d{1,2}/i.test(text);
      return { pass: hasDate, detail: `hasDate=${hasDate}` };
    },
  },
  {
    id: "cocomo",
    prompt: "I'm building a 15,000 line-of-code system with medium reasoning complexity, good context, and moderate iteration overhead (around 1.5x). Estimate the effort using COCOMO.",
    expectedTools: ["cocomo_estimate"],
    validate: (text) => {
      const hasMonths = /month|person/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasMonths && hasNumber, detail: `hasMonths=${hasMonths}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "sprint-forecast",
    prompt: "We have 200 story points in the backlog. Our last 4 sprint velocities were 22, 28, 25, 30. We do 2-week sprints. How many sprints to finish?",
    expectedTools: ["sprint_forecast"],
    validate: (text) => {
      const hasSprints = /sprint/i.test(text);
      const hasNumber = /\d+/.test(text);
      return { pass: hasSprints && hasNumber, detail: `hasSprints=${hasSprints}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "critical-path",
    prompt: "Find the critical path for these tasks: Design takes 3 days, Backend takes 10 days (depends on Design), Frontend takes 8 days (depends on Design), Testing takes 5 days (depends on Backend and Frontend).",
    expectedTools: ["critical_path"],
    validate: (text) => {
      const hasCriticalPath = /critical|path|Design.*Backend|Backend.*Testing/i.test(text);
      const hasDuration = /1[8-9]|2[0-6]|total.*\d+/i.test(text);
      return { pass: hasCriticalPath, detail: `hasCriticalPath=${hasCriticalPath}, hasDuration=${hasDuration}` };
    },
  },
  {
    id: "reference-class",
    prompt: "I'm estimating a software feature with complexity 3 out of 5. Use the reference_class_estimate tool to predict how long it'll really take based on historical reference class forecasting.",
    expectedTools: ["reference_class_estimate"],
    validate: (text) => {
      const hasEstimate = /estimat|hour|corrected|factor/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasEstimate && hasNumber, detail: `hasEstimate=${hasEstimate}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "calibrate",
    prompt: "Check the calibration quality for team 'alpha' over the last 90 days.",
    expectedTools: ["calibrate_estimates"],
    validate: (text) => {
      const hasCalibration = /calibrat|accuracy|trend|MAPE|bias/i.test(text);
      return { pass: hasCalibration, detail: `hasCalibration=${hasCalibration}` };
    },
  },
  {
    id: "cross-unit-hours-days",
    prompt: "Give me a PERT estimate with best case 16 hours, most likely 3 days, worst case 2 weeks. I know the units are mixed — use days as the unit.",
    expectedTools: ["pert_estimate"],
    validate: (text) => {
      const hasNumber = /\d+/.test(text);
      const hasDaysOrWeeks = /day|week/i.test(text);
      return { pass: hasNumber, detail: `hasNumber=${hasNumber}, hasDaysOrWeeks=${hasDaysOrWeeks}` };
    },
  },
];

// ---- Harder edge-case tasks (added for iterative hardening loop) -----------

const HARDER_TASKS = [
  {
    id: "time-math-diff-start-date",
    prompt: "Calculate the difference between 2026-01-15 and 2026-06-30 using time_math.",
    expectedTools: ["time_math"],
    validate: (text) => {
      const hasNumber = /\d+/.test(text);
      const hasDayOrDiff = /day|diff|between/i.test(text);
      return { pass: hasNumber && hasDayOrDiff, detail: `hasNumber=${hasNumber}, hasDayOrDiff=${hasDayOrDiff}` };
    },
  },
  {
    id: "token-bridge-unknown-model",
    prompt: "I'm using a custom fine-tuned model called 'my-llama-8b-finetune'. How long would 25,000 tokens take with it?",
    expectedTools: ["token_time_bridge"],
    validate: (text) => {
      const hasDuration = /\d+\s*(min|sec|hour)/i.test(text);
      const hasEstimate = /estimat|time|duration/i.test(text);
      return { pass: hasDuration || hasEstimate, detail: `hasDuration=${hasDuration}, hasEstimate=${hasEstimate}` };
    },
  },
  {
    id: "cocomo-high-cycles",
    prompt: "Estimate effort for a 50 KLOC system using COCOMO with high iteration overhead of 1.8 and heavy human oversight of 2.0.",
    expectedTools: ["cocomo_estimate"],
    validate: (text) => {
      const hasMonths = /month|person/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasMonths && hasNumber, detail: `hasMonths=${hasMonths}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "pert-float-inputs",
    prompt: "Give me a PERT estimate where optimistic is 2.5 hours, most likely is 4.75 hours, pessimistic is 11.25 hours.",
    expectedTools: ["pert_estimate"],
    validate: (text) => {
      const hasExpected = /\d+\.\d+/.test(text);
      const hasHours = /hour/i.test(text);
      return { pass: hasExpected && hasHours, detail: `hasExpected=${hasExpected}, hasHours=${hasHours}` };
    },
  },
  {
    id: "montecarlo-max-iterations",
    prompt: "Run a Monte Carlo simulation with 50,000 iterations on these 2 tasks: Backend (optimistic 5, most likely 12, pessimistic 25 days) and Frontend (optimistic 3, most likely 8, pessimistic 18 days).",
    expectedTools: ["monte_carlo_schedule"],
    validate: (text) => {
      const hasP50 = /p50|median/i.test(text);
      const hasNumber = /\d+/.test(text);
      return { pass: hasP50, detail: `hasP50=${hasP50}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "reference-class-bugfix",
    prompt: "I need a reference class estimate for a bugfix task with complexity 2. Use the reference_class_estimate tool.",
    expectedTools: ["reference_class_estimate"],
    validate: (text) => {
      const hasEstimate = /estimat|hour|corrected|factor/i.test(text);
      const hasNumber = /\d+\.\d+/.test(text);
      return { pass: hasEstimate || hasNumber, detail: `hasEstimate=${hasEstimate}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "add-business-days-cross-month",
    prompt: "Add 10 business days to 2026-12-18 in the US. I need to know the deadline accounting for Christmas and New Year.",
    expectedTools: ["add_business_days"],
    validate: (text) => {
      const hasDate = /202[67]-\d{2}-\d{2}/.test(text);
      const hasJanuary = /jan|2027/i.test(text);
      const hasDeadline = /deadline|january|business day/i.test(text);
      return { pass: hasDate || (hasJanuary && hasDeadline), detail: `hasDate=${hasDate}, crossesInto2027=${hasJanuary}, hasDeadline=${hasDeadline}` };
    },
  },
  {
    id: "sprint-zero-velocity",
    prompt: "We have 50 story points in the backlog but our only completed sprint had 0 velocity. Forecast how many sprints we need with 2-week sprints.",
    expectedTools: ["sprint_forecast"],
    validate: (text) => {
      const hasSprint = /sprint/i.test(text);
      const hasNumber = /\d+/.test(text);
      return { pass: hasSprint, detail: `hasSprint=${hasSprint}, hasNumber=${hasNumber}` };
    },
  },
  {
    id: "critical-path-linear-chain",
    prompt: "Find the critical path for this linear chain: Design (3 days) → Backend (10 days, depends on Design) → Testing (5 days, depends on Backend) → Deploy (1 day, depends on Testing).",
    expectedTools: ["critical_path"],
    validate: (text) => {
      const hasCritical = /critical/i.test(text);
      const hasDays = /19|total/i.test(text);
      return { pass: hasCritical, detail: `hasCritical=${hasCritical}, hasDays=${hasDays}` };
    },
  },
  {
    id: "calibrate-small-team",
    prompt: "Check estimation calibration for team 'rocket' over the last 30 days with at least 3 samples.",
    expectedTools: ["calibrate_estimates"],
    validate: (text) => {
      const hasMape = /mape|bias|accuracy|calibrat/i.test(text);
      const hasNumber = /\d+/.test(text);
      return { pass: hasMape || hasNumber, detail: `hasMape=${hasMape}, hasNumber=${hasNumber}` };
    },
  },
];

// ---- Comorbidity tasks (multi-step, ambiguous, confusion-inducing) ----------

const CHAIN_TASKS = [
  {
    id: "comorbid-timezone-then-business-days",
    prompt: "What's the current time in New York? Then tell me how many business days remain in May 2026 (US calendar).",
    expectedTools: ["get_current_time", "count_business_days"],
    minToolCalls: 2,
    validate: (text) => {
      const hasNYTime = /New\s*York|EST|EDT|America\/New_York|\d{1,2}:\d{2}/i.test(text);
      const hasBizDays = /\d+\s*business\s*day/i.test(text);
      return { pass: hasNYTime && hasBizDays, detail: `hasNYTime=${hasNYTime}, hasBizDays=${hasBizDays}` };
    },
  },
  {
    id: "comorbid-token-bridge-then-timezone",
    prompt: "If I run 50,000 tokens through GPT-4o with 10 tool calls and moderate reasoning, how long will it take? If I start at 2pm New York time, what time will it finish in London?",
    expectedTools: ["token_time_bridge", "convert_timezone"],
    minToolCalls: 2,
    validate: (text) => {
      const hasDuration = /\d+\s*(min|hour|sec)/i.test(text);
      const hasLondon = /London|UTC|GMT|BST/i.test(text);
      return { pass: hasDuration || hasLondon, detail: `hasDuration=${hasDuration}, hasLondon=${hasLondon}` };
    },
  },
  {
    id: "comorbid-ambiguous-tool",
    prompt: "How long is 3d12h?",
    expectedTools: ["parse_duration"],
    expectedNotTools: ["time_math", "pert_estimate"],
    validate: (text) => {
      const hasSeconds = /306000|306\s*000|3\s*day|12\s*hour|84\s*hour/i.test(text);
      return { pass: hasSeconds, detail: `hasSeconds=${hasSeconds}` };
    },
  },
  {
    id: "comorbid-pert-then-sprint",
    prompt: "Give me a PERT estimate: optimistic 40 hours, most likely 80 hours, pessimistic 200 hours. Then use that expected value as the backlog size for a sprint forecast with velocity history [20, 25, 22, 28] and 2-week sprints.",
    expectedTools: ["pert_estimate", "sprint_forecast"],
    minToolCalls: 2,
    validate: (text) => {
      const hasExpected = /\b(?:8[0-9]|9[0-9]|10[0-9]|110)\b/.test(text);
      const hasSprint = /sprint/i.test(text);
      return { pass: hasExpected || hasSprint, detail: `hasExpected=${hasExpected}, hasSprint=${hasSprint}` };
    },
  },
  {
    id: "comorbid-montecarlo-critical-path",
    prompt: "I have 3 tasks for a Monte Carlo simulation: API (O=3,ML=7,P=15), Database (O=2,ML=5,P=12), Frontend (O=4,ML=8,P=20). Run 10000 iterations. Also find the critical path assuming API takes 7 days, Database takes 5 days (depends on API), Frontend takes 8 days (depends on API).",
    expectedTools: ["monte_carlo_schedule", "critical_path"],
    minToolCalls: 2,
    validate: (text) => {
      const hasPercentile = /p50|p95|median|percentile/i.test(text);
      const hasCritical = /critical|path/i.test(text);
      return { pass: hasPercentile || hasCritical, detail: `hasPercentile=${hasPercentile}, hasCritical=${hasCritical}` };
    },
  },
];

// ---- Failure-mode test definitions ------------------------------------------

const FAILURE_MODE_TASKS = [
  {
    id: "invalid-timezone",
    name: "get_current_time",
    body: { timezone: "Mars/Olympus_Mons" },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success: ${JSON.stringify(result.data).slice(0, 100)}` };
      const hasMsg = /timezone|invalid|unknown/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "inverted-pert",
    name: "pert_estimate",
    body: { optimistic: 20, most_likely: 5, pessimistic: 2, unit: "hours" },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success: ${JSON.stringify(result.data).slice(0, 100)}` };
      const hasMsg = /optimistic|most.likely|pessimistic|satisfy|order/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "negative-business-days",
    name: "add_business_days",
    body: { start_date: "2026-05-01", days: -5, country: "US" },
    expectError: false,
    validate: (result) => {
      if (!result.ok) return { pass: false, detail: `Error: ${result.error?.message}` };
      const hasDate = result.data.endDate && /\d{4}-\d{2}-\d{2}/.test(result.data.endDate);
      return { pass: hasDate, detail: `endDate=${result.data.endDate}, hasDate=${hasDate}` };
    },
  },
  {
    id: "unknown-country",
    name: "count_business_days",
    body: { start_date: "2026-05-01", end_date: "2026-05-31", country: "XX" },
    expectError: false,
    validate: (result) => {
      if (!result.ok) return { pass: false, detail: `Error: ${result.error?.message}` };
      const hasDays = typeof result.data.businessDays === "number" && result.data.businessDays > 0;
      const hasCountryCode = result.data.countryCode === "XX";
      return { pass: hasDays, detail: `businessDays=${result.data.businessDays}, countryCode=${result.data.countryCode}, hasDays=${hasDays}, hasCountryCode=${hasCountryCode}` };
    },
  },
  {
    id: "invalid-model-token-bridge",
    name: "token_time_bridge",
    body: { tokens: 100000, model: "fake-model-xyz-999", tool_calls: 20, reasoning_depth: "deep" },
    expectError: false,
    validate: (result) => {
      if (!result.ok) return { pass: false, detail: `Error: ${result.error?.message}` };
      const hasSeconds = result.data.estimatedSeconds > 0;
      const hasConfidence = typeof result.data.confidence === "string" && result.data.confidence.length > 0;
      return { pass: hasSeconds && hasConfidence, detail: `estimatedSeconds=${result.data.estimatedSeconds}, confidence=${result.data.confidence}, hasSeconds=${hasSeconds}, hasConfidence=${hasConfidence}` };
    },
  },
  {
    id: "empty-tasks-montecarlo",
    name: "monte_carlo_schedule",
    body: { tasks: [], iterations: 5000 },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success: ${JSON.stringify(result.data).slice(0, 100)}` };
      const hasMsg = /task|empty|required/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "unknown-tool",
    name: "this_tool_does_not_exist",
    body: {},
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success` };
      const hasMsg = /unknown|not found/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "invalid-json-body",
    name: "pert_estimate",
    body: null,
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success` };
      const hasMsg = /invalid|json|parse/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "missing-required-fields",
    name: "pert_estimate",
    body: { unit: "hours" },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success: ${JSON.stringify(result.data).slice(0, 100)}` };
      const hasMsg = /required|missing|invalid|expected number|received nan/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "huge-iteration-count",
    name: "monte_carlo_schedule",
    body: { tasks: [{ name: "t1", optimistic: 1, most_likely: 5, pessimistic: 10 }], iterations: 1000001 },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success (iterations should be capped)` };
      const hasMsg = /iteration|max|limit/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
  {
    id: "zero-tokens",
    name: "token_time_bridge",
    body: { tokens: 0, model: "claude-sonnet-4-20250514", tool_calls: 0, reasoning_depth: "shallow" },
    expectError: true,
    validate: (result) => {
      if (result.ok) return { pass: false, detail: `Expected error, got success` };
      const hasMsg = /positive|greater|must be/i.test(result.error?.message || "");
      return { pass: hasMsg, detail: `hasErrorMsg=${hasMsg}, msg="${result.error?.message?.slice(0, 80)}"` };
    },
  },
];

// ---- Tool executor with timing ----------------------------------------------

async function executeToolCall(toolName, args) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${EPOCH_URL}/v1/tools/${toolName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const elapsed = Math.round((performance.now() - t0) * 100) / 100;
    const json = await res.json();
    return { result: json, httpStatus: res.status, elapsedMs: elapsed };
  } catch (err) {
    const elapsed = Math.round((performance.now() - t0) * 100) / 100;
    return { result: { ok: false, error: { isError: true, message: err.message } }, httpStatus: 0, elapsedMs: elapsed };
  }
}

// ---- Reasoning stripper (for final text extraction) -------------------------

function stripReasoning(text) {
  let out = text;
  out = out.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, "");
  out = out.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  out = out.replace(/<\|[^>]*\|>/g, "");
  return out.trim();
}

// ---- Confusion pattern detector ---------------------------------------------

function detectConfusionPatterns(task, trace) {
  const patterns = [];

  if (!task.expectedTools) return patterns;

  // 1. Wrong tool called
  for (const round of trace.rounds) {
    for (const tc of round.toolCalls) {
      if (!task.expectedTools.includes(tc.tool) && !(task.expectedNotTools || []).includes(tc.tool)) {
        patterns.push({
          type: "unexpected_tool",
          severity: "high",
          detail: `Called ${tc.tool} but expected one of [${task.expectedTools.join(", ")}]`,
          tool: tc.tool,
          args: tc.args,
        });
      }
      if (task.expectedNotTools && task.expectedNotTools.includes(tc.tool)) {
        patterns.push({
          type: "forbidden_tool",
          severity: "medium",
          detail: `Called ${tc.tool} which should NOT be used for this task`,
          tool: tc.tool,
        });
      }
    }
  }

  // 2. Missing expected tool
  const allCalledTools = trace.toolsUsed;
  for (const expected of task.expectedTools) {
    if (!allCalledTools.includes(expected)) {
      patterns.push({
        type: "missing_tool",
        severity: "high",
        detail: `Expected ${expected} to be called but it wasn't. Called: [${allCalledTools.join(", ")}]`,
        tool: expected,
      });
    }
  }

  // 3. Too many rounds (model confused, retrying)
  if (trace.roundsUsed > 2) {
    patterns.push({
      type: "excessive_rounds",
      severity: "low",
      detail: `Used ${trace.roundsUsed} rounds (max 3). Model may be confused.`,
    });
  }

  // 4. Tool call with HTTP error (model sent bad params)
  for (const round of trace.rounds) {
    for (const tc of round.toolCalls) {
      if (tc.httpStatus >= 400) {
        patterns.push({
          type: "tool_error_response",
          severity: "high",
          detail: `${tc.tool} returned HTTP ${tc.httpStatus}. Args: ${JSON.stringify(tc.args).slice(0, 150)}`,
          tool: tc.tool,
          httpStatus: tc.httpStatus,
        });
      }
    }
  }

  // 5. Model didn't call any tool
  if (trace.totalToolCalls === 0) {
    patterns.push({
      type: "no_tool_call",
      severity: "high",
      detail: `Model answered without calling any tools. Expected: [${task.expectedTools.join(", ")}]`,
    });
  }

  // 6. Multi-step comorbidity: didn't call enough different tools
  if (task.minToolCalls && allCalledTools.length < task.minToolCalls) {
    patterns.push({
      type: "insufficient_tool_diversity",
      severity: "medium",
      detail: `Called ${allCalledTools.length} distinct tools but needed at least ${task.minToolCalls}. Called: [${allCalledTools.join(", ")}]`,
    });
  }

  return patterns;
}

// ---- OpenAI function-calling runner with full capture -----------------------

async function runOpenAIWithTools(baseURL, authToken, model, toolDefs, task) {
  const trace = { rounds: [], totalToolCalls: 0, toolsUsed: [], reasoningTraces: [], rawResponses: [] };
  const openaiTools = openApiToOpenAITools(toolDefs);
  const messages = [{ role: "user", content: task.prompt }];
  const t0 = performance.now();

  for (let round = 0; round < 5; round++) {
    const roundT0 = performance.now();
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        model,
        messages,
        tools: openaiTools,
        tool_choice: "auto",
        max_tokens: 2048,
        temperature: 0.3,
      }),
    });

    const roundElapsed = Math.round((performance.now() - roundT0) * 100) / 100;

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No choices in response");

    const assistantMsg = choice.message;
    const usage = data.usage || {};
    messages.push(assistantMsg);

    // Capture reasoning traces
    const reasoning = extractReasoning(data);
    if (reasoning.length > 0) {
      trace.reasoningTraces.push({ round, traces: reasoning });
    }

    // Capture raw response for diagnostics
    trace.rawResponses.push({
      round,
      finishReason: choice.finish_reason,
      usageTokens: usage.total_tokens || null,
      promptTokens: usage.prompt_tokens || null,
      completionTokens: usage.completion_tokens || null,
      contentPreview: (assistantMsg.content || "").slice(0, 500),
      reasoningPreview: reasoning.map(r => r.content?.slice(0, 300)),
    });

    const roundInfo = {
      round,
      elapsedMs: roundElapsed,
      finishReason: choice.finish_reason,
      usageTokens: usage.total_tokens || null,
      promptTokens: usage.prompt_tokens || null,
      completionTokens: usage.completion_tokens || null,
      toolCalls: [],
      assistantContent: (assistantMsg.content || "").slice(0, 1000),
    };

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const totalElapsed = Math.round((performance.now() - t0) * 100) / 100;
      return {
        response: stripReasoning(assistantMsg.content || ""),
        trace,
        totalElapsedMs: totalElapsed,
        roundsUsed: round + 1,
      };
    }

    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function.name;
      let toolArgs;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = { _parse_error: tc.function.arguments?.slice(0, 200) }; }

      trace.totalToolCalls++;
      if (!trace.toolsUsed.includes(toolName)) trace.toolsUsed.push(toolName);

      const execResult = await executeToolCall(toolName, toolArgs);

      roundInfo.toolCalls.push({
        tool: toolName,
        args: toolArgs,
        resultPreview: JSON.stringify(execResult.result).slice(0, 300),
        httpStatus: execResult.httpStatus,
        elapsedMs: execResult.elapsedMs,
        epochData: execResult.result.data ? JSON.stringify(execResult.result.data).slice(0, 500) : null,
        epochError: execResult.result.error?.message || null,
      });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(execResult.result),
      });
    }

    trace.rounds.push(roundInfo);
  }

  const totalElapsed = Math.round((performance.now() - t0) * 100) / 100;
  const last = messages[messages.length - 1];
  return {
    response: stripReasoning(typeof last.content === "string" ? last.content : JSON.stringify(last.content)),
    trace,
    totalElapsedMs: totalElapsed,
    roundsUsed: 5,
  };
}

// ---- Anthropic tool-use runner with full capture ----------------------------

async function runAnthropicWithTools(baseURL, authToken, model, toolDefs, task) {
  const trace = { rounds: [], totalToolCalls: 0, toolsUsed: [], reasoningTraces: [], rawResponses: [] };
  const anthropicTools = openApiToAnthropicTools(toolDefs);
  const messages = [{ role: "user", content: task.prompt }];
  const t0 = performance.now();

  for (let round = 0; round < 5; round++) {
    const roundT0 = performance.now();
    const res = await fetch(`${baseURL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": authToken,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 2048, tools: anthropicTools, messages }),
    });

    const roundElapsed = Math.round((performance.now() - roundT0) * 100) / 100;

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    const usage = data.usage || {};

    const textBlocks = [];
    const toolUseBlocks = [];
    const thinkingBlocks = [];

    for (const block of data.content || []) {
      if (block.type === "text") textBlocks.push(block.text);
      if (block.type === "tool_use") toolUseBlocks.push(block);
      if (block.type === "thinking") thinkingBlocks.push(block.thinking);
    }

    // Capture reasoning
    if (thinkingBlocks.length > 0) {
      trace.reasoningTraces.push({ round, traces: thinkingBlocks.map(t => ({ source: "anthropic_thinking", content: t })) });
    }

    messages.push({ role: "assistant", content: data.content });

    trace.rawResponses.push({
      round,
      stopReason: data.stop_reason,
      usageInputTokens: usage.input_tokens || null,
      usageOutputTokens: usage.output_tokens || null,
      textPreview: textBlocks.join("").slice(0, 500),
      thinkingPreview: thinkingBlocks.map(t => t?.slice(0, 300)),
    });

    const roundInfo = {
      round,
      elapsedMs: roundElapsed,
      stopReason: data.stop_reason,
      usageInputTokens: usage.input_tokens || null,
      usageOutputTokens: usage.output_tokens || null,
      toolCalls: [],
      assistantContent: textBlocks.join("").slice(0, 1000),
      thinkingContent: thinkingBlocks.join("\n---\n").slice(0, 2000),
    };

    if (toolUseBlocks.length === 0) {
      const totalElapsed = Math.round((performance.now() - t0) * 100) / 100;
      return {
        response: stripReasoning(textBlocks.join("")),
        trace,
        totalElapsedMs: totalElapsed,
        roundsUsed: round + 1,
      };
    }

    const toolResults = [];
    for (const tub of toolUseBlocks) {
      const toolName = tub.name;
      const toolInput = tub.input || {};

      trace.totalToolCalls++;
      if (!trace.toolsUsed.includes(toolName)) trace.toolsUsed.push(toolName);

      const execResult = await executeToolCall(toolName, toolInput);

      roundInfo.toolCalls.push({
        tool: toolName,
        args: toolInput,
        resultPreview: JSON.stringify(execResult.result).slice(0, 300),
        httpStatus: execResult.httpStatus,
        elapsedMs: execResult.elapsedMs,
        epochData: execResult.result.data ? JSON.stringify(execResult.result.data).slice(0, 500) : null,
        epochError: execResult.result.error?.message || null,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: tub.id,
        content: JSON.stringify(execResult.result),
      });
    }

    trace.rounds.push(roundInfo);
    messages.push({ role: "user", content: toolResults });
  }

  const totalElapsed = Math.round((performance.now() - t0) * 100) / 100;
  const last = messages[messages.length - 1];
  const content = last.content;
  if (typeof content === "string") return { response: stripReasoning(content), trace, totalElapsedMs: totalElapsed, roundsUsed: 5 };
  if (Array.isArray(content)) {
    const texts = content.filter(b => b.type === "tool_result").map(b => b.content);
    return { response: stripReasoning(texts.join(" ")), trace, totalElapsedMs: totalElapsed, roundsUsed: 5 };
  }
  return { response: "", trace, totalElapsedMs: totalElapsed, roundsUsed: 5 };
}

// ---- LM Studio model management ---------------------------------------------

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";

async function lmStudioLoad(modelId) {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models/load`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  });
  const data = await res.json();
  if (data.status !== "loaded") throw new Error(`Load failed: ${JSON.stringify(data)}`);
  return data;
}

async function lmStudioUnload(instanceId) {
  await fetch(`${LM_STUDIO_URL}/api/v1/models/unload`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_id: instanceId }),
  });
}

async function lmStudioListLoaded() {
  const res = await fetch(`${LM_STUDIO_URL}/api/v0/models`);
  const data = await res.json();
  return data.data?.filter((m) => m.state === "loaded").map((m) => m.id) || [];
}

// ---- Provider test runner with confusion detection --------------------------

async function runProviderCanary(provider, toolDefs, task) {
  const record = {
    provider: provider.name,
    model: provider.model,
    apiType: provider.apiType,
    task: task.id,
    status: "PENDING",
    detail: "",
    responsePreview: "",
    totalElapsedMs: null,
    roundsUsed: null,
    toolCallCount: null,
    toolsUsed: [],
    expectedTools: task.expectedTools || [],
    confusionPatterns: [],
    trace: null,
  };

  try {
    let runResult;
    if (provider.apiType === "anthropic") {
      runResult = await runAnthropicWithTools(provider.baseURL, provider.authToken, provider.model, toolDefs, task);
    } else {
      runResult = await runOpenAIWithTools(provider.baseURL, provider.authToken, provider.model, toolDefs, task);
    }

    const validation = task.validate(runResult.response);
    const confusion = detectConfusionPatterns(task, runResult.trace);

    record.status = validation.pass ? "PASS" : "FAIL";
    record.detail = validation.detail;
    record.responsePreview = runResult.response.slice(0, 500);
    record.totalElapsedMs = runResult.totalElapsedMs;
    record.roundsUsed = runResult.roundsUsed;
    record.toolCallCount = runResult.trace.totalToolCalls;
    record.toolsUsed = runResult.trace.toolsUsed;
    record.confusionPatterns = confusion;
    record.trace = runResult.trace;

    // Log confusion patterns to telemetry
    if (confusion.length > 0) {
      telemetry.confusionPatterns.push({
        provider: provider.name,
        model: provider.model,
        task: task.id,
        patterns: confusion,
      });
    }
  } catch (err) {
    record.status = "ERROR";
    record.detail = err.message.slice(0, 500);
  }

  return record;
}

async function runProviderMatrix(provider, toolDefs, results, tasks) {
  console.log(`\n--- ${provider.name} (${provider.apiType}) ---`);
  for (const task of tasks) {
    process.stdout.write(`  ${task.id}... `);
    const result = await runProviderCanary(provider, toolDefs, task);
    results.push(result);
    const icon = result.status === "PASS" ? "OK" : result.status === "FAIL" ? "FAIL" : "ERR";
    const timing = result.totalElapsedMs ? ` [${result.totalElapsedMs}ms, ${result.roundsUsed}rnd, ${result.toolCallCount}tc]` : "";
    const confusion = result.confusionPatterns.length > 0 ? ` CONFUSION:${result.confusionPatterns.map(c => c.type).join(",")}` : "";
    console.log(`${icon} — ${result.detail}${timing}${confusion}`);
  }
}

// ---- Summary printer --------------------------------------------------------

function printSummary(results) {
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`CANARY SUMMARY — ${results.length} function-calling tests`);
  console.log(`${"=".repeat(80)}`);

  const byProvider = {};
  for (const r of results) {
    const key = `${r.provider} [${r.apiType}]`;
    if (!byProvider[key]) byProvider[key] = { pass: 0, fail: 0, error: 0, total: 0, totalMs: 0, totalToolCalls: 0, confusionCount: 0 };
    byProvider[key].total++;
    if (r.status === "PASS") byProvider[key].pass++;
    else if (r.status === "FAIL") byProvider[key].fail++;
    else byProvider[key].error++;
    if (r.totalElapsedMs) byProvider[key].totalMs += r.totalElapsedMs;
    if (r.toolCallCount) byProvider[key].totalToolCalls += r.toolCallCount;
    byProvider[key].confusionCount += r.confusionPatterns.length;
  }

  for (const [name, counts] of Object.entries(byProvider)) {
    const pct = Math.round((counts.pass / counts.total) * 100);
    const avgMs = counts.total > 0 ? Math.round(counts.totalMs / counts.total) : 0;
    const bar = "=".repeat(counts.pass) + "-".repeat(counts.fail) + "x".repeat(counts.error);
    console.log(`  ${name.padEnd(45)} ${String(pct).padStart(3)}% (${counts.pass}/${counts.total}) avg=${avgMs}ms tc=${counts.totalToolCalls} confusion=${counts.confusionCount} [${bar}]`);
  }

  const totalPass = results.filter((r) => r.status === "PASS").length;
  const totalFail = results.filter((r) => r.status === "FAIL").length;
  const totalError = results.filter((r) => r.status === "ERROR").length;
  console.log(`\n  TOTAL: ${totalPass} pass, ${totalFail} fail, ${totalError} error out of ${results.length}`);
}

function printFailureDetail(results) {
  const failures = results.filter((r) => r.status !== "PASS");
  if (failures.length === 0) { console.log("\n  No failures to diagnose."); return; }

  console.log(`\n${"─".repeat(80)}`);
  console.log(`FAILURE DIAGNOSTICS (${failures.length} failures):`);
  for (const f of failures) {
    console.log(`\n  [${f.status}] ${f.provider} / ${f.model} / ${f.task}`);
    console.log(`    Detail: ${f.detail}`);
    if (f.totalElapsedMs) console.log(`    Timing: ${f.totalElapsedMs}ms, ${f.roundsUsed} rounds, ${f.toolCallCount} tool calls`);
    if (f.toolsUsed.length > 0) console.log(`    Tools used: [${f.toolsUsed.join(", ")}] | Expected: [${f.expectedTools.join(", ")}]`);
    if (f.confusionPatterns.length > 0) {
      console.log(`    Confusion patterns:`);
      for (const cp of f.confusionPatterns) {
        console.log(`      [${cp.severity}] ${cp.type}: ${cp.detail}`);
      }
    }
    if (f.trace?.rounds) {
      for (const rnd of f.trace.rounds) {
        console.log(`    Round ${rnd.round}: ${rnd.elapsedMs}ms, ${rnd.toolCalls.length} calls`);
        for (const tc of rnd.toolCalls) {
          console.log(`      ${tc.tool}: HTTP ${tc.httpStatus} (${tc.elapsedMs}ms) args=${JSON.stringify(tc.args).slice(0, 120)}`);
          if (tc.epochError) console.log(`      ERROR: ${tc.epochError}`);
        }
      }
    }
    // Show reasoning traces if captured
    if (f.trace?.reasoningTraces?.length > 0) {
      console.log(`    Reasoning traces:`);
      for (const rt of f.trace.reasoningTraces) {
        for (const r of rt.traces) {
          console.log(`      [Round ${rt.round}] ${r.source}: ${r.content?.slice(0, 200)}`);
        }
      }
    }
    if (f.responsePreview) console.log(`    Preview: ${f.responsePreview.slice(0, 200)}...`);
  }
}

function printConfusionReport() {
  if (telemetry.confusionPatterns.length === 0) { console.log("\n  No confusion patterns detected."); return; }

  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`CONFUSION PATTERN TAXONOMY — ${telemetry.confusionPatterns.length} instances`);
  console.log(`${"=".repeat(80)}`);

  const byType = {};
  for (const cp of telemetry.confusionPatterns) {
    for (const p of cp.patterns) {
      if (!byType[p.type]) byType[p.type] = [];
      byType[p.type].push({ provider: cp.provider, model: cp.model, task: cp.task, detail: p.detail });
    }
  }

  for (const [type, instances] of Object.entries(byType)) {
    console.log(`\n  ${type} (${instances.length} instances):`);
    for (const inst of instances.slice(0, 8)) {
      console.log(`    ${inst.provider}/${inst.model} [${inst.task}]: ${inst.detail}`);
    }
    if (instances.length > 8) console.log(`    ... and ${instances.length - 8} more`);
  }
}

// ---- Failure Comorbidity Analysis -------------------------------------------
// For each pair of tasks (A, B), compute P(B fails | A fails).
// High co-occurrence = comorbidity. This reveals hidden shared failure modes.

function computeFailureComorbidities(results) {
  // Build per-provider task outcome matrix
  const providerTaskMap = {};
  for (const r of results) {
    if (r.provider === "Epoch/API") continue; // skip direct API tests
    const key = `${r.provider}`;
    if (!providerTaskMap[key]) providerTaskMap[key] = {};
    providerTaskMap[key][r.task] = r.status === "PASS" ? 0 : 1; // 1 = failure
  }

  const providers = Object.keys(providerTaskMap);
  const allTasksSet = new Set();
  for (const p of providers) {
    for (const t of Object.keys(providerTaskMap[p])) allTasksSet.add(t);
  }
  const tasks = [...allTasksSet].sort();

  // Count co-occurrences
  // For task A: how many providers fail A?
  // For pair (A, B): how many providers fail BOTH?
  const failCount = {};
  const coFail = {};

  for (const task of tasks) {
    failCount[task] = 0;
    coFail[task] = {};
    for (const other of tasks) coFail[task][other] = 0;
  }

  for (const provider of providers) {
    const outcomes = providerTaskMap[provider];
    const failedTasks = tasks.filter(t => outcomes[t] === 1);

    for (const t of failedTasks) failCount[t]++;

    // Count pairwise co-failures
    for (let i = 0; i < failedTasks.length; i++) {
      for (let j = i; j < failedTasks.length; j++) {
        coFail[failedTasks[i]][failedTasks[j]]++;
        if (i !== j) coFail[failedTasks[j]][failedTasks[i]]++;
      }
    }
  }

  // Compute conditional probabilities: P(B fails | A fails)
  const comorbidities = [];
  for (const a of tasks) {
    if (failCount[a] === 0) continue; // A never fails, skip
    for (const b of tasks) {
      if (a === b) continue;
      if (failCount[b] === 0) continue; // B never fails, skip

      const pBgivenA = coFail[a][b] / failCount[a];
      const pBmarginal = failCount[b] / providers.length;

      // Lift: how much more likely is B given A vs baseline?
      const lift = pBmarginal > 0 ? pBgivenA / pBmarginal : 0;

      // Only report meaningful comorbidities (high co-occurrence)
      if (pBgivenA >= 0.5 && lift >= 1.2) {
        comorbidities.push({
          trigger: a,
          consequent: b,
          pConsequentGivenTrigger: Math.round(pBgivenA * 100),
          pConsequentBaseline: Math.round(pBmarginal * 100),
          lift: Math.round(lift * 100) / 100,
          coFailureCount: coFail[a][b],
          triggerFailureCount: failCount[a],
          consequentFailureCount: failCount[b],
        });
      }
    }
  }

  // Sort by strength (lift * probability)
  comorbidities.sort((a, b) => (b.lift * b.pConsequentGivenTrigger) - (a.lift * a.pConsequentGivenTrigger));

  // Cluster analysis: find groups of tasks that tend to fail together
  const clusters = [];
  const assigned = new Set();

  for (const c of comorbidities) {
    if (assigned.has(c.trigger) && assigned.has(c.consequent)) continue;

    // Find or create cluster
    let cluster = clusters.find(cl => cl.tasks.has(c.trigger) || cl.tasks.has(c.consequent));
    if (!cluster) {
      cluster = { tasks: new Set(), comorbidities: [] };
      clusters.push(cluster);
    }
    cluster.tasks.add(c.trigger);
    cluster.tasks.add(c.consequent);
    cluster.comorbidities.push(c);
    assigned.add(c.trigger);
    assigned.add(c.consequent);
  }

  return { comorbidities, clusters, failCount, totalProviders: providers.length, tasks };
}

function printComorbidityReport(results) {
  const analysis = computeFailureComorbidities(results);
  const { comorbidities, clusters, failCount, totalProviders, tasks } = analysis;

  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`FAILURE COMORBIDITY ANALYSIS — ${totalProviders} providers, ${tasks.length} tasks`);
  console.log(`${"=".repeat(80)}`);

  // Task failure frequency
  console.log(`\n  Task failure frequency (across ${totalProviders} providers):`);
  const sortedFails = Object.entries(failCount).sort((a, b) => b[1] - a[1]);
  for (const [task, count] of sortedFails) {
    if (count === 0) continue;
    const pct = Math.round((count / totalProviders) * 100);
    const bar = "x".repeat(count) + ".".repeat(totalProviders - count);
    console.log(`    ${task.padEnd(45)} ${count}/${totalProviders} (${pct}%) [${bar}]`);
  }

  if (comorbidities.length === 0) {
    console.log(`\n  No significant comorbidities detected (all independent failures).`);
    telemetry.comorbidityAnalysis = analysis;
    return;
  }

  // Top comorbidities
  console.log(`\n  Top failure comorbidities (P(B fails | A fails) >= 50%, lift >= 1.2):`);
  for (const c of comorbidities.slice(0, 20)) {
    console.log(`    When "${c.trigger}" fails -> "${c.consequent}" also fails ${c.pConsequentGivenTrigger}% of the time (baseline: ${c.pConsequentBaseline}%, lift: ${c.lift}x, co-occurred ${c.coFailureCount}/${c.triggerFailureCount} times)`);
  }

  // Clusters
  if (clusters.length > 0) {
    console.log(`\n  Failure clusters (tasks that travel together):`);
    for (let i = 0; i < clusters.length; i++) {
      const cl = clusters[i];
      const taskList = [...cl.tasks].join(", ");
      console.log(`    Cluster ${i + 1}: [${taskList}]`);
      for (const c of cl.comorbidities.slice(0, 5)) {
        console.log(`      ${c.trigger} -> ${c.consequent}: ${c.pConsequentGivenTrigger}% (lift ${c.lift}x)`);
      }
    }
  }

  // Diagnostic interpretation
  console.log(`\n  Diagnostic interpretation:`);
  for (const cl of clusters) {
    const taskNames = [...cl.tasks];
    // Heuristic interpretations based on task patterns
    if (taskNames.some(t => t.includes("current-time")) && taskNames.some(t => t.includes("timezone") || t.includes("business"))) {
      console.log(`    Cluster [${taskNames.join(", ")}]: Likely a temporal-reasoning deficit. Models failing time queries also fail date/calendar operations.`);
    }
    if (taskNames.some(t => t.includes("pert")) && taskNames.some(t => t.includes("sprint") || t.includes("monte-carlo"))) {
      console.log(`    Cluster [${taskNames.join(", ")}]: Likely an estimation-tool deficit. Models that struggle with PERT inputs also mishandle complex estimation tools.`);
    }
    if (taskNames.some(t => t.includes("chain") || t.includes("comorbid"))) {
      console.log(`    Cluster [${taskNames.join(", ")}]: Multi-step reasoning failure. Models that can't chain tool calls fail these composite tasks.`);
    }
    if (taskNames.some(t => t.includes("token-bridge"))) {
      console.log(`    Cluster [${taskNames.join(", ")}]: Model-parameter awareness gap. Models failing token estimation may not understand LLM performance characteristics.`);
    }
    // Generic fallback
    if (!taskNames.some(t => t.includes("current-time")) && !taskNames.some(t => t.includes("pert")) && !taskNames.some(t => t.includes("chain")) && !taskNames.some(t => t.includes("token"))) {
      console.log(`    Cluster [${taskNames.join(", ")}]: Correlated failures suggest a shared underlying model capability gap.`);
    }
  }

  telemetry.comorbidityAnalysis = analysis;
}

function printFailureModeSummary(results) {
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`FAILURE-MODE TESTS — ${results.length} Epoch edge-case tests`);
  console.log(`${"=".repeat(80)}`);

  for (const r of results) {
    const icon = r.status === "PASS" ? "OK" : "FAIL";
    console.log(`  ${icon} ${r.id.padEnd(30)} ${r.detail}`);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  console.log(`\n  TOTAL: ${pass}/${results.length} passed`);
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log("Epoch Canary v3 — Deep Diagnostics + Comorbidity Testing");
  console.log(`Epoch URL: ${EPOCH_URL}`);

  const healthRes = await fetch(`${EPOCH_URL}/health`);
  const health = await healthRes.json();
  console.log(`Epoch health: ${health.status}, v${health.version}, ${health.tools} tools, uptime ${Math.round(health.uptime)}s`);

  console.log("\nFetching tool definitions from Epoch OpenAPI spec...");
  const toolDefs = await fetchToolDefinitions();
  console.log(`Loaded ${toolDefs.length} tool definitions: ${toolDefs.map(t => t.name).join(", ")}`);

  const allTasks = [...CANARY_TASKS, ...CHAIN_TASKS, ...HARDER_TASKS];
  const allResults = [];

  // ---- Phase 0: Epoch Surface Tests ----------------------------------------
  const surfaceTests = [
    { name: "get_current_time", body: { timezone: "Asia/Tokyo" }, validate: (d) => d.timezone === "Asia/Tokyo" && /\d{1,2}:\d{2}/.test(d.humanReadable) },
    { name: "pert_estimate", body: { optimistic: 2, most_likely: 5, pessimistic: 20, unit: "hours" }, validate: (d) => d.expected > 5 && d.confidence95.length === 2 },
    { name: "count_business_days", body: { start_date: "2026-05-01", end_date: "2026-05-31", country: "US" }, validate: (d) => d.businessDays >= 18 && d.businessDays <= 23 },
    { name: "token_time_bridge", body: { tokens: 100000, model: "claude-sonnet-4-20250514", tool_calls: 20, reasoning_depth: "deep" }, validate: (d) => d.estimatedSeconds > 0 && d.estimatedMinutes > 0 },
    { name: "monte_carlo_schedule", body: { tasks: [{ name: "backend-api", optimistic: 3, most_likely: 7, pessimistic: 15 }], iterations: 5000 }, validate: (d) => parseFloat(d.p50) > 0 && parseFloat(d.p95) > 0 },
    { name: "convert_timezone", body: { timestamp: "2026-05-01T14:30:00Z", target_tz: "Asia/Tokyo" }, validate: (d) => d.timezone === "Asia/Tokyo" && d.utcOffset === "+09:00" },
    { name: "parse_duration", body: { duration_string: "2h30m" }, validate: (d) => d.totalSeconds === 9000 && d.humanReadable.includes("2 hours") },
    { name: "add_business_days", body: { start_date: "2026-05-01", days: 10, country: "US" }, validate: (d) => d.businessDays === 10 && d.endDate === "2026-05-15" },
    { name: "cocomo_estimate", body: { kloc: 10 }, validate: (d) => d.personMonthsNominal > 0 },
    { name: "sprint_forecast", body: { backlog_points: 120, velocity_history: [25, 30, 28, 32], sprint_length_days: 14, hours_per_sprint: 80 }, validate: (d) => d.requiredSprints > 0 },
    { name: "critical_path", body: { tasks: [{ name: "design", duration: 5, predecessors: [] }, { name: "build", duration: 10, predecessors: ["design"] }] }, validate: (d) => d.total_duration === 15 },
    { name: "reference_class_estimate", body: { task_type: "feature", complexity: 1.5 }, validate: (d) => d.correctedEstimate > 0 },
    { name: "time_math", body: { operation: "diff", operands: { date: "2026-05-01", end_date: "2026-05-31" } }, validate: (d) => d.days === 30 },
    // -- Previously untested surface tests --
    { name: "token_cost_estimate", body: { tokens: 100000, model: "claude-sonnet-4-20250514", reasoning_depth: "deep" }, validate: (d) => d.estimatedSeconds > 0 && d.estimatedCost > 0 },
    { name: "compare_models", body: { tokens: 100000, tool_calls: 20, reasoning_depth: "deep" }, validate: (d) => Array.isArray(d.models) && d.models.length > 1 },
    { name: "accuracy_trend", body: { team_id: "canary-test", window_size: 10 }, validate: (d) => typeof d.currentMape === "number" && typeof d.overallTrend === "string" && Array.isArray(d.windows) },
    { name: "schedule_risk", body: { estimated_hours: 80, task_type: "feature" }, validate: (d) => typeof d.riskLevel === "string" && d.confidenceIntervals?.p50 > 0 && d.confidenceIntervals?.p95 >= d.confidenceIntervals?.p50 },
    { name: "calibrate_estimates", body: { team_id: "canary-test", period_days: 90, minimum_samples: 5 }, validate: (d) => typeof d.correctionFactor === "number" && typeof d.accuracyTrend === "string" && Array.isArray(d.recommendations) },
    { name: "cocomo_validate", body: {}, validate: (d) => typeof d.projectsEvaluated === "number" && d.projectsEvaluated > 0 && typeof d.mape === "number" && typeof d.bias === "number" },
    { name: "get_pending_estimates", body: {}, validate: (d) => typeof d === "object" },
    { name: "feedback_health", body: {}, validate: (d) => typeof d.totalEstimates === "number" && typeof d.matchedPairs === "number" && typeof d.matchRate === "number" },
  ];
  console.log(`\n--- Phase 0: Epoch Surface Tests (API directly, ${surfaceTests.length} tools) ---`);

  for (const test of surfaceTests) {
    process.stdout.write(`  ${test.name}... `);
    const t0 = performance.now();
    try {
      const res = await fetch(`${EPOCH_URL}/v1/tools/${test.name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(test.body) });
      const elapsed = Math.round((performance.now() - t0) * 100) / 100;
      const json = await res.json();
      if (!json.ok) {
        const record = { provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: json.error?.message || "unknown", responsePreview: "", totalElapsedMs: elapsed, roundsUsed: null, toolCallCount: null, toolsUsed: [], expectedTools: [], confusionPatterns: [], trace: null };
        allResults.push(record); telemetry.surfaceTests.push(record);
        console.log(`ERR (${elapsed}ms) — ${json.error?.message}`);
        continue;
      }
      const pass = test.validate(json.data);
      const record = { provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: pass ? "PASS" : "FAIL", detail: `validate=${pass}`, responsePreview: JSON.stringify(json.data).slice(0, 300), totalElapsedMs: elapsed, roundsUsed: null, toolCallCount: null, toolsUsed: [], expectedTools: [], confusionPatterns: [], trace: null };
      allResults.push(record); telemetry.surfaceTests.push(record);
      console.log(`${pass ? "OK" : "FAIL"} (${elapsed}ms)`);
    } catch (err) {
      const elapsed = Math.round((performance.now() - t0) * 100) / 100;
      const record = { provider: "Epoch/API", model: "-", apiType: "http", task: test.name, status: "ERROR", detail: err.message, responsePreview: "", totalElapsedMs: elapsed, roundsUsed: null, toolCallCount: null, toolsUsed: [], expectedTools: [], confusionPatterns: [], trace: null };
      allResults.push(record); telemetry.surfaceTests.push(record);
      console.log(`ERR (${elapsed}ms) — ${err.message}`);
    }
  }

  // ---- Phase 0.5: Failure-Mode Tests ---------------------------------------
  console.log("\n--- Phase 0.5: Failure-Mode Tests (Epoch edge cases) ---");
  for (const ftest of FAILURE_MODE_TASKS) {
    process.stdout.write(`  ${ftest.id}... `);
    const t0 = performance.now();
    try {
      const fetchOpts = { method: "POST", headers: { "Content-Type": "application/json" } };
      if (ftest.body === null) {
        fetchOpts.body = "this is not json{{{";
      } else {
        fetchOpts.body = JSON.stringify(ftest.body);
      }
      const res = await fetch(`${EPOCH_URL}/v1/tools/${ftest.name}`, fetchOpts);
      const elapsed = Math.round((performance.now() - t0) * 100) / 100;
      let json;
      try { json = await res.json(); } catch { json = { ok: false, error: { isError: true, message: `HTTP ${res.status}: non-JSON response` } }; }
      const validation = ftest.validate(json);
      const record = { id: ftest.id, name: ftest.name, input: ftest.body, httpStatus: res.status, status: validation.pass ? "PASS" : "FAIL", detail: validation.detail, elapsedMs: elapsed, response: JSON.stringify(json).slice(0, 500) };
      telemetry.failureModeTests.push(record);
      console.log(`${validation.pass ? "OK" : "FAIL"} (${elapsed}ms) — ${validation.detail}`);
    } catch (err) {
      const elapsed = Math.round((performance.now() - t0) * 100) / 100;
      telemetry.failureModeTests.push({ id: ftest.id, name: ftest.name, input: ftest.body, httpStatus: 0, status: "ERROR", detail: err.message, elapsedMs: elapsed, response: "" });
      console.log(`ERR (${elapsed}ms) — ${err.message}`);
    }
  }

  // ---- Phase 1: GLM --------------------------------------------------------
  const glmToken = process.env.GLM_AUTH_TOKEN;
  if (glmToken) {
    const glmModels = ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5-turbo", "glm-5.1"];
    for (const model of glmModels) {
      await runProviderMatrix({ name: `GLM/${model}`, apiType: "anthropic", baseURL: "https://api.z.ai/api/anthropic/v1", authToken: glmToken, model }, toolDefs, allResults, allTasks);
    }
  } else {
    console.log("\nGLM_AUTH_TOKEN not set — skipping GLM providers");
  }

  // ---- Phase 2: Minimax ----------------------------------------------------
  const minimaxKey = process.env.MINIMAX_API_KEY;
  if (minimaxKey) {
    const minimaxModels = ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"];

    for (const model of minimaxModels) {
      await runProviderMatrix({ name: `Minimax/${model}`, apiType: "openai", baseURL: "https://api.minimaxi.chat/v1", authToken: minimaxKey, model }, toolDefs, allResults, allTasks);
    }

    for (const model of minimaxModels) {
      await runProviderMatrix({ name: `Minimax-Anthropic/${model}`, apiType: "anthropic", baseURL: "https://api.minimaxi.chat/anthropic/v1", authToken: minimaxKey, model }, toolDefs, allResults, allTasks);
    }
  } else {
    console.log("\nMINIMAX_API_KEY not set — skipping Minimax providers");
  }

  // ---- Phase 3: LM Studio --------------------------------------------------
  const jitModels = ["gemma-4-e2b-it", "lfm2-8b-a1b", "qwen3.5-2b"];
  let preLoaded = [];
  try { preLoaded = await lmStudioListLoaded(); } catch { preLoaded = []; }

  if (preLoaded.length >= 0) {
    console.log(`\n--- LM Studio JIT Phase (pre-loaded: ${preLoaded.join(", ")}) ---`);
    for (const modelId of jitModels) {
      console.log(`\n  >> Loading ${modelId}...`);
      try { await lmStudioLoad(modelId); console.log(`  >> Loaded ${modelId}`); }
      catch (err) { console.log(`  >> SKIP ${modelId}: ${err.message}`); continue; }

      await runProviderMatrix({ name: `LMStudio/${modelId}`, apiType: "openai", baseURL: `${LM_STUDIO_URL}/v1`, authToken: "lm-studio", model: modelId }, toolDefs, allResults, allTasks);

      console.log(`  >> Unloading ${modelId}...`);
      await lmStudioUnload(modelId);
      console.log(`  >> Unloaded ${modelId}`);
    }

    try {
      const postLoaded = await lmStudioListLoaded();
      const polluted = postLoaded.filter((m) => !preLoaded.includes(m));
      if (polluted.length > 0) {
        console.log(`\n  WARNING: Models left loaded: ${polluted.join(", ")}`);
        for (const m of polluted) { await lmStudioUnload(m); console.log(`  Cleaned up: ${m}`); }
      } else { console.log(`\n  LM Studio clean.`); }
    } catch { console.log(`\n  LM Studio cleanup check failed (unreachable)`); }
  }

  // ---- Summaries -----------------------------------------------------------
  printSummary(allResults);
  printFailureDetail(allResults);
  printConfusionReport();
  printComorbidityReport(allResults);
  printFailureModeSummary(telemetry.failureModeTests);

  // ---- Write JSON report ---------------------------------------------------
  telemetry.finishedAt = new Date().toISOString();
  telemetry.results = allResults;

  const totalPass = allResults.filter((r) => r.status === "PASS").length;
  const totalFail = allResults.filter((r) => r.status === "FAIL").length;
  const totalError = allResults.filter((r) => r.status === "ERROR").length;
  telemetry.summary = {
    totalTests: allResults.length,
    pass: totalPass,
    fail: totalFail,
    error: totalError,
    passRate: `${Math.round((totalPass / allResults.length) * 100)}%`,
    failureModePass: telemetry.failureModeTests.filter((r) => r.status === "PASS").length,
    failureModeTotal: telemetry.failureModeTests.length,
    confusionPatternCount: telemetry.confusionPatterns.length,
    confusionByType: {},
    comorbidityClusterCount: telemetry.comorbidityAnalysis?.clusters?.length || 0,
    comorbidityPairCount: telemetry.comorbidityAnalysis?.comorbidities?.length || 0,
  };

  for (const cp of telemetry.confusionPatterns) {
    for (const p of cp.patterns) {
      telemetry.summary.confusionByType[p.type] = (telemetry.summary.confusionByType[p.type] || 0) + 1;
    }
  }

  const fs = await import("fs");
  fs.writeFileSync(REPORT_PATH, JSON.stringify(telemetry, null, 2));
  console.log(`\nReport written to ${REPORT_PATH} (${(fs.statSync(REPORT_PATH).size / 1024).toFixed(1)} KB)`);

  const localSurfaceFailures = telemetry.surfaceTests.filter((r) => r.status !== "PASS");
  const failureModeFailures = telemetry.failureModeTests.filter((r) => r.status !== "PASS");
  if (localSurfaceFailures.length > 0 || failureModeFailures.length > 0) {
    console.error(
      `Canary local API gate failed: ${localSurfaceFailures.length} surface failures, ${failureModeFailures.length} failure-mode failures.`,
    );
    process.exitCode = 1;
  }
}

main().catch(console.error);
