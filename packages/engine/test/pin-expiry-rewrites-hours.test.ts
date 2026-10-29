import { describe, expect, it } from 'vitest';
import type { UnitStep } from '@fld/shared';
import { computeHourCells } from '../src/cells.js';
import { engineSettings, findCell, ms, pin, step, stdLookup } from './helpers.js';

const settings = engineSettings();
const STD = stdLookup([['Z1', 'Weld', 30]]);

// OP2 batch-scans on JA/Weld: every 5 minutes from 08:00 to 12:00 they scan a board in and out
// within 30 seconds, so the 10-minute work rule makes them a visitor in every hour (spec 7.3).
const steps: UnitStep[] = [];
for (let t = ms('2025-06-10T08:00-04:00'); t < ms('2025-06-10T12:00-04:00'); t += 5 * 60_000) {
  steps.push(step('OP2', 'JA', 'Weld', t, t + 30_000));
}

// At 09:00 the supervisor pins OP2 force-eligible on JA "until 11:00".
const supervisorPin = pin({
  id: 5,
  operator_id: 'OP2',
  job_number: 'JA',
  mode: 'force_eligible',
  created_at: ms('2025-06-10T09:00-04:00'),
  expires_at: ms('2025-06-10T11:00-04:00'),
});

const H10 = '2025-06-10T10:00-04:00';

/** What the collector does after every poll: recompute the previous and the current hour. */
function pollAt(nowIso: string) {
  const now = ms(nowIso);
  const current = ms(nowIso.slice(0, 13) + ':00-04:00');
  return computeHourCells({
    steps,
    breaks: [],
    standards: STD,
    pins: [supervisorPin],
    settings,
    from_utc: current - 3_600_000,
    to_utc: current + 3_600_000,
    now,
  });
}

describe('a pin that covered a whole hour', () => {
  it('makes OP2 eligible in the 10:00 hour while it is in force (precondition)', () => {
    const cell = findCell(pollAt('2025-06-10T10:59').cells, { hour: H10, operator: 'OP2' })!;
    expect(cell.eligible).toBe(true);
    expect(cell.charged_minutes).toBeGreaterThan(50);
  });

  it('still applies to that hour when the next poll after it expires recomputes it', () => {
    // 11:05: the pin expired at 11:00; 10:00 is "the previous hour" and is recomputed as usual.
    const cell = findCell(pollAt('2025-06-10T11:05').cells, { hour: H10, operator: 'OP2' })!;
    expect(cell.eligible).toBe(true);
    expect(cell.color).not.toBe('visitor');
  });
});
