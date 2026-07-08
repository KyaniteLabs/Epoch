import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PUBLIC_SURFACE } from "./public-surface.js";

const outputPath = "docs/superpowers/contracts/epoch-public-surface.json";

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(PUBLIC_SURFACE, null, 2)}\n`);

process.stdout.write(`Wrote ${outputPath}\n`);
