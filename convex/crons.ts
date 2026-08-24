import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("automation durable beat", { minutes: 1 }, internal.automation.cronBeat);
export default crons;
