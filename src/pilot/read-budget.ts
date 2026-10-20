import { LIMITS } from './model.js';

export function readBudget(starts: readonly string[], now: number) {
  const active = starts.map(Date.parse).filter(t => t > now - 3600000).sort((a, b) => a - b);
  const remaining = Math.max(0, LIMITS.githubReadsPerHour - active.length);
  return { limit: LIMITS.githubReadsPerHour, used: active.length, remaining,
    nextAvailableAt: remaining ? null : new Date(Math.max(now + 1, active[active.length - LIMITS.githubReadsPerHour] + 3600000)).toISOString() };
}
