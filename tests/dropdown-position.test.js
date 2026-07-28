import { describe, expect, it } from 'vitest';
import { calculateDropdownPosition } from '../src/dropdown-position.js';

describe('calculateDropdownPosition', () => {
  it('opens below when there is enough room', () => {
    const result = calculateDropdownPosition(
      { top: 100, bottom: 144, left: 20, width: 280 },
      { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
    );

    expect(result.placement).toBe('below');
    expect(result.top).toBe(148);
    expect(result.listMaxHeight).toBe(256);
  });

  it('flips above a trigger near the bottom of a phone viewport', () => {
    const result = calculateDropdownPosition(
      { top: 730, bottom: 774, left: 20, width: 280 },
      { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
    );

    expect(result.placement).toBe('above');
    expect(result.bottom).toBeLessThanOrEqual(836);
    expect(result.listMaxHeight).toBeGreaterThanOrEqual(120);
  });

  it('keeps the dropdown inside a shifted visual viewport', () => {
    const result = calculateDropdownPosition(
      { top: 410, bottom: 454, left: 350, width: 280 },
      { width: 390, height: 400, offsetTop: 200, offsetLeft: 10 },
    );

    expect(result.left).toBeGreaterThanOrEqual(18);
    expect(result.right).toBeLessThanOrEqual(392);
    expect(result.top).toBeGreaterThanOrEqual(208);
    expect(result.bottom).toBeLessThanOrEqual(592);
  });
});
