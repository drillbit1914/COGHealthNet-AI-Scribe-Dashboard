export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
/** 404 is used for both "missing" and "restricted" so a restriction is never revealed (PRD §8). */
export const notFound = (what = 'Not found') => new AppError(404, 'NOT_FOUND', what);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string) => new AppError(400, 'BAD_REQUEST', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Sign in required');
