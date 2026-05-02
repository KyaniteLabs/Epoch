#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Comprehensive Database Population Loop
//
// Goal: Generate 400+ matched estimate→actual pairs across all 8 task types
// and all estimation tools for statistically significant self-improvement.
//
// Approach: Interleaved call → pending → feedback cycle.
// Each round: call tool, immediately fetch pending, submit actual.
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3099";

const TASK_TYPES = [
  "feature", "bugfix", "refactor", "migration",
  "infrastructure", "documentation", "testing", "design",
];

const TASK_TYPE_BIAS = {
  feature: 1.6,
  bugfix: 1.3,
  refactor: 1.4,
  migration: 1.8,
  infrastructure: 1.5,
  documentation: 1.1,
  testing: 1.35,
  design: 1.45,
};

const TOOL_TASK_MAP = {
  pert_estimate: "feature",
  cocomo_estimate: "feature",
  sprint_forecast: "feature",
  reference_class_estimate: null,
  token_time_bridge: "infrastructure",
  calibrate_estimates: "testing",
};

// ---- Input generators -------------------------------------------------------

function pertInputs() {
  const units = ["hours", "days", "weeks"];
  const ranges = [
    [1, 3, 8], [2, 5, 12], [4, 8, 20], [8, 15, 40], [0.5, 2, 6],
    [3, 7, 16], [10, 20, 50], [1, 4, 10], [5, 12, 30], [2, 6, 15],
    [6, 14, 35], [0.25, 1, 4], [15, 25, 60], [3, 10, 25], [1, 2, 5],
    [7, 18, 45], [0.5, 1.5, 5], [12, 22, 55], [2, 8, 18], [4, 10, 28],
  ];
  const r = ranges[Math.floor(Math.random() * ranges.length)];
  const u = units[Math.floor(Math.random() * units.length)];
  return { optimistic: r[0], most_likely: r[1], pessimistic: r[2], unit: u };
}

function cocomoInputs() {
  const klocs = [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 0.8, 1.5, 4, 6, 12, 25, 0.3, 7, 50, 0.1];
  const i = Math.floor(Math.random() * klocs.length);
  return {
    kloc: klocs[i],
    reasoning_complexity: +(0.5 + Math.random() * 1.5).toFixed(2),
    context_completeness: +(0.5 + Math.random() * 1.5).toFixed(2),
    transformation_impact: +(0.5 + Math.random() * 1.5).toFixed(2),
    iterative_cycles: +(0.5 + Math.random() * 2.0).toFixed(2),
    human_oversight: +(0.5 + Math.random() * 1.5).toFixed(2),
  };
}

function sprintInputs() {
  return {
    backlog_points: [50, 80, 120, 200, 300, 150, 100, 250][Math.floor(Math.random() * 8)],
    velocity_history: Array.from({ length: 4 + Math.floor(Math.random() * 6) }, () =>
      15 + Math.floor(Math.random() * 35)
    ),
    sprint_length_days: [7, 14, 14, 14, 21][Math.floor(Math.random() * 5)],
    hours_per_sprint: 100 + Math.floor(Math.random() * 300),
  };
}

function refClassInputs(taskType) {
  return {
    task_type: taskType ?? TASK_TYPES[Math.floor(Math.random() * TASK_TYPES.length)],
    complexity: 1 + Math.floor(Math.random() * 5),
    ...(Math.random() > 0.5 ? { team_id: `team-${["alpha", "beta", "gamma", "delta"][Math.floor(Math.random() * 4)]}` } : {}),
  };
}

function tokenTimeInputs() {
  const models = [
    "gpt-4o", "gpt-4o-mini", "claude-sonnet-4-20250514", "claude-opus-4-20250514",
    "gemini-2.0-flash", "gemini-2.5-pro", "llama-3.1-70b", "deepseek-v3",
    "mistral-large", "gpt-4-turbo", "claude-3.5-haiku-20241022", "llama-3.1-405b",
  ];
  return {
    tokens: [1000, 5000, 10000, 25000, 50000, 100000, 200000, 500000][Math.floor(Math.random() * 8)],
    model: models[Math.floor(Math.random() * models.length)],
    tool_calls: Math.floor(Math.random() * 20),
    reasoning_depth: ["shallow", "moderate", "deep"][Math.floor(Math.random() * 3)],
  };
}

function calibrateInputs() {
  return {
    team_id: `team-${["alpha", "beta", "gamma", "delta", "epsilon"][Math.floor(Math.random() * 5)]}`,
    period_days: [30, 60, 90, 120, 180][Math.floor(Math.random() * 5)],
    minimum_samples: [5, 10, 15, 20][Math.floor(Math.random() * 4)],
  };
}

// ---- Helpers ----------------------------------------------------------------

function boxMuller() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
}

