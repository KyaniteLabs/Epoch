import { sprintForecast, recordEstimate as recEst } from "../src/lib/estimation.js";
import { recordEstimate, recordActual } from "../src/lib/feedback.js";

// Record a sprint forecast estimate and actual with matching scale
// Actual: 40 hours for a 13-point backlog (realistic for a small team)
const r = sprintForecast({ backlogPoints: 13, velocityHistory: [21, 24, 19, 22], sprintLengthDays: 14, hoursPerSprint: 80 });
if (r.ok) {
  const id = recordEstimate("sprint_forecast", { task_type: "feature" }, r.data as unknown as Record<string, unknown>);
  recordActual(id, 40, "Actual sprint hours for 13-point backlog clearance");
  console.log(`SF: id=${id}, estimated=${r.data.totalHours}h, actual=40h`);
}
