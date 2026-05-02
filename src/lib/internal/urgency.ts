import type { UrgencyCategory } from "../../types/index.js";

export function getUrgencyCategory(hours: number): UrgencyCategory {
  if (hours < 2) return "short";
  if (hours <= 48) return "medium";
  return "long";
}
