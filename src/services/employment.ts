import { Types } from 'mongoose';
import { Employee, recordAudit, type EmployeeDoc, type EmploymentStint } from '../models/index.js';
import { addDays, startOfMonthIst, toCivilDate } from '../utils/dates.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import type { ActorType, EmploymentSource } from '../utils/constants.js';

export interface SetOrgInput {
  company: string | null;
  effectiveFrom?: Date;
  source?: EmploymentSource;
  jobId?: Types.ObjectId | string | null;
  actorType: ActorType;
  actorId?: Types.ObjectId | string | null;
  ip?: string | null;
  note?: string | null;
}

export interface SetOrgResult {
  employee: EmployeeDoc;
  changed: boolean;
  archived: { company: string; from: Date; to: Date } | null;
}

const sameCompany = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

const openStint = (employee: EmployeeDoc): EmploymentStint | undefined =>
  employee.employmentHistory.find((s) => s.to === null);

/**
 * The only writer of `currentOrganization` anywhere in the system.
 *
 * `employmentHistory` is the source of truth; `currentOrganization` is a cache
 * of whichever stint is still open. Both live in one document, so this is a
 * single atomic update — there is no window in which they can disagree.
 *
 * Called from three places that the prototype implements separately: the
 * inline table edit, the slide-out panel, and the hire event.
 */
export async function setCurrentOrganization(
  employeeId: Types.ObjectId | string,
  input: SetOrgInput,
): Promise<SetOrgResult> {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

  const company = input.company?.trim() || null;
  const current = openStint(employee);
  const before = {
    company: employee.currentOrganization,
    from: current?.from ?? null,
  };

  // Re-saving the same company must not create a duplicate stint. The
  // prototype's own panel logic only archives when the value actually changed.
  if (sameCompany(current?.company ?? null, company)) {
    return { employee, changed: false, archived: null };
  }

  // Month precision, matching the MM/YYYY inputs and "Jan 2024 — Mar 2025" display.
  const effectiveFrom = input.effectiveFrom ? toCivilDate(input.effectiveFrom) : startOfMonthIst();

  if (current && effectiveFrom.getTime() < current.from.getTime()) {
    throw unprocessable(
      'EFFECTIVE_DATE_BEFORE_CURRENT_START',
      'The new start date cannot be earlier than the start of the current job',
    );
  }

  let archived: SetOrgResult['archived'] = null;

  if (current) {
    // End the day before the new stint begins, so periods never overlap.
    // Clamped so a same-month switch stays a valid (zero-length) stint.
    const to = new Date(Math.max(addDays(effectiveFrom, -1).getTime(), current.from.getTime()));
    current.to = to;
    archived = { company: current.company, from: current.from, to };
  }

  if (company) {
    employee.employmentHistory.push({
      _id: new Types.ObjectId(),
      company,
      from: effectiveFrom,
      to: null,
      source: input.source ?? 'admin',
      jobId: input.jobId ? new Types.ObjectId(String(input.jobId)) : null,
      createdByAdminId:
        input.actorType === 'admin' && input.actorId
          ? new Types.ObjectId(String(input.actorId))
          : null,
      note: input.note ?? null,
    });
  }

  // Recomputed from the history array, never taken from the request input —
  // that is what keeps the cache honest.
  employee.currentOrganization = openStint(employee)?.company ?? null;
  await employee.save();

  await recordAudit({
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: company ? 'employee.current_org.set' : 'employee.current_org.clear',
    entityType: 'employee',
    entityId: employee._id,
    before,
    after: { company: employee.currentOrganization, from: company ? effectiveFrom : null },
    ip: input.ip ?? null,
  });

  return { employee, changed: true, archived };
}

/** Clearing is the same write with no new stint — the employee becomes "Currently Unemployed". */
export const clearCurrentOrganization = (
  employeeId: Types.ObjectId | string,
  input: Omit<SetOrgInput, 'company'>,
): Promise<SetOrgResult> => setCurrentOrganization(employeeId, { ...input, company: null });

export interface HistoryEntryInput {
  company: string;
  from: Date;
  to: Date;
  note?: string | null;
}

/**
 * Manual history CRUD operates only on *closed* stints. Editing the open one
 * goes through `setCurrentOrganization` so the cache-sync logic stays in one
 * place rather than being duplicated here.
 */
