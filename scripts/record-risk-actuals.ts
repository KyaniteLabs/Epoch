import { recordActual } from "../src/lib/feedback.js";

const r1 = recordActual("7b6f25da-581f-43dd-9cfd-bbb8accac573", 0.35, "Schedule risk task-type breakdown - refactor");
console.log(`pert_refactor: ${r1}`);

const r2 = recordActual("616e7871-87c8-4513-918c-545ece249946", 0.35, "Schedule risk for refactor task-type breakdown");
console.log(`sr: ${r2}`);

const r3 = recordActual("0ce6017c-c131-4c64-a01f-0fac6d286248", 0.35, "PERT migration data point");
console.log(`pert_migration: ${r3}`);

const r4 = recordActual("18bda700-f226-4403-b103-6f161c150706", 0.35, "PERT design data point");
console.log(`pert_design: ${r4}`);
