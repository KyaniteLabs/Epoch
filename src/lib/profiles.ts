import type { DeveloperProfile } from "../types/index.js";
import { getGlobalCorrectionFactor } from "./self-improve.js";
import { getHumanBaselines, getEstimationResearch } from "./supplementary-data.js";

// ---------------------------------------------------------------------------
// Developer Profiles — AI-native / human / hybrid gradient interpolation
// ---------------------------------------------------------------------------
// aiRatio: 0.0 = fully human, 1.0 = fully AI-native, 0.5 = equal mix.
// All profile fields interpolate linearly between the two anchor points.

interface Anchor {
  featureDevTimeDays: number;
  bugfixTimeHours: number;
  sprintVelocityPoints: number;
  estimationMape: number;
  underestimationBias: number;
}

const AI_NATIVE_ANCHOR: Anchor = {
  featureDevTimeDays: 0.72,
  bugfixTimeHours: 6.15,
  sprintVelocityPoints: 80,
  estimationMape: 15,
  underestimationBias: 0.2,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function getHumanAnchor(): Anchor {
  const baselines = getHumanBaselines();
  const research = getEstimationResearch();
  return {
    featureDevTimeDays: baselines?.featureDevTimeDays?.median ?? 14,
    bugfixTimeHours: baselines?.bugfixTimeHours?.median ?? 72,
    sprintVelocityPoints: baselines?.sprintVelocityPoints?.median ?? 35,
    estimationMape: research?.expertEstimatesWithinPercent ?? 25,
    underestimationBias: research ? research.underestimationRate / 100 : 0.575,
  };
}

/** @deprecated Use getDeveloperProfileGradient for float aiRatio support. */
export function getDeveloperProfile(aiNative: boolean): DeveloperProfile {
  return getDeveloperProfileGradient(aiNative ? 1.0 : 0.0);
}

export function getDeveloperProfileGradient(aiRatio: number): DeveloperProfile {
  const clamped = Math.max(0, Math.min(1, aiRatio));

  const human = getHumanAnchor();
  const ai = AI_NATIVE_ANCHOR;

  const mode: DeveloperProfile["mode"] =
    clamped >= 1.0 ? "ai_native" : clamped <= 0.0 ? "human" : "hybrid";

  // Correction factor: human=1.8, AI-native=from reference DB (default 1.07)
  const humanCF = 1.8;
  const aiCF = getGlobalCorrectionFactor();

  return {
    mode,
    aiRatio: clamped,
    featureDevTimeDays: Math.round(lerp(human.featureDevTimeDays, ai.featureDevTimeDays, clamped) * 100) / 100,
    bugfixTimeHours: Math.round(lerp(human.bugfixTimeHours, ai.bugfixTimeHours, clamped) * 100) / 100,
    sprintVelocityPoints: Math.round(lerp(human.sprintVelocityPoints, ai.sprintVelocityPoints, clamped) * 10) / 10,
    estimationMape: Math.round(lerp(human.estimationMape, ai.estimationMape, clamped) * 10) / 10,
    underestimationBias: Math.round(lerp(human.underestimationBias, ai.underestimationBias, clamped) * 1000) / 1000,
    correctionFactor: Math.round(lerp(humanCF, aiCF, clamped) * 100) / 100,
  };
}
