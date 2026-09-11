/**
 * Compile-time guard: each module must structurally satisfy the API contract documented in
 * src/index.ts. A signature drift fails `tsc`, not just a runtime assertion.
 */
import { describe, expect, it } from 'vitest';
import type {
  EngineCellsApi,
  EngineRollupsApi,
  EngineStandardsApi,
  EngineTimeApi,
  EngineViewsApi,
} from '../src/index.js';
import * as engine from '../src/index.js';
import * as cells from '../src/cells.js';
import * as rollups from '../src/rollups.js';
import * as standards from '../src/standards.js';
import * as time from '../src/time.js';
import * as views from '../src/views.js';

const timeApi: EngineTimeApi = time;
const standardsApi: EngineStandardsApi = standards;
const cellsApi: EngineCellsApi = cells;
const rollupsApi: EngineRollupsApi = rollups;
const viewsApi: EngineViewsApi = views;

describe('public API contract', () => {
  it('exports every documented function from the package root', () => {
    const expected = [
      // time
      'getTzOffsetMs', 'utcToLocalParts', 'localToUtc', 'hourStartUtc', 'hourLabel',
      'localDateString', 'addDays', 'dayOfWeek', 'parseLocalTime', 'expandShiftInstance',
      'listShiftInstances', 'findCurrentShift', 'findCurrentOrMostRecentShift', 'expandBreaks',
      'rollingWindowColumns', 'hourColumns', 'nextLocalTime', 'inLocalWindow',
      'overlapWithIntervals',
      // standards
      'stdKey', 'computeStandard', 'resolveEffectiveStandard', 'buildStandardsLookup',
      'effectiveStdHr',
      // cells
      'computeHourCells', 'colorForPace', 'groupCells', 'computeDefectHourCells',
      // rollups
      'computeRollups', 'colorForEfficiency',
      // views
      'buildTvDashboard', 'buildShiftView', 'buildFloorView', 'buildOperatorDetail',
      'buildJobDetail', 'buildProductView',
    ];
    for (const name of expected) {
      expect(typeof (engine as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('binds the documented API shapes', () => {
    expect(typeof timeApi.hourStartUtc).toBe('function');
    expect(typeof standardsApi.computeStandard).toBe('function');
    expect(typeof cellsApi.computeHourCells).toBe('function');
    expect(typeof rollupsApi.computeRollups).toBe('function');
    expect(typeof viewsApi.buildTvDashboard).toBe('function');
  });
});
