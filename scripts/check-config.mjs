import { configurationReport } from "../lib/server/config.js";

const report = configurationReport();
if (report.ready) {
  console.log("Marketplace backend configuration is ready for provider staging.");
} else {
  console.error("Marketplace backend configuration is incomplete:");
  for (const item of report.missing) console.error(`- ${item}`);
  process.exitCode = 1;
}
