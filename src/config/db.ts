import mongoose from 'mongoose';
import { env, isProd } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
if (!isProd) mongoose.set('debug', false);

let connected = false;

export async function connectDb(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (connected) return mongoose;

  mongoose.connection.on('connected', () => logger.info('mongo: connected'));
  mongoose.connection.on('disconnected', () => logger.warn('mongo: disconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongo: connection error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 20,
    retryWrites: true,
  });

  connected = true;
  logger.info({ db: mongoose.connection.name }, 'mongo: ready');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

/**
 * Atlas and replica sets support transactions; a standalone mongod does not.
 * Probed once so services can degrade to sequential writes locally instead of
 * throwing `Transaction numbers are only allowed on a replica set member`.
 */
let txnSupport: boolean | null = null;

export async function supportsTransactions(): Promise<boolean> {
  if (txnSupport !== null) return txnSupport;
  try {
    const admin = mongoose.connection.db?.admin();
    const info = await admin?.command({ hello: 1 });
    txnSupport = Boolean(info?.setName || info?.msg === 'isdbgrid');
  } catch {
    txnSupport = false;
  }
  logger.info({ transactions: txnSupport }, 'mongo: transaction support');
  return txnSupport;
}

/**
 * Runs `fn` inside a transaction where the deployment supports one, and plainly
 * otherwise. Callers must pass the session through to every write so the
 * transactional path is actually atomic.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (!(await supportsTransactions())) return fn(undefined);

  const session = await mongoose.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}
