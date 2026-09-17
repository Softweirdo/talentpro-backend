import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Parses and *replaces* the request parts with their validated output, so
 * handlers work with coerced, typed values rather than raw strings.
 *
 * Express 5 makes `req.query` a getter-only property, so the parsed query is
 * stashed on `res.locals.query` and read back via `validatedQuery()`.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) res.locals.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };

export const validatedQuery = <T>(res: { locals: Record<string, unknown> }): T =>
  res.locals.query as T;
