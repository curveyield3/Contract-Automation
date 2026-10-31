#!/usr/bin/env node
import { runJob } from './run-job.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const jobId = argument('--job-id') ?? process.env.PREFLIGHTSIM_JOB_ID;
const apiUrl = process.env.PREFLIGHTSIM_API_URL;
const runnerApiKey = process.env.PREFLIGHTSIM_RUNNER_API_KEY;

if (!jobId || !apiUrl || !runnerApiKey) {
  console.error('Required: --job-id, PREFLIGHTSIM_API_URL, PREFLIGHTSIM_RUNNER_API_KEY');
  process.exit(2);
}

const timeoutMinutes = Number(process.env.PREFLIGHTSIM_TIMEOUT_MINUTES ?? '35');
const timeout = setTimeout(() => {
  console.error(`Runner exceeded ${timeoutMinutes} minutes`);
  process.exit(124);
}, timeoutMinutes * 60 * 1000);
timeout.unref();

try {
  const result = await runJob({ jobId, apiUrl, runnerApiKey });
  console.log(JSON.stringify({ jobId, status: result.status }));
} catch (cause) {
  console.error(cause);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
