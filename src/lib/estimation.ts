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
import { getUrgencyCategory } from "./internal/urgency.js";

function toHours(value: number, unit: TimeUnit): number {
  switch (unit) {
    case "hours": return value;
    case "days": return value * 8;
    case "weeks": return value * 40;
    case "months": return value * 160;
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

  const A = 2.94;
  const B = 1.10;
  const emProduct = reasoningComplexity * contextCompleteness * transformationImpact * iterativeCycles * humanOversight;
  const personMonthsNominal = A * Math.pow(kloc, B) * emProduct;

  const llmOverhead = 1.0 + (iterativeCycles - 1.0) * 0.15;
  const personMonthsLlmAdjusted = personMonthsNominal / Math.max(1.5, 3.0 / llmOverhead);

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
      adj.get(p)!.push(t.name);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const next of adj.get(current) ?? []) {
      const newDeg = inDegree.get(next)! - 1;
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
  const u = rng();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}
