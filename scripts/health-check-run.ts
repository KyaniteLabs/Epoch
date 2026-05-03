import { getFeedbackHealthReport } from "../src/lib/feedback.js";
const health = getFeedbackHealthReport();
console.log(JSON.stringify(health, null, 2));
