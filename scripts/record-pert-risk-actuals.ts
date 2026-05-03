import { recordActual } from "../src/lib/feedback.js";

// PERT estimate actual (0.5h estimate, 0.35h actual)
const r1 = recordActual("6b7737cf-54ae-4935-ae1f-dd6f61c86a65", 0.35, "PERT risk level feature - type + impl + tests");
console.log(`pert actual: ${r1}`);

// Sprint forecast actual (42h estimate, 35h actual — feature work sprint)
const r2 = recordActual("377c3050-f51e-4581-bff2-d64c71b09154", 35, "Sprint for PERT risk feature work");
console.log(`sprint actual: ${r2}`);

// Token time bridge actual (3min estimate, 2.5min actual)
const r3 = recordActual("705a5c43-9a40-4a9e-93c0-7a32c38c1cb4", 2.5 / 60, "Token time for PERT risk feature");
console.log(`ttb actual: ${r3}`);
