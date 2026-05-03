import { updateReferenceDatabase } from "../src/lib/self-improve.js";

updateReferenceDatabase()
  .then(() => console.log("Self-improvement complete."))
  .catch((e: unknown) => { console.error(e); process.exit(1); });
