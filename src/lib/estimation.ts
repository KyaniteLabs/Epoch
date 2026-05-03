import type {
  PertResult,
  SprintForecastResult,
  CocomoResult,
  CpmResult,
  CpmTask,
  MonteCarloResult,
  MonteCarloTask,
  ToolResult,
  TimeUnit,
} from "../types/index.js";
import { assertNever } from "../types/index.js";
import { getUrgencyCategory } from "./internal/urgency.js";

function toHours(value: number, unit: TimeUnit): number {
  switch (unit) {
    case "hours": return value;
    case "days": return value * 8;
    case "weeks": return value * 40;
    case "months": return value * 160;
    default: return assertNever(unit);
  }
}

export function pertEstimate(
  optimistic: number,
  mostLikely: number,
  pessimistic: number,
  unit: TimeUnit,
): ToolResult<PertResult> {
  if (!(optimistic > 0 && optimistic <= mostLikely && mostLikely <= pessimistic)) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `PERT values must satisfy 0 < optimistic <= most_likely <= pessimistic. Got optimistic=${optimistic}, most_likely=${mostLikely}, pessimistic=${pessimistic}.`,
        retryHint: "Provide three positive estimates where optimistic is smallest and pessimistic is largest.",
      },
    };
  }

  const expected = (optimistic + 4 * mostLikely + pessimistic) / 6;
  const stdDev = (pessimistic - optimistic) / 6;
  const variance = stdDev * stdDev;
  const expectedHours = toHours(expected, unit);

  if (!Number.isFinite(expected) || !Number.isFinite(stdDev)) {
    return { ok: false, error: { isError: true, message: "Computation produced invalid result.", retryHint: "Ensure all inputs are finite numbers and optimistic < mostLikely < pessimistic." } };
  }

  return {
    ok: true,
    data: {
      optimistic,
      mostLikely,
      pessimistic,
      expected: Math.round(expected * 100) / 100,
      variance: Math.round(variance * 100) / 100,
      stdDeviation: Math.round(stdDev * 100) / 100,
      confidence95: [
        Math.max(0, Math.round((expected - 2 * stdDev) * 100) / 100),
        Math.round((expected + 2 * stdDev) * 100) / 100,
      ],
      confidence99: [
        Math.max(0, Math.round((expected - 3 * stdDev) * 100) / 100),
        Math.round((expected + 3 * stdDev) * 100) / 100,
      ],
      unit,
      urgencyCategory: getUrgencyCategory(expectedHours),
      humanReadable: `Expected: ${Math.round(expected * 100) / 100} ${unit}. 95% confidence: ${Math.max(0, Math.round((expected - 2 * stdDev) * 100) / 100)} to ${Math.round((expected + 2 * stdDev) * 100) / 100} ${unit}. 99% confidence: ${Math.max(0, Math.round((expected - 3 * stdDev) * 100) / 100)} to ${Math.round((expected + 3 * stdDev) * 100) / 100} ${unit}.`,
    },
  };
}

export function sprintForecast(params: {
  backlogPoints: number;
  velocityHistory: number[];
  sprintLengthDays: number;
  hoursPerSprint: number;
}): ToolResult<SprintForecastResult> {
  const { backlogPoints, velocityHistory, sprintLengthDays, hoursPerSprint } = params;

  if (velocityHistory.length === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "velocity_history cannot be empty. Provide at least one sprint's velocity.",
        retryHint: "Pass an array of story points completed per past sprint.",
      },
    };
  }

  if (backlogPoints <= 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "backlog_points must be positive.",
        retryHint: "Provide a positive number for backlog_points.",
      },
    };
  }

  const avgVelocity = velocityHistory.reduce((a, b) => a + b, 0) / velocityHistory.length;

  if (avgVelocity <= 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `Average velocity is 0 across ${velocityHistory.length} sprint(s). Cannot forecast with zero velocity — the backlog will never clear.`,
        retryHint: "Include sprints with positive velocity, or estimate velocity from team capacity.",
      },
    };
  }

  const requiredSprints = backlogPoints / avgVelocity;
  const conversionFactor = hoursPerSprint / avgVelocity;
  const totalHours = backlogPoints * conversionFactor;

  if (!Number.isFinite(totalHours) || !Number.isFinite(requiredSprints)) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "Sprint forecast produced non-finite result. Check inputs for Infinity or extreme values.",
        retryHint: "Use reasonable values for backlog_points, hours_per_sprint, and velocity_history.",
      },
    };
  }

  let pessimisticSprints: number;
  if (velocityHistory.length > 1) {
    const meanV = avgVelocity;
    const variance = velocityHistory.reduce((sum, v) => sum + (v - meanV) ** 2, 0) / (velocityHistory.length - 1);
    const stdV = Math.sqrt(variance);
    pessimisticSprints = backlogPoints / Math.max(avgVelocity - stdV, 0.1);
  } else {
    pessimisticSprints = requiredSprints * 1.5;
  }

  return {
    ok: true,
    data: {
      backlogPoints,
      averageVelocity: Math.round(avgVelocity * 10) / 10,
      requiredSprints: Math.round(requiredSprints * 10) / 10,
      pessimisticSprints: Math.round(pessimisticSprints * 10) / 10,
      hoursPerPoint: Math.round(conversionFactor * 100) / 100,
      totalHours: Math.round(totalHours * 10) / 10,
      completionDays: Math.round(requiredSprints * sprintLengthDays),
      sprintLengthDays,
    },
  };
}

