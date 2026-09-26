import { t } from '@/i18n';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Typed error for a slot lost to a concurrent booking (SQLSTATE 23P01) or no longer open. */
export class SlotTakenError extends AppError {
  constructor() {
    super(409, 'SLOT_TAKEN', t('errors.slotTaken'));
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(409, 'INVALID_TRANSITION', `Cannot change a ${from} appointment to ${to}`);
  }
}

/** 404 is used for both "missing" and "restricted" so a restriction is never revealed (PRD §8). */
export const notFound = () => new AppError(404, 'NOT_FOUND', t('errors.notFound'));
export const forbidden = (msg = t('errors.forbidden')) => new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string) => new AppError(400, 'BAD_REQUEST', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', t('errors.signInRequired'));
export const tooMany = (code: string, msg: string) => new AppError(429, code, msg);
