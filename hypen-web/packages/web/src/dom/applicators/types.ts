/**
 * Applicator Handler Type
 *
 * Separated to avoid circular dependencies between index.ts and individual handlers.
 */

export type ApplicatorHandler = (element: HTMLElement, value: any) => void;
