import { sprintForecast } from "../src/lib/estimation.js";
const r = sprintForecast({ backlogPoints: 13, velocityHistory: [21, 24, 19, 22], sprintLengthDays: 14, hoursPerSprint: 80 });
console.log("ok:", r.ok);
if (r.ok) console.log("outputs:", JSON.stringify(r.data));
