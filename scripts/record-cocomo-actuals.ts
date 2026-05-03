import { recordActual } from "../src/lib/feedback.js";

// COCOMO speedup feature: 0.3h actual
const r1 = recordActual("bf6ebcc0-1ea4-4ff9-ac21-63aab9b500e4", 0.3, "COCOMO AI speedup feature");
console.log(`cocomo actual: ${r1}`);

// Critical path: 0.3h actual (matches 18h estimate at sprint scale, 0.3h dev time)
const r2 = recordActual("a74512e0-e15b-4b10-a5d5-117699df0581", 0.3, "Critical path for COCOMO speedup feature");
console.log(`cp actual: ${r2}`);

// Monte Carlo: 0.3h actual
const r3 = recordActual("d56f66a6-3f31-48b4-9f79-e56ad1f29860", 0.3, "Monte Carlo for COCOMO speedup feature");
console.log(`mc actual: ${r3}`);
