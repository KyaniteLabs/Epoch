import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---- Types ----------------------------------------------------------------

export interface ModelPricing {
  readonly tokensPerSecond: number;
  readonly timeToFirstTokenMs: number;
  readonly avgApiLatencyMs: number;
  readonly costInput: number;
  readonly costOutput: number;
}

export interface HumanDeveloperBaselines {
  readonly featureDevTimeDays: { median: number; p25: number; p75: number };
  readonly bugfixTimeHours: { median: number; p25: number; p75: number };
  readonly sprintVelocityPoints: { median: number; p25: number; p75: number };
  readonly commitsPerDayPerDeveloper: { median: number; p25: number; p75: number };
  readonly prsPerWeekPerDeveloper: { median: number; p25: number; p75: number };
  readonly activeCodingMinutesPerDay: { median: number };
}

export interface EstimationAccuracyResearch {
  readonly expertEstimatesWithinPercent: number;
  readonly taskLevelMRE: Record<string, number>;
  readonly underestimationRate: number;
  readonly averageScheduleOverrunPercent: number;
}

export interface CocomoProject {
  readonly id: number;
  readonly kloc: number;
  readonly effortPersonMonths: number;
  readonly type?: string;
  readonly language?: string;
  readonly year?: number;
  readonly category?: string;
  readonly functionPoints?: number;
  readonly effortWorkHours?: number;
  readonly durationMonths?: number;
}

export interface CocomoDataset {
  readonly name: string;
  readonly projects: readonly CocomoProject[];
}

export interface CocomoDerivedFactors {
  readonly cocomoBasic: Record<string, { a: number; b: number; c: number; d: number }>;
  readonly productivityKlocPerPersonMonth: { median: number; p25: number; p75: number };
}

// ---- Supplementary Database -----------------------------------------------

interface SupplementaryDatabase {
  readonly version: string;
  readonly modelCalibration?: Record<string, ModelPricing>;
  readonly humanDeveloperBaselines?: HumanDeveloperBaselines;
  readonly estimationAccuracyResearch?: EstimationAccuracyResearch;
  readonly developerProfileContrast?: {
    readonly humanDeveloper: Record<string, number>;
    readonly aiNativeDeveloper: Record<string, number>;
  };
  readonly toolCallOverheadMs?: number;
}

interface CocomoCalibrationData {
  readonly cocomoCalibration: {
    readonly datasets: readonly CocomoDataset[];
    readonly derivedFactors: CocomoDerivedFactors;
  };
}

// ---- Lazy Singleton Loader ------------------------------------------------

let _supplementary: SupplementaryDatabase | null | undefined = undefined;
let _cocomo: CocomoCalibrationData | null | undefined = undefined;

function getDataDir(): string {
  return process.env.EPOCH_DATA_DIR ?? join(homedir(), ".epoch");
}

export function loadSupplementaryData(): SupplementaryDatabase | null {
  if (_supplementary !== undefined) return _supplementary;

  const paths = [
    join(getDataDir(), "supplementary-database.json"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        _supplementary = JSON.parse(readFileSync(p, "utf-8")) as SupplementaryDatabase;
        return _supplementary;
      } catch {
        _supplementary = null;
        return null;
      }
    }
  }

  _supplementary = null;
  return null;
}

export function loadCocomoData(): CocomoCalibrationData | null {
  if (_cocomo !== undefined) return _cocomo;

  const paths = [
    join(getDataDir(), "cocomo-calibration-data.json"),
    join(getDataDir(), "supplementary-database.json"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
        if (raw.cocomoCalibration) {
          _cocomo = raw as unknown as CocomoCalibrationData;
          return _cocomo;
        }
      } catch {
        continue;
      }
    }
  }

  _cocomo = null;
  return null;
}

// ---- Convenience Accessors ------------------------------------------------

export function getModelPricing(model: string): ModelPricing | null {
  const db = loadSupplementaryData();
  return db?.modelCalibration?.[model] ?? null;
}

// getAllModelPricing is defined below with community data support

export function getHumanBaselines(): HumanDeveloperBaselines | null {
  return loadSupplementaryData()?.humanDeveloperBaselines ?? null;
}

export function getEstimationResearch(): EstimationAccuracyResearch {
  const db = loadSupplementaryData();
  return db?.estimationAccuracyResearch ?? {
    expertEstimatesWithinPercent: 25,
    taskLevelMRE: { features: 0.63, bugfixes: 0.70, refactoring: 0.43 },
    underestimationRate: 57.5,
    averageScheduleOverrunPercent: 189,
  };
}

export function getToolCallOverheadMs(): number {
  return loadSupplementaryData()?.toolCallOverheadMs ?? 200;
}

// getCocomoProjects is defined below with community data support

export function getCocomoDerivedFactors(): CocomoDerivedFactors | null {
  const data = loadCocomoData();
  return data?.cocomoCalibration?.derivedFactors ?? null;
}

export function getDeveloperProfileContrast(): { human: Record<string, number>; aiNative: Record<string, number> } {
  const db = loadSupplementaryData();
  const contrast = db?.developerProfileContrast;
  return {
    human: contrast?.humanDeveloper ?? { featureDevTimeDays: 14, bugfixTimeHours: 72, sprintVelocityPoints: 35 },
    aiNative: contrast?.aiNativeDeveloper ?? { featureDevTimeDays: 4, bugfixTimeHours: 8, sprintVelocityPoints: 80 },
  };
}

