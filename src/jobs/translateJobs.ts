import { connectDb, disconnectDb } from '../config/db.js';
import { logger } from '../config/logger.js';
import { Job } from '../models/index.js';
import { translateJob } from '../modules/jobs/jobs.service.js';

/** Translates every live job that lacks a current Gujarati translation. */
async function main() {
  await connectDb();
  const jobs = await Job.find({ deletedAt: null }).lean();
  for (const job of jobs) await translateJob(job);
  const done = await Job.countDocuments({ deletedAt: null, gu: { $ne: null } });
  logger.info({ total: jobs.length, translated: done }, 'Job translation backfill complete');
  await disconnectDb();
}

main().catch((err) => {
  logger.error({ err }, 'Job translation backfill failed');
  process.exit(1);
});
