// ---------------------------------------------------------------------------
// Epoch MCP Server — Core Type Definitions
// KyaniteLabs | Time Estimation for LLMs
// ---------------------------------------------------------------------------

// ---- Primitives & Enums ---------------------------------------------------

/** How urgent the estimate window is, used for PERT output categorization. */
export type UrgencyCategory = "short" | "medium" | "long";

/** Confidence qualifier attached to estimates and forecasts. */
export type ConfidenceLevel = "likely" | "optimistic" | "pessimistic";

/** Time units understood across all estimation tools. */
export type TimeUnit = "hours" | "days" | "weeks" | "months";

// ---- Branded Types (Matt Pocock Pattern) ----------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

/** Branded number representing hours. */
export type Hours = Brand<number, "Hours">;
/** Branded number representing calendar days. */
export type Days = Brand<number, "Days">;
/** Branded number representing weeks. */
export type Weeks = Brand<number, "Weeks">;
/** Branded number representing thousands of lines of code. */
export type Kloc = Brand<number, "Kloc">;
/** Branded number representing USD cost. */
export type CostUsd = Brand<number, "CostUsd">;
/** Branded number representing a token count. */
export type Tokens = Brand<number, "Tokens">;
/** Branded number representing tokens per second throughput. */
export type TokensPerSecond = Brand<number, "TokensPerSecond">;
/** Branded number representing a percentage (0-100). */
export type Percentage = Brand<number, "Percentage">;

// ---- Brand constructors (use at module boundaries only) ---------------------

export function hours(n: number): Hours { return n as Hours; }
export function days(n: number): Days { return n as Days; }
export function weeks(n: number): Weeks { return n as Weeks; }
export function kloc(n: number): Kloc { return n as Kloc; }
export function costUsd(n: number): CostUsd { return n as CostUsd; }
export function tokens(n: number): Tokens { return n as Tokens; }
export function tokensPerSecond(n: number): TokensPerSecond { return n as TokensPerSecond; }
export function percentage(n: number): Percentage { return n as Percentage; }

// ---- Temporal Layer -------------------------------------------------------

export interface TemporalResult {
  /** ISO-8601 timestamp (e.g. "2025-07-12T14:30:00.000Z"). */
  readonly iso: string;
  /** Human-readable representation (e.g. "Saturday, July 12, 2025 at 2:30 PM"). */
  readonly humanReadable: string;
  /** IANA timezone identifier (e.g. "America/New_York"). */
  readonly timezone: string;
  /** UTC offset string (e.g. "-04:00"). */
  readonly utcOffset: string;
}

// ---- Duration Layer -------------------------------------------------------

export interface DurationResult {
  /** The original input string that was parsed. */
  readonly input: string;
  /** Total duration expressed in seconds. */
  readonly totalSeconds: number;
  /** Human-readable form (e.g. "2 hours 30 minutes"). */
  readonly humanReadable: string;
}

// ---- Business Day Layer ---------------------------------------------------

export interface BusinessDayResult {
  /** Start date in ISO format. */
  readonly startDate: string;
  /** End date in ISO format. */
  readonly endDate: string;
  /** Number of business days between start and end (inclusive). */
  readonly businessDays: number;
  /** ISO-3166-1-alpha-2 country code used for holiday calculation. */
  readonly countryCode: string;
  /** Human-readable summary (e.g. "19 business days between May 1, 2026 and May 31, 2026 (US)"). */
  readonly humanReadable: string;
}

// ---- PERT Estimation Layer ------------------------------------------------

export interface PertResult {
  readonly optimistic: number;
  readonly mostLikely: number;
  readonly pessimistic: number;
  readonly expected: number;
  readonly variance: number;
  readonly stdDeviation: number;
  /** 95 % confidence interval as [lower, upper]. */
  readonly confidence95: readonly [number, number];
  /** 99 % confidence interval as [lower, upper]. */
  readonly confidence99: readonly [number, number];
  readonly unit: TimeUnit;
  readonly urgencyCategory: UrgencyCategory;
  /** Human-readable summary (e.g. "Expected: 7 hours. 95% confidence: 1 to 13 hours."). */
  readonly humanReadable: string;
}

// ---- COCOMO Estimation Layer ----------------------------------------------

export interface CocomoResult {
  /** Thousands of lines of code. */
  readonly kloc: number;
  /** Nominal effort in person-months (classic COCOMO). */
  readonly personMonthsNominal: number;
  /** Effort adjusted for LLM-assisted workflows. */
  readonly personMonthsLlmAdjusted: number;
  /** Multiplier details that were applied. */
  readonly effortMultipliers: Readonly<Record<string, number>>;
  /** Documented assumptions behind the estimate. */
  readonly assumptions: readonly string[];
}

