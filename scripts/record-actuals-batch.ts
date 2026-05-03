import { recordActual } from "../src/lib/feedback.js";

// Sprint confidence feature: 0.4h actual
const r1 = recordActual("f9e97f4e-1c5a-475d-afe9-776e17048f80", 0.4, "Sprint confidence rating feature - type + impl + tests");
console.log(`pert_estimate actual: ${r1}`);