export function cocomoEstimate(params: {
  kloc: number;
  reasoningComplexity: number;
  contextCompleteness: number;
  transformationImpact: number;
  iterativeCycles: number;
  humanOversight: number;
}): ToolResult<CocomoResult> {
  const { kloc, reasoningComplexity, contextCompleteness, transformationImpact, iterativeCycles, humanOversight } = params;

  if (kloc <= 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "KLOC must be positive.",
        retryHint: "Provide a positive value for kloc (thousands of lines of code).",
      },
    };
  }

  if (kloc > 1e9) {
    return {
      ok: false,
      error: {
        isError: true,
        message: `KLOC value ${kloc} is too large — computation would overflow.`,
        retryHint: "Provide a kloc value under 1,000,000,000.",
      },
    };
  }

  const A = 2.94;
  const B = 1.10;
  const emProduct = reasoningComplexity * contextCompleteness * transformationImpact * iterativeCycles * humanOversight;
  const personMonthsNominal = A * Math.pow(kloc, B) * emProduct;

  const llmOverhead = 1.0 + (iterativeCycles - 1.0) * 0.15;
  // AI speedup: empirical data shows 8-15x for typical tasks, scaling with complexity
  // Base divisor 8.0 (8x speedup) increasing with lower iterative cycles (more one-shot)
  const aiSpeedupDivisor = Math.max(3.0, 12.0 / llmOverhead);
  const personMonthsLlmAdjusted = personMonthsNominal / aiSpeedupDivisor;

  if (!Number.isFinite(personMonthsNominal) || !Number.isFinite(personMonthsLlmAdjusted)) {
    return { ok: false, error: { isError: true, message: "COCOMO computation produced invalid result.", retryHint: "Ensure kloc and all rating multipliers are finite positive numbers." } };
  }

  return {
    ok: true,
    data: {
      kloc,
      personMonthsNominal: Math.round(personMonthsNominal * 10) / 10,
      personMonthsLlmAdjusted: Math.round(personMonthsLlmAdjusted * 10) / 10,
      effortMultipliers: {
        reasoning_complexity: reasoningComplexity,
        context_completeness: contextCompleteness,
        transformation_impact: transformationImpact,
        iterative_cycles: iterativeCycles,
        human_oversight: humanOversight,
        product: Math.round(emProduct * 1000) / 1000,
      },
      assumptions: [
        "Based on COCOMO II Post-Architecture model (A=2.94, B=1.10).",
        "LLM productivity factor derived from empirical agent benchmarks.",
        "Cost drivers scaled for LLM-assisted workflows.",
        "Adjust for your team's actual velocity.",
      ],
    },
  };
}

export function criticalPath(tasks: CpmTask[]): ToolResult<CpmResult> {
  if (tasks.length === 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "Task list must not be empty.",
        retryHint: "Provide at least one task for critical path analysis.",
      },
    };
  }
  const taskMap = new Map<string, CpmTask>();
  for (const t of tasks) {
    if (taskMap.has(t.name)) {
      return {
        ok: false,
        error: {
          isError: true,
          message: `Duplicate task name: "${t.name}".`,
          retryHint: "Each task must have a unique name.",
        },
      };
    }
    taskMap.set(t.name, t);
  }

  for (const t of tasks) {
    for (const p of t.predecessors) {
      if (!taskMap.has(p)) {
        return {
          ok: false,
          error: {
            isError: true,
            message: `Unknown predecessor "${p}" in task "${t.name}".`,
            retryHint: "Ensure all predecessor names match task names exactly.",
          },
        };
      }
    }
  }

  const sorted = topologicalSort(tasks);
  if (sorted.length !== tasks.length) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "Circular dependency detected in task graph.",
        retryHint: "Remove cycles from task predecessor chains.",
      },
    };
  }

  // Forward pass
  const es = new Map<string, number>();
  const ef = new Map<string, number>();

  for (const name of sorted) {
    const task = taskMap.get(name);
    if (!task) continue;
    let mergeBias = 1.0;
    if (task.predecessors.length > 2) {
      mergeBias = 1.0 + 0.05 * (task.predecessors.length - 2);
    }
    const adjustedDuration = task.duration * mergeBias;

    const earliestStart = task.predecessors.length === 0
      ? 0
      : Math.max(...task.predecessors.map(p => ef.get(p) ?? 0));
    es.set(name, earliestStart);
    ef.set(name, earliestStart + adjustedDuration);
  }

  const totalDuration = Math.max(...[...ef.values()]);

  // Backward pass
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();

  for (let i = sorted.length - 1; i >= 0; i--) {
    const name = sorted[i];
    if (!name) continue;
    const task = taskMap.get(name);
    if (!task) continue;
    const mergeBias = task.predecessors.length > 2
      ? 1.0 + 0.05 * (task.predecessors.length - 2)
      : 1.0;
    const adjustedDuration = task.duration * mergeBias;

    const successors = tasks.filter(t => t.predecessors.includes(name));
    const latestFinish = successors.length === 0
      ? totalDuration
      : Math.min(...successors.map(s => ls.get(s.name) ?? 0));
    lf.set(name, latestFinish);
    ls.set(name, latestFinish - adjustedDuration);
  }

  const slackPerTask: Record<string, number> = {};
  const criticalPath: string[] = [];
  let totalMergeBias = 0;

  for (const name of sorted) {
    const task = taskMap.get(name);
    if (!task) continue;
    const slack = Math.round(((ls.get(name) ?? 0) - (es.get(name) ?? 0)) * 100) / 100;
    slackPerTask[name] = slack;
    if (slack <= 0.01) {
      criticalPath.push(name);
    }
    if (task.predecessors.length > 2) {
      totalMergeBias += 0.05 * (task.predecessors.length - 2);
    }
  }

  return {
    ok: true,
    data: {
      critical_path: criticalPath,
      slack_per_task: slackPerTask,
      total_duration: Math.round(totalDuration * 100) / 100,
      merge_bias_adjustment: Math.round(totalMergeBias * 100) / 100,
    },
  };
}

