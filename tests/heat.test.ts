import { describe, it, expect } from 'vitest';
import {
  recencyScore,
  frequencyScore,
  connectivityScore,
  calculateHeat,
} from '../src/engine/heat.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('recencyScore', () => {
  it('returns 1.0 for today', () => {
    expect(recencyScore(daysAgo(0))).toBe(1.0);
  });
  it('steps down across the week / month / quarter buckets', () => {
    expect(recencyScore(daysAgo(3))).toBe(0.8);
    expect(recencyScore(daysAgo(15))).toBe(0.5);
    expect(recencyScore(daysAgo(60))).toBe(0.2);
    expect(recencyScore(daysAgo(200))).toBe(0.05);
  });
});

describe('frequencyScore', () => {
  it('normalizes against the max and caps at 1.0', () => {
    expect(frequencyScore(5, 10)).toBe(0.5);
    expect(frequencyScore(20, 10)).toBe(1.0);
  });
  it('returns 0 when max is 0', () => {
    expect(frequencyScore(3, 0)).toBe(0);
  });
});

describe('connectivityScore', () => {
  it('normalizes and caps at 1.0', () => {
    expect(connectivityScore(2, 4)).toBe(0.5);
    expect(connectivityScore(8, 4)).toBe(1.0);
  });
  it('returns 0 when max is 0', () => {
    expect(connectivityScore(1, 0)).toBe(0);
  });
});

describe('calculateHeat', () => {
  it('combines the three weighted components', () => {
    // freq=1.0*0.35 + rec=1.0*0.40 + conn=1.0*0.25 = 1.0
    expect(calculateHeat(10, daysAgo(0), 5, 10, 5)).toBe(1.0);
  });
  it('weights recency the heaviest', () => {
    // Only recency contributes: 1.0 * 0.40
    expect(calculateHeat(0, daysAgo(0), 0, 10, 5)).toBe(0.4);
  });
  it('rounds to 3 decimals', () => {
    const h = calculateHeat(1, daysAgo(3), 1, 3, 3);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBe(Math.round(h * 1000) / 1000);
  });
});