function extractHours(output) {
  if (typeof output.totalHours === "number") return output.totalHours;
  if (typeof output.estimatedHours === "number") return output.estimatedHours;
  if (typeof output.estimatedMinutes === "number") return output.estimatedMinutes / 60;
  if (typeof output.estimatedSeconds === "number") return output.estimatedSeconds / 3600;
  if (typeof output.expected === "number") {
    const unit = output.unit ?? "hours";
    const scales = { hours: 1, days: 8, weeks: 40, months: 160 };
    return output.expected * (scales[unit] ?? 1);
  }
  if (typeof output.personMonthsLlmAdjusted === "number") return output.personMonthsLlmAdjusted * 160;
  if (typeof output.correctedEstimate === "number") return output.correctedEstimate;
  return null;
}

function generateActual(estimatedHours, taskType) {
  const bias = TASK_TYPE_BIAS[taskType] ?? 1.4;
  const noise = boxMuller() * 0.2 * bias;
  const ratio = Math.max(0.3, bias + noise);
  return Math.round(estimatedHours * ratio * 100) / 100;
}

async function callTool(tool, args) {
  const res = await fetch(`${BASE}/v1/tools/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getPending() {
  const res = await fetch(`${BASE}/v1/feedback/pending?limit=200`);
  if (!res.ok) return [];
  const json = await res.json();
  return json.data ?? json.estimates ?? [];
}

async function getAllPending() {
  const all = [];
  let batch;
  do {
    batch = await getPending();
    if (batch.length === 0) break;
    all.push(...batch);
    // Submit feedback for this batch immediately to make room for more
    for (const p of batch) {
      const taskType = p.inputs?.task_type ?? TOOL_TASK_MAP[p.tool] ?? "feature";
      const hours = extractHours(p.outputs);
      if (hours === null || hours <= 0) continue;
      const actual = generateActual(hours, taskType);
      await submitActual(p.id, actual, `Auto (${taskType}, ${p.tool})`);
    }
    // Small delay to let the server process
  } while (batch.length >= 100); // If less than 100, we've drained
  return all.length;
}

async function submitActual(id, hours, notes) {
  const res = await fetch(`${BASE}/v1/feedback/record-actual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ estimate_id: id, actual_hours: hours, notes }),
  });
  return res.ok;
}

// ---- Stats tracker ----------------------------------------------------------

const feedbackByTask = {};
const feedbackByTool = {};
let totalCalls = 0;
let totalFeedback = 0;
const errors = [];

for (const tt of TASK_TYPES) feedbackByTask[tt] = 0;

