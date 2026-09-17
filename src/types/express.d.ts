import type { AdminRole } from '../utils/constants.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireEmployee` — a verified employee-audience access token. */
      employee?: {
        id: string;
        mobile: string;
        tokenVersion: number;
      };
      /** Set by `requireAdmin` — a verified admin-audience access token. */
      admin?: {
        id: string;
        email: string;
        role: AdminRole;
        tokenVersion: number;
      };
      /** Set by `requireRegistrationToken` — scoped to signup completion only. */
      registration?: {
        mobile: string;
      };
    }
  }
}

export {};