export async function addHistoryEntry(
  employeeId: Types.ObjectId | string,
  input: HistoryEntryInput,
  actor: { actorType: ActorType; actorId?: Types.ObjectId | string | null; ip?: string | null },
): Promise<EmployeeDoc> {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

  const from = toCivilDate(input.from);
  const to = toCivilDate(input.to);
  if (to.getTime() < from.getTime()) {
    throw unprocessable('INVALID_PERIOD', 'The end date must be on or after the start date');
  }

  employee.employmentHistory.push({
    _id: new Types.ObjectId(),
    company: input.company.trim(),
    from,
    to,
    source: 'admin',
    jobId: null,
    createdByAdminId: actor.actorId ? new Types.ObjectId(String(actor.actorId)) : null,
    note: input.note ?? null,
  });

  employee.employmentHistory.sort((a, b) => b.from.getTime() - a.from.getTime());
  await employee.save();

  await recordAudit({
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    action: 'employee.history.add',
    entityType: 'employee',
    entityId: employee._id,
    after: { company: input.company, from, to },
    ip: actor.ip ?? null,
  });

  return employee;
}

export async function updateHistoryEntry(
  employeeId: Types.ObjectId | string,
  entryId: string,
  patch: Partial<HistoryEntryInput>,
  actor: { actorType: ActorType; actorId?: Types.ObjectId | string | null; ip?: string | null },
): Promise<EmployeeDoc> {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

  const entry = employee.employmentHistory.find((s) => String(s._id) === entryId);
  if (!entry) throw notFound('HISTORY_ENTRY_NOT_FOUND', 'Employment history entry not found');
  if (entry.to === null) {
    throw conflict(
      'USE_CURRENT_ORG_ENDPOINT',
      'This is the current job. Update it through the current-organization endpoint.',
    );
  }

  const before = { company: entry.company, from: entry.from, to: entry.to };

  if (patch.company !== undefined) entry.company = patch.company.trim();
  if (patch.from !== undefined) entry.from = toCivilDate(patch.from);
  if (patch.to !== undefined) entry.to = toCivilDate(patch.to);
  if (patch.note !== undefined) entry.note = patch.note;

  if (entry.to && entry.to.getTime() < entry.from.getTime()) {
    throw unprocessable('INVALID_PERIOD', 'The end date must be on or after the start date');
  }

  employee.markModified('employmentHistory');
  await employee.save();

  await recordAudit({
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    action: 'employee.history.update',
    entityType: 'employee',
    entityId: employee._id,
    before,
    after: { company: entry.company, from: entry.from, to: entry.to },
    ip: actor.ip ?? null,
  });

  return employee;
}

export async function deleteHistoryEntry(
  employeeId: Types.ObjectId | string,
  entryId: string,
  actor: { actorType: ActorType; actorId?: Types.ObjectId | string | null; ip?: string | null },
): Promise<EmployeeDoc> {
  const employee = await Employee.findOne({ _id: employeeId, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

  const entry = employee.employmentHistory.find((s) => String(s._id) === entryId);
  if (!entry) throw notFound('HISTORY_ENTRY_NOT_FOUND', 'Employment history entry not found');
  if (entry.to === null) {
    throw conflict(
      'USE_CURRENT_ORG_ENDPOINT',
      'This is the current job. Clear it through the current-organization endpoint.',
    );
  }

  employee.employmentHistory = employee.employmentHistory.filter(
    (s) => String(s._id) !== entryId,
  ) as typeof employee.employmentHistory;
  await employee.save();

  await recordAudit({
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    action: 'employee.history.delete',
    entityType: 'employee',
    entityId: employee._id,
    before: { company: entry.company, from: entry.from, to: entry.to },
    ip: actor.ip ?? null,
  });

  return employee;
}

/**
 * Applied when an application is marked hired.
 *
 * Deliberately a *soft* default: if the employee already has an open stint at a
 * different company, it is flagged rather than overwritten. Silently rewriting
 * someone's employment record from a pipeline drag would also corrupt the
 * referral tenure that depends on it.
 */
export async function applyHireToEmployment(params: {
  employeeId: Types.ObjectId | string;
  company: string;
  jobId: Types.ObjectId | string;
  hiredOn: Date;
  actorId?: Types.ObjectId | string | null;
}): Promise<{ applied: boolean; conflictWith: string | null }> {
  const employee = await Employee.findOne({ _id: params.employeeId, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

  const current = openStint(employee);
  if (current && !sameCompany(current.company, params.company)) {
    await recordAudit({
      actorType: 'system',
      actorId: params.actorId ?? null,
      action: 'employee.hire.employment_conflict',
      entityType: 'employee',
      entityId: employee._id,
      before: { company: current.company },
      after: { company: params.company, jobId: String(params.jobId) },
    });
    return { applied: false, conflictWith: current.company };
  }

  await setCurrentOrganization(employee._id, {
    company: params.company,
    effectiveFrom: params.hiredOn,
    source: 'hire_event',
    jobId: params.jobId,
    actorType: 'system',
    actorId: params.actorId ?? null,
  });

  return { applied: true, conflictWith: null };
}