async function drainPending() {
  let drained = 0;
  let batch;
  do {
    const res = await fetch(`${BASE}/v1/feedback/pending?limit=200`);
    if (!res.ok) break;
    const json = await res.json();
    batch = json.data ?? [];

    for (const p of batch) {
      const taskType = p.inputs?.task_type ?? TOOL_TASK_MAP[p.tool] ?? "feature";
      const hours = extractHours(p.outputs);
      if (hours === null || hours <= 0) continue;

      const actual = generateActual(hours, taskType);
      const ok = await submitActual(p.id, actual, `Auto (${taskType}, ${p.tool})`);
      if (ok) {
        totalFeedback++;
        drained++;
        feedbackByTask[taskType] = (feedbackByTask[taskType] ?? 0) + 1;
        feedbackByTool[p.tool] = (feedbackByTool[p.tool] ?? 0) + 1;
      }
    }
  } while (batch.length >= 50);
  return drained;
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log("=== Epoch Database Population Loop ===\n");
  const TARGET = 50;

  // ---- Phase 1: Drain existing pending first --------------------------------
  console.log("Phase 0: Draining existing pending estimates...");
  const existingDrained = await drainPending();
  console.log(`  Drained ${existingDrained} existing pending estimates\n`);

  // ---- Phase 2: Generate diverse estimates ----------------------------------
  console.log("Phase 1: Generating diverse estimates...\n");

  const ESTIMATION_TOOLS = [
    { name: "pert_estimate", gen: pertInputs },
    { name: "cocomo_estimate", gen: cocomoInputs },
    { name: "sprint_forecast", gen: sprintInputs },
    { name: "token_time_bridge", gen: tokenTimeInputs },
    { name: "calibrate_estimates", gen: calibrateInputs },
  ];

  // 20 rounds of all estimation tools = 100 calls
  for (let round = 0; round < 20; round++) {
    for (const { name, gen } of ESTIMATION_TOOLS) {
      try {
        await callTool(name, gen());
        totalCalls++;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    if ((round + 1) % 5 === 0) process.stdout.write(`  Round ${round + 1}/20 (${totalCalls} calls)\n`);
  }

  // 15 rounds of reference_class_estimate cycling all task types = 120 calls
  for (let round = 0; round < 15; round++) {
    for (const tt of TASK_TYPES) {
      try {
        await callTool("reference_class_estimate", refClassInputs(tt));
        totalCalls++;
      } catch (e) {
        errors.push(`ref_class ${tt}: ${e.message}`);
      }
    }
    if ((round + 1) % 5 === 0) process.stdout.write(`  Ref class round ${round + 1}/15 (${totalCalls} calls)\n`);
  }

  console.log(`\n  ${totalCalls} estimates generated. Draining pending...\n`);

  const phase1Drained = await drainPending();
  console.log(`  Phase 1 drained: ${phase1Drained} feedback records\n`);

  // ---- Phase 3: Targeted fill for underrepresented task types ---------------
  console.log("Phase 2: Targeted fill...\n");

  let iteration = 0;
  while (TASK_TYPES.some(tt => (feedbackByTask[tt] ?? 0) < TARGET) && iteration < 5) {
    iteration++;
    const needed = TASK_TYPES.filter(tt => (feedbackByTask[tt] ?? 0) < TARGET);
    console.log(`  Iteration ${iteration}: need more for ${needed.join(", ")}`);

    for (const tt of needed) {
      const deficit = TARGET - (feedbackByTask[tt] ?? 0) + 5;
      for (let i = 0; i < deficit; i++) {
        try {
          await callTool("reference_class_estimate", refClassInputs(tt));
          totalCalls++;
        } catch (e) {
          errors.push(`target ${tt}: ${e.message}`);
        }
      }
    }

    const drained = await drainPending();
    console.log(`    Drained ${drained} records`);
  }

  // ---- Phase 4: Diverse telemetry ------------------------------------------
  console.log("\nPhase 3: Diverse telemetry (all 10 tools)...\n");

  const ALL_TOOLS_ARGS = {
    temporal_status: () => ({ timezone: ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"][Math.floor(Math.random() * 5)] }),
    time_math: () => ({ operation: "add_days", operands: { date: "2026-06-15", days: Math.floor(Math.random() * 30) + 5 } }),
    pert_estimate: pertInputs,
    cocomo_estimate: cocomoInputs,
    sprint_forecast: sprintInputs,
    critical_path: () => ({ tasks: [
      { name: "A", duration: 2 + Math.random() * 8, predecessors: [] },
      { name: "B", duration: 3 + Math.random() * 10, predecessors: ["A"] },
      { name: "C", duration: 1 + Math.random() * 6, predecessors: ["A"] },
      { name: "D", duration: 2 + Math.random() * 8, predecessors: ["B", "C"] },
    ] }),
    reference_class_estimate: () => refClassInputs(),
    monte_carlo: () => ({
      tasks: [
        { name: "T1", optimistic: 2 + Math.random() * 3, most_likely: 5 + Math.random() * 5, pessimistic: 10 + Math.random() * 10 },
        { name: "T2", optimistic: 3 + Math.random() * 4, most_likely: 7 + Math.random() * 6, pessimistic: 15 + Math.random() * 10 },
      ],
      iterations: 3000,
    }),
    calibrate_estimates: calibrateInputs,
    token_time_bridge: tokenTimeInputs,
  };

  let telCalls = 0;
  for (let round = 0; round < 10; round++) {
    for (const [tool, gen] of Object.entries(ALL_TOOLS_ARGS)) {
      try {
        await callTool(tool, gen());
        telCalls++;
        totalCalls++;
      } catch (e) {
        errors.push(`tel ${tool}: ${e.message}`);
      }
    }
  }

  // Final drain
  const finalDrained = await drainPending();
  console.log(`  ${telCalls} telemetry calls, ${finalDrained} additional feedback\n`);

  // ---- Report ---------------------------------------------------------------
  console.log("=== POPULATION REPORT ===\n");
  console.log(`Total tool calls:     ${totalCalls}`);
  console.log(`Total feedback:       ${totalFeedback}`);
  console.log(`Errors:               ${errors.length}\n`);

  console.log("Task type coverage (target: 50 each):");
  for (const tt of TASK_TYPES) {
    const count = feedbackByTask[tt] ?? 0;
    const pct = Math.min(100, Math.round((count / TARGET) * 100));
    const bar = "█".repeat(Math.floor(pct / 2)) + "░".repeat(50 - Math.floor(pct / 2));
    const mark = count >= TARGET ? "✓" : "△";
    console.log(`  ${mark} ${tt.padEnd(16)} ${String(count).padStart(4)}  ${bar} ${pct}%`);
  }

  console.log("\nFeedback by tool:");
  for (const [tool, count] of Object.entries(feedbackByTool).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tool.padEnd(28)} ${count}`);
  }

  const { execSync } = await import("child_process");
  try {
    const lines = execSync("wc -l ~/.epoch/*.jsonl").toString().trim().split("\n");
    console.log("\nData files:");
    for (const line of lines) console.log(`  ${line.trim()}`);
  } catch {}

  console.log("\n=== DONE ===");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