function topologicalSort(tasks: CpmTask[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    inDegree.set(t.name, t.predecessors.length);
    adj.set(t.name, []);
  }
  for (const t of tasks) {
    for (const p of t.predecessors) {
      const list = adj.get(p);
      if (list) list.push(t.name);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    result.push(current);
    for (const next of adj.get(current) ?? []) {
      const prev = inDegree.get(next);
      if (prev === undefined) continue;
      const newDeg = prev - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return result;
}

export function monteCarloSim(
  tasks: MonteCarloTask[],
  iterations: number,
  seed?: number,
): MonteCarloResult {
  if (iterations <= 0) {
    return {
      p10: "0", p50: "0", p80: "0", p95: "0",
      criticalPathProbability: 0,
      riskEvents: [{ description: "Iterations must be >= 1.", probability: 1, impactDays: 0 }],
      humanReadable: "Error: Iterations must be a positive number.",
    };
  }
  for (const task of tasks) {
    if (!(task.optimistic <= task.mostLikely && task.mostLikely <= task.pessimistic)) {
      return {
        p10: "0", p50: "0", p80: "0", p95: "0",
        criticalPathProbability: 0,
        riskEvents: [{
          description: `Invalid estimates for task "${task.name}": optimistic (${task.optimistic}) must be <= mostLikely (${task.mostLikely}) <= pessimistic (${task.pessimistic}).`,
          probability: 1,
          impactDays: 0,
        }],
        humanReadable: `Error: Task "${task.name}" has invalid PERT estimates.`,
      };
    }
  }

  const rng = seededRandom(seed ?? 42);

  const durations: number[] = [];
  const taskOverruns = new Map<string, number>();

  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const task of tasks) {
      const sampled = triangularSample(task.optimistic, task.mostLikely, task.pessimistic, rng);
      total += sampled;
      const expected = (task.optimistic + 4 * task.mostLikely + task.pessimistic) / 6;
      if (sampled > expected * 1.5) {
        taskOverruns.set(task.name, (taskOverruns.get(task.name) ?? 0) + 1);
      }
    }
    durations.push(total);
  }

  durations.sort((a, b) => a - b);

  const p = (percentile: number): number => {
    const idx = Math.min(Math.floor(iterations * percentile), durations.length - 1);
    return durations[idx] ?? 0;
  };

  const riskEvents = [...taskOverruns.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([task, count]) => ({
      description: `Task "${task}" exceeded 1.5x PERT expected in ${Math.round(count / iterations * 100)}% of simulations`,
      probability: Math.round(count / iterations * 100) / 100,
      impactDays: Math.round(p(0.95) - p(0.5)),
    }));

  const p50Val = p(0.5);
  const criticalTarget = p(0.8);

  return {
    p10: String(Math.round(p(0.1) * 100) / 100),
    p50: String(Math.round(p50Val * 100) / 100),
    p80: String(Math.round(p(0.8) * 100) / 100),
    p95: String(Math.round(p(0.95) * 100) / 100),
    estimatedHours: Math.round(p50Val * 8 * 100) / 100,
    criticalPathProbability: Math.round((durations.filter(d => d <= criticalTarget).length / iterations) * 100) / 100,
    riskEvents,
    humanReadable: `Monte Carlo simulation (${iterations} iterations): Optimistic (p10): ${String(Math.round(p(0.1) * 100) / 100)} days. Median (p50): ${String(Math.round(p50Val * 100) / 100)} days. Conservative (p95): ${String(Math.round(p(0.95) * 100) / 100)} days. Probability of meeting p80 target: ${Math.round((durations.filter(d => d <= criticalTarget).length / iterations) * 100)}%.`,
  };
}

function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function triangularSample(min: number, mode: number, max: number, rng: () => number): number {
  if (max === min) return min;
  const u = rng();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}