// ---- Community Data ---------------------------------------------------------

export interface CommunityEstimationRecord {
  estimated_hours: number;
  actual_hours: number;
  task_type: string;
  complexity: number;
  team_size?: number;
  model_used?: string;
  tokens_used?: number;
  tool_calls?: number;
  reasoning_depth?: string;
  timestamp: string;
  contributor_id?: string;
}

export interface CommunityModelCalibration {
  model: string;
  tokens_per_second: number;
  time_to_first_token_ms: number;
  avg_api_latency_ms: number;
  cost_input_per_million: number;
  cost_output_per_million: number;
  benchmark_source?: string;
  measured_at: string;
  contributor_id?: string;
}

export interface CommunityCocomoProject {
  name: string;
  kloc: number;
  effort_person_months: number;
  type: string;
  language?: string;
  year?: number;
  category?: string;
  function_points?: number;
  duration_months?: number;
  team_size?: number;
  contributor_id?: string;
}

export interface CommunitySprintVelocity {
  sprint_length_days: number;
  points_completed: number;
  team_size: number;
  hours_per_sprint?: number;
  backlog_size_points?: number;
  timestamp: string;
  contributor_id?: string;
}

export interface CommunityData {
  estimationRecords: CommunityEstimationRecord[];
  modelCalibration: CommunityModelCalibration[];
  cocomoProjects: CommunityCocomoProject[];
  sprintVelocity: CommunitySprintVelocity[];
}

const SCHEMA_MAP: Record<string, keyof CommunityData> = {
  "estimation-record": "estimationRecords",
  "model-calibration": "modelCalibration",
  "cocomo-project": "cocomoProjects",
  "sprint-velocity": "sprintVelocity",
};

function getCommunityDir(): string {
  if (process.env.EPOCH_COMMUNITY_DIR) return process.env.EPOCH_COMMUNITY_DIR;
  const cwdBased = join(process.cwd(), "data", "community");
  if (existsSync(cwdBased)) return cwdBased;
  try {
    const pkgBased = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "community");
    if (existsSync(pkgBased)) return pkgBased;
  } catch { /* import.meta.url may not be available in all contexts */ }
  return cwdBased;
}

let _communityData: CommunityData | undefined = undefined;

export function loadCommunityData(): CommunityData {
  if (_communityData !== undefined) return _communityData;

  const result: CommunityData = {
    estimationRecords: [],
    modelCalibration: [],
    cocomoProjects: [],
    sprintVelocity: [],
  };

  const dir = getCommunityDir();
  if (!existsSync(dir)) {
    _communityData = result;
    return result;
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    _communityData = result;
    return result;
  }

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<string, unknown>;
      const schema = raw["_schema"] as string | undefined;
      const key = schema ? SCHEMA_MAP[schema] : undefined;
      if (!key || !Array.isArray(raw["records"])) continue;

      const records = raw["records"] as unknown[];
      for (const rec of records) {
        (result[key] as unknown[]).push(rec);
      }
    } catch (err) {
      process.stderr.write(`[epoch] Warning: skipping community file ${file}: ${err}\n`);
    }
  }

  _communityData = result;
  return result;
}

// ---- Updated Accessors with Community Data ----------------------------------

export function getAllModelPricing(): Record<string, ModelPricing> {
  const db = loadSupplementaryData();
  const base = (db?.modelCalibration ?? {}) as Record<string, ModelPricing>;
  const community = loadCommunityData();
  if (community.modelCalibration.length === 0) return base;

  const merged = { ...base };
  for (const cal of community.modelCalibration) {
    // Community data augments but does not overwrite supplementary data
    if (!(cal.model in merged)) {
      merged[cal.model] = {
        tokensPerSecond: cal.tokens_per_second,
        timeToFirstTokenMs: cal.time_to_first_token_ms,
        avgApiLatencyMs: cal.avg_api_latency_ms,
        costInput: cal.cost_input_per_million / 1_000_000,
        costOutput: cal.cost_output_per_million / 1_000_000,
      };
    }
  }
  return merged;
}

export function getCocomoProjects(): readonly CocomoDataset[] {
  const data = loadCocomoData();
  const base = data?.cocomoCalibration?.datasets ?? [];
  const community = loadCommunityData();
  if (community.cocomoProjects.length === 0) return base;

  const communityDataset: CocomoDataset = {
    name: "community",
    projects: community.cocomoProjects.map((p, i) => ({
      id: 10000 + i,
      kloc: p.kloc,
      effortPersonMonths: p.effort_person_months,
      type: p.type,
      language: p.language,
      year: p.year,
      category: p.category,
      functionPoints: p.function_points,
      durationMonths: p.duration_months,
    })),
  };
  return [...base, communityDataset];
}

export function getCommunitySprints(): readonly CommunitySprintVelocity[] {
  return loadCommunityData().sprintVelocity;
}

export function getCommunityEstimationRecords(): readonly CommunityEstimationRecord[] {
  return loadCommunityData().estimationRecords;
}

export function resetSupplementaryCache(): void {
  _supplementary = undefined;
  _cocomo = undefined;
  _communityData = undefined;
}
