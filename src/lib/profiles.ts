import type { DeveloperProfile } from "../types/index.js";
import { getGlobalCorrectionFactor } from "./self-improve.js";
import { getHumanBaselines, getEstimationResearch } from "./supplementary-data.js";

// ---------------------------------------------------------------------------
// Developer Profiles — AI-native vs human estimation parameters
// ---------------------------------------------------------------------------

export function getDeveloperProfile(aiNative: boolean): DeveloperProfile {
  if (aiNative) {
    const correctionFactor = getGlobalCorrectionFactor();

    return {
      mode: "ai_native",
      featureDevTimeDays: 4,
      bugfixTimeHours: 8,
      sprintVelocityPoints: 80,
      estimationMape: 15,
      underestimationBias: 0.2,
      correctionFactor,
    };
  }

  const baselines = getHumanBaselines();
  const research = getEstimationResearch();

  return {
    mode: "human",
    featureDevTimeDays: baselines?.featureDevTimeDays?.median ?? 14,
    bugfixTimeHours: baselines?.bugfixTimeHours?.median ?? 72,
    sprintVelocityPoints: baselines?.sprintVelocityPoints?.median ?? 35,
    estimationMape: research?.expertEstimatesWithinPercent ?? 25,
    underestimationBias: research ? research.underestimationRate / 100 : 0.575,
    correctionFactor: 1.8,
  };
}
