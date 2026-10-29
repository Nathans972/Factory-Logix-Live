import { describe, expect, it } from 'vitest';
import { notificationToEvent, serializeEvent } from '../src/sse.js';

const NOW = 1_700_000_000_000;

describe('notificationToEvent', () => {
  it('maps fld_data_updated with epoch hours', () => {
    expect(notificationToEvent('fld_data_updated', JSON.stringify({ hours: [1, 2] }), NOW)).toEqual({
      type: 'data_updated',
      at: NOW,
      hours: [1, 2],
    });
  });

  it('accepts ISO timestamps in the hours array', () => {
    const event = notificationToEvent('fld_data_updated', '{"hours":["2024-05-01T11:00:00Z"]}', NOW);
    expect(event).toEqual({ type: 'data_updated', at: NOW, hours: [Date.parse('2024-05-01T11:00:00Z')] });
  });

  it('tolerates a missing or malformed payload', () => {
    expect(notificationToEvent('fld_data_updated', undefined, NOW)).toEqual({ type: 'data_updated', at: NOW, hours: [] });
    expect(notificationToEvent('fld_data_updated', 'not json', NOW)).toEqual({ type: 'data_updated', at: NOW, hours: [] });
  });

  it('maps fld_sync_health', () => {
    expect(notificationToEvent('fld_sync_health', '{"status":"degraded","delayed":true}', NOW)).toEqual({
      type: 'sync_health',
      at: NOW,
      status: 'degraded',
      delayed: true,
    });
  });

  it('maps fld_display_updated without the device token (/api/events needs no login)', () => {
    expect(notificationToEvent('fld_display_updated', '{"display_id":3,"device_token":"abc"}', NOW)).toStrictEqual({
      type: 'display_updated',
      at: NOW,
      display_id: 3,
    });
  });

  it('ignores unknown channels', () => {
    expect(notificationToEvent('something_else', '{}', NOW)).toBeNull();
  });
});

describe('serializeEvent', () => {
  it('writes the event name and JSON payload', () => {
    const frame = serializeEvent({ type: 'heartbeat', at: NOW });
    expect(frame).toBe(`event: heartbeat\ndata: {"type":"heartbeat","at":${NOW}}\n\n`);
  });
});