// ---- Sprint Forecast Layer ------------------------------------------------

export interface SprintForecastResult {
  /** Total story/effort points in the backlog. */
  readonly backlogPoints: number;
  /** Rolling average velocity from historical data. */
  readonly averageVelocity: number;
  /** Number of sprints required at average velocity. */
  readonly requiredSprints: number;
  /** Upper-bound sprint count (pessimistic velocity). */
  readonly pessimisticSprints: number;
  /** Estimated hours per story point. */
  readonly hoursPerPoint: number;
  /** Total estimated hours to clear the backlog. */
  readonly totalHours: number;
  /** Calendar days to completion assuming no gaps. */
  readonly completionDays: number;
  /** Length of a single sprint in calendar days. */
  readonly sprintLengthDays: number;
}

// ---- Token-Time Bridge Layer ----------------------------------------------

export interface TokenTimeBreakdown {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly toolOverheadSeconds: number;
}

export interface TokenTimeMapping {
  /** Number of tokens in the request. */
  readonly tokens: number;
  /** Model identifier used for the estimate. */
  readonly model: string;
  /** Estimated wall-clock seconds. */
  readonly estimatedSeconds: number;
  /** Estimated wall-clock minutes (derived). */
  readonly estimatedMinutes: number;
  /** Confidence level of the estimate. */
  readonly confidence: ConfidenceLevel;
  /** Urgency bucket derived from estimated wall-clock time. */
  readonly urgency: UrgencyCategory;
  /** Breakdown of where time is spent. */
  readonly breakdown: TokenTimeBreakdown;
  /** Human-readable summary (e.g. "Approximately 21 minutes for 100,000 tokens with claude-sonnet-4."). */
  readonly humanReadable: string;
}

// ---- Monte Carlo Layer ----------------------------------------------------

export interface RiskEvent {
  /** Human-readable risk description. */
  readonly description: string;
  /** Probability of occurrence (0-1). */
  readonly probability: number;
  /** Expected schedule impact in days. */
  readonly impactDays: number;
}

export interface MonteCarloResult {
  /** 10th-percentile completion date (optimistic). */
  readonly p10: string;
  /** 50th-percentile completion date (median). */
  readonly p50: string;
  /** 80th-percentile completion date. */
  readonly p80: string;
  /** 95th-percentile completion date (conservative). */
  readonly p95: string;
  /** Median estimate converted to hours (p50 × 8). Enables feedback token. */
  readonly estimatedHours: number;
  /** Probability the critical path will be met (0-1). */
  readonly criticalPathProbability: number;
  /** Identified risk events and their characteristics. */
  readonly riskEvents: readonly RiskEvent[];
  /** Human-readable summary (e.g. "Median (p50): 7.99 days. Conservative (p95): 12.81 days."). */
  readonly humanReadable: string;
}

// ---- Error Handling -------------------------------------------------------

/** Structured error returned when a tool invocation fails. */
export interface ToolError {
  readonly isError: true;
  readonly message: string;
  readonly retryHint?: string;
}

/** Discriminated-union result wrapper — every tool returns this shape. */
export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ToolError };

// ---- Reference Class Estimation -------------------------------------------

export type TaskType =
  | "feature"
  | "bugfix"
  | "refactor"
  | "migration"
  | "infrastructure"
  | "documentation"
  | "testing"
  | "design";

// ---- LLM Model Identifiers -----------------------------------------------

export type LLMModel =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "claude-sonnet-4-20250514"
  | "claude-opus-4-20250514"
  | "claude-3.5-haiku-20241022"
  | "gemini-2.0-flash"
  | "gemini-2.5-pro"
  | "llama-3.1-70b"
  | "llama-3.1-405b"
  | "mistral-large"
  | "deepseek-v3";

// ---- Token Time Reasoning Depth -------------------------------------------

export type ReasoningDepth = "shallow" | "moderate" | "deep";

// ---- Additional Temporal Types ---------------------------------------------

export interface DateDiffResult {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly total_seconds: number;
}

// ---- Critical Path Method (CPM) ------------------------------------------

/** Task node used in critical-path calculations. */
export interface CpmTask {
  readonly name: string;
  readonly duration: number;
  readonly predecessors: readonly string[];
}

/** Result of a critical-path analysis. */
export interface CpmResult {
  /** Ordered list of task names on the critical path. */
  readonly critical_path: readonly string[];
  /** Slack (float) per task in the same unit as duration. */
  readonly slack_per_task: Readonly<Record<string, number>>;
  /** Total project duration. */
  readonly total_duration: number;
  /** Cumulative merge-bias adjustment applied. */
  readonly merge_bias_adjustment: number;
}

// ---- Monte Carlo Task Input -----------------------------------------------

