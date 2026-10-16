import { describe, expect, it } from 'vitest';
import { parsePeriodUsageBody, usageFromUsageFile } from './cursor-usage';

describe('cursor usage', () => {
  it('parsePeriodUsageBody', () => {
    const r = parsePeriodUsageBody(
      {
        billingCycleEnd: '1794764816000',
        planUsage: { totalPercentUsed: 7, autoPercentUsed: 8, apiPercentUsed: 0 },
      },
      1_000,
    );
    expect(r?.usage).toMatchObject({
      source: 'cursor',
      fetchedAt: 1_000,
      fiveHour: { utilization: 8, resetsAt: 1794764816000 },
      sevenDay: { utilization: 7, resetsAt: 1794764816000 },
    });
    expect(r?.file.apiPercent).toBe(0);
  });

  it('usageFromUsageFile', () => {
    expect(
      usageFromUsageFile({
        accountId: '.cursor',
        fetchedAt: 2_000,
        billingCycleEndMs: 1794764816000,
        includedPercent: 9,
        autoPercent: 11,
        apiPercent: 0,
      }),
    ).toMatchObject({ source: 'cursor', sevenDay: { utilization: 9 } });
  });
});
