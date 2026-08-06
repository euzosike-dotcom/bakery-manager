import { NotFoundException } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return { customerId: 'customer-1', activityType: 'CALL', notes: 'Discussed reorder', ...overrides };
}

describe('ActivitiesService.createActivity', () => {
  it('404s when the customer does not exist', async () => {
    const tx = {
      activity: { findUnique: jest.fn().mockResolvedValue(null) },
      customer: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new ActivitiesService(makePrisma(tx));

    await expect(service.createActivity(TENANT, baseDto(), { createdOffline: false })).rejects.toThrow(NotFoundException);
  });

  it('is idempotent: replaying an already-applied clientEventId returns the original result', async () => {
    const tx = {
      activity: { findUnique: jest.fn().mockResolvedValue({ activityId: 'existing-activity' }) },
      customer: { findUnique: jest.fn() },
    };
    const service = new ActivitiesService(makePrisma(tx));

    const result = await service.createActivity(TENANT, baseDto({ clientEventId: 'replayed-event' }), {
      createdOffline: false,
    });

    expect(result).toEqual({
      clientEventId: 'replayed-event',
      status: 'ACKED',
      serverEntityId: 'existing-activity',
      message: 'Already applied (idempotent replay)',
    });
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
  });
});

describe('ActivitiesService.findAll — BigInt syncSeq serialization', () => {
  // Regression test for a real bug fixed during this platform's build (see
  // docs/RUNBOOK.md "Vertical Slice #4" §6): Prisma maps the bigserial
  // sync_seq column to a native JS BigInt, which JSON.stringify (and
  // therefore Nest's default response serializer) throws on at
  // response-send time, not at compile time — a type checker cannot catch
  // it. findAll must convert syncSeq to a string before returning.
  it('converts syncSeq from BigInt to string so the response is JSON-serializable', async () => {
    const tx = {
      activity: {
        findMany: jest.fn().mockResolvedValue([
          { activityId: 'activity-1', syncSeq: 42n },
          { activityId: 'activity-2', syncSeq: null },
        ]),
      },
    };
    const service = new ActivitiesService(makePrisma(tx));

    const result = await service.findAll(TENANT);

    expect(result[0].syncSeq).toBe('42');
    expect(typeof result[0].syncSeq).toBe('string');
    expect(result[1].syncSeq).toBeNull();
    // The real failure mode this guards against: JSON.stringify throws on
    // a raw BigInt ("Do not know how to serialize a BigInt").
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
