import { getFeedbackHealthReport } from "../src/lib/feedback.js";

async function main() {
  const report = await getFeedbackHealthReport();
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
