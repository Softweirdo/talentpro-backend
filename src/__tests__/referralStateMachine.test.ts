import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  APPLICATION_TO_REFERRAL,
  assertTransition,
  canTransition,
  isTerminal,
  TERMINAL_STATUSES,
} from '../services/referralStateMachine.js';
import { REFERRAL_STATUSES, type ReferralStatus } from '../utils/constants.js';

describe('referral state machine', () => {
  it('walks the happy path from share to payout', () => {
    const path: ReferralStatus[] = [
      'pending',
      'registered',
      'applied',
      'shortlisted',
      'hired',
      'tenure_running',
      'tenure_complete',
      'reward_approved',
      'rewarded',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('refuses to skip the tenure clock', () => {
    // The single most costly illegal move: paying out without serving tenure.
    expect(canTransition('hired', 'rewarded')).toBe(false);
    expect(canTransition('hired', 'tenure_complete')).toBe(false);
    expect(canTransition('applied', 'hired')).toBe(false);
  });

  it('refuses to run backwards', () => {
    expect(canTransition('hired', 'applied')).toBe(false);
    expect(canTransition('rewarded', 'tenure_running')).toBe(false);
    expect(canTransition('tenure_complete', 'hired')).toBe(false);
  });

  it('leaves terminal states with nowhere to go', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
    }
  });

  it('declares a transition table for every status', () => {
    for (const status of REFERRAL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('only ever names statuses that exist', () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(REFERRAL_STATUSES).toContain(target);
      }
    }
  });

  it('allows an admin to cancel from any live state', () => {
    for (const status of REFERRAL_STATUSES) {
      if (isTerminal(status)) continue;
      expect(ALLOWED_TRANSITIONS[status]).toContain('cancelled');
    }
  });

  it('throws a 409 with the allowed moves attached', () => {
    expect(() => assertTransition('rewarded', 'pending')).toThrowError(/cannot move/);
    try {
      assertTransition('applied', 'rewarded');
    } catch (err) {
      const e = err as { status: number; code: string; details: { allowed: string[] } };
      expect(e.status).toBe(409);
      expect(e.code).toBe('INVALID_TRANSITION');
      expect(e.details.allowed).toContain('shortlisted');
    }
  });

  it('treats a no-op transition as allowed', () => {
    expect(() => assertTransition('applied', 'applied')).not.toThrow();
  });

  it('maps an interview back to shortlisted, since the referral has no interview stage', () => {
    expect(APPLICATION_TO_REFERRAL.interview).toBe('shortlisted');
    expect(APPLICATION_TO_REFERRAL.hired).toBe('hired');
    expect(APPLICATION_TO_REFERRAL.withdrawn).toBeNull();
  });
});