/** Task with three-point estimate for Monte Carlo simulation. */
export interface MonteCarloTask {
  readonly name: string;
  readonly optimistic: number;
  readonly mostLikely: number;
  readonly pessimistic: number;
}

// ---- Accuracy Metrics -----------------------------------------------------

/** Calibration metrics computed from historical estimation data. */
export interface AccuracyMetrics {
  /** Mean Absolute Percentage Error across all samples. */
  readonly mape: number;
  /** Median Absolute Percentage Error — robust to outliers. */
  readonly mdape: number;
  /** Mean bias (positive = underestimation, negative = overestimation). */
  readonly bias: number;
  /** Variance of the bias distribution. */
  readonly variance: number;
  /** Number of samples used in the calculation. */
  readonly sample_size: number;
  /** Whether accuracy is improving, degrading, or stable over time. */
  readonly trend: "improving" | "degrading" | "stable";
}

// ---- Supported Countries --------------------------------------------------

export type SupportedCountry = "US" | "UK" | "FR" | "DE" | "JP";

// ---- Cost Estimation (Feature 1) -----------------------------------------

export interface TokenCostEstimate {
  readonly tokens: number;
  readonly model: string;
  readonly estimatedSeconds: number;
  readonly estimatedMinutes: number;
  readonly estimatedCost: number;
  readonly costBreakdown: {
    readonly inputCost: number;
    readonly outputCost: number;
    readonly toolCallOverheadCost: number;
  };
  readonly timeBreakdown: TokenTimeBreakdown;
  readonly confidence: ConfidenceLevel;
  readonly urgency: UrgencyCategory;
  readonly humanReadable: string;
}

// ---- Model Comparison (Feature 2) ----------------------------------------

export type QualityTier = "fast" | "standard" | "premium";

export interface ModelComparisonEntry {
  readonly model: string;
  readonly estimatedSeconds: number;
  readonly estimatedMinutes: number;
  readonly estimatedCost: number;
  readonly costAvailable: boolean;
  readonly qualityTier: QualityTier;
  readonly tokensPerSecond: number;
}

export interface ModelComparison {
  readonly tokens: number;
  readonly models: readonly ModelComparisonEntry[];
  readonly sortBy: string;
  readonly humanReadable: string;
}

// ---- Accuracy Trend (Feature 3) ------------------------------------------

export interface AccuracyWindow {
  readonly period: string;
  readonly dateRange?: string;
  readonly mape: number;
  readonly mdape: number;
  readonly bias: number;
  readonly sampleSize: number;
}

export interface AccuracyTrend {
  readonly windows: readonly AccuracyWindow[];
  readonly overallTrend: "improving" | "degrading" | "stable";
  readonly currentMape: number;
  readonly industryBaselineMape: number;
  readonly improvementVsIndustry: number;
  readonly totalEstimates: number; // total matched estimate-actual pairs analyzed
  readonly totalWithActuals: number; // same as totalEstimates (all records are matched)
  readonly humanReadable: string;
}

// ---- Schedule Risk (Feature 4) -------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ScheduleRiskAssessment {
  readonly estimatedHours: number;
  readonly riskLevel: RiskLevel;
  readonly confidenceIntervals: {
    readonly p50: number;
    readonly p80: number;
    readonly p95: number;
  };
  readonly historicalAccuracy: {
    readonly mape: number;
    readonly sampleSize: number;
  };
  readonly recommendation: string;
  readonly humanReadable: string;
}

// ---- COCOMO Validation (Feature 5) --------------------------------------

export interface CocomoValidationReport {
  readonly projectsEvaluated: number;
  readonly mape: number;
  readonly bias: number;
  readonly byProjectType: Readonly<Record<string, { readonly mape: number; readonly count: number }>>;
  readonly recommendedAdjustments: ReadonlyArray<{
    readonly parameter: string;
    readonly currentValue: number;
    readonly recommendedValue: number;
    readonly reason: string;
  }>;
  readonly humanReadable: string;
}

// ---- Developer Profile (Feature 6) --------------------------------------

export interface DeveloperProfile {
  readonly mode: "ai_native" | "human" | "hybrid";
  readonly aiRatio: number;
  readonly featureDevTimeDays: number;
  readonly bugfixTimeHours: number;
  readonly sprintVelocityPoints: number;
  readonly estimationMape: number;
  readonly underestimationBias: number;
  readonly correctionFactor: number;
}

// ---- Exhaustiveness Check --------------------------------------------------

/** Compile-time exhaustiveness check for switch statements. */
export function assertNever(x: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(x)}`);
}

// ---- Re-exports from lib ---------------------------------------------------

export type { HistoricalRecord } from "../lib/analytics.js";
