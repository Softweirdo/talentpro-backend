import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { env, isProd } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter, adminAuthRouter } from './modules/auth/auth.routes.js';
import { meRouter, adminEmployeesRouter } from './modules/employees/employees.routes.js';
import { jobsRouter, adminJobsRouter } from './modules/jobs/jobs.routes.js';
import {
  applicationsRouter,
  adminApplicationsRouter,
} from './modules/applications/applications.routes.js';
import { referralsRouter, adminReferralsRouter } from './modules/referrals/referrals.routes.js';
import { rewardsRouter, adminRewardsRouter } from './modules/rewards/rewards.routes.js';
import {
  publicCategoriesRouter,
  adminCategoriesRouter,
} from './modules/categories/categories.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { adminAnalyticsRouter } from './modules/analytics/analytics.routes.js';
import { adminExportsRouter } from './modules/exports/exports.routes.js';
import { adminSettingsRouter } from './modules/settings/settings.routes.js';
import { getSettings } from './models/index.js';
import { requireAdmin } from './middleware/auth.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // helmet defaults CORP to `same-origin`. That does not affect the panel's
  // fetch() calls — CORS governs those — but it does block embedding a
  // response from another site, e.g. an /exports download opened from the
  // panel. This API is cross-origin by design, so opt out.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Every response varies by Origin, including the ones CORS rejects, so a
  // cache in front of the API cannot serve one origin's answer to another.
  app.use((_req, res, next) => {
    res.vary('Origin');
    next();
  });
  // Mounted ahead of every router: the preflight is answered here, so a
  // downstream rate limiter or auth guard can never turn an OPTIONS into a
  // 401/429, which reaches the browser as an opaque "Network Error".
  app.use(cors(corsOptions));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.get('/health', (_req, res) => {
    const state = mongoose.connection.readyState;
    res.status(state === 1 ? 200 : 503).json({
      status: state === 1 ? 'ok' : 'degraded',
      db: ['disconnected', 'connected', 'connecting', 'disconnecting'][state] ?? 'unknown',
      env: env.NODE_ENV,
      uptime: Math.round(process.uptime()),
    });
  });

  const api = express.Router();

  // ── Public ───────────────────────────────────────────────────────────────
  api.use('/auth', authRouter);
  api.use('/categories', publicCategoriesRouter);

  /** App bootstrap: the defaults the mobile client needs before signing in. */
  api.get('/config', async (_req, res, next) => {
    try {
      const settings = await getSettings();
      res.json({
        data: {
          defaultTenureMonths: settings.defaultTenureMonths,
          defaultRewardAmount: settings.defaultRewardAmount,
          languages: ['en', 'gu'],
          minAppVersion: '1.0.0',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Mobile (employee token) ──────────────────────────────────────────────
  api.use('/me', meRouter);
  api.use('/jobs', jobsRouter);
  api.use('/applications', applicationsRouter);
  api.use('/referrals', referralsRouter);
  api.use('/rewards', rewardsRouter);
  api.use('/notifications', notificationsRouter);

  // ── Admin (admin token — a separate signing secret, not just a claim) ─────
  const admin = express.Router();
  admin.use('/auth', adminAuthRouter);
  admin.use('/analytics', adminAnalyticsRouter);
  admin.use('/jobs', adminJobsRouter);
  admin.use('/applications', adminApplicationsRouter);
  admin.use('/referrals', adminReferralsRouter);
  admin.use('/rewards', adminRewardsRouter);
  admin.use('/employees', adminEmployeesRouter);
  admin.use('/categories', adminCategoriesRouter);
  admin.use('/exports', adminExportsRouter);
  admin.use('/settings', adminSettingsRouter);

  admin.get('/me', requireAdmin, (req, res) => {
    res.json({ data: req.admin });
  });

  api.use('/admin', admin);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (!isProd) logger.info('app: routes mounted under /api/v1');

  return app;
}
