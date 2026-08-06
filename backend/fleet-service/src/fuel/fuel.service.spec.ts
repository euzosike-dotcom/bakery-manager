import { NotFoundException } from '@nestjs/common';
import { KafkaProducerService } from '@metrock/backend-common';
import { FuelService } from './fuel.service';
import { PrismaService } from '../common/prisma.service';

const TENANT = 'tenant-1';
const VEHICLE = { vehicleId: 'veh-1', vehicleClass: 'TRUCK_5T' };
const ACTIVE_TRIP = { tripLogId: 'trip-1', tripStatus: 'COMPLETED', startMileage: 1000, endMileage: 1100 }; // 100km delta
const NORM = { litresPerKm: 0.3, tolerancePercent: 10 }; // expected 30L, tolerance 3L

function makePrisma(tx: Record<string, unknown>): PrismaService {
  return { forTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
}

function makeKafka(): KafkaProducerService {
  return { publish: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService;
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    fuelRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    vehicle: { findUnique: jest.fn().mockResolvedValue(VEHICLE) },
    tripLog: { findUnique: jest.fn().mockResolvedValue(ACTIVE_TRIP) },
    vehicleClassFuelNorm: { findUnique: jest.fn().mockResolvedValue(NORM) },
    maintenanceRequest: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return { vehicleId: 'veh-1', tripLogId: 'trip-1', litres: 30, fuelCost: 15000, ...overrides };
}

describe('FuelService.createFuelRecord — variance tolerance', () => {
  it('does not open a maintenance investigation when actual litres are within tolerance', async () => {
    const tx = makeTx();
    const service = new FuelService(makePrisma(tx), makeKafka());

    const result = await service.createFuelRecord(TENANT, baseDto({ litres: 30 }), { createdOffline: false }); // expected 30L, exact match

    expect(tx.maintenanceRequest.create).not.toHaveBeenCalled();
    expect(result.message).not.toMatch(/variance/i);
  });

  it('opens a maintenance investigation when actual litres fall outside the tolerance band', async () => {
    // expected 30L, tolerance 3L (10%) -> anything outside [27, 33] should trigger.
    const tx = makeTx();
    const service = new FuelService(makePrisma(tx), makeKafka());

    const result = await service.createFuelRecord(TENANT, baseDto({ litres: 40 }), { createdOffline: false });

    expect(tx.maintenanceRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'FUEL_VARIANCE_INVESTIGATION' }) }),
    );
    expect(result.message).toMatch(/variance outside tolerance/i);
  });

  it('accepts and posts a fuel record against a CANCELLED trip, flagging orphanedTripReference instead of computing variance', async () => {
    const tx = makeTx({ tripLog: { findUnique: jest.fn().mockResolvedValue({ ...ACTIVE_TRIP, tripStatus: 'CANCELLED' }) } });
    const service = new FuelService(makePrisma(tx), makeKafka());

    const result = await service.createFuelRecord(TENANT, baseDto({ litres: 999 }), { createdOffline: false });

    expect(result.status).toBe('ACKED');
    expect(tx.maintenanceRequest.create).not.toHaveBeenCalled();
    expect(result.message).toMatch(/cancelled.*flagged for review/i);
  });

  it('404s when the vehicle does not exist', async () => {
    const tx = makeTx({ vehicle: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = new FuelService(makePrisma(tx), makeKafka());

    await expect(service.createFuelRecord(TENANT, baseDto(), { createdOffline: false })).rejects.toThrow(NotFoundException);
  });

  it('is idempotent: replaying an already-applied clientEventId returns the original result', async () => {
    const tx = makeTx({
      fuelRecord: { findUnique: jest.fn().mockResolvedValue({ fuelRecordId: 'existing-fuel-record' }) },
    });
    const kafka = makeKafka();
    const service = new FuelService(makePrisma(tx), kafka);

    const result = await service.createFuelRecord(TENANT, baseDto({ clientEventId: 'replayed-event' }), {
      createdOffline: false,
    });

    expect(result).toEqual({
      clientEventId: 'replayed-event',
      status: 'ACKED',
      serverEntityId: 'existing-fuel-record',
      message: 'Already applied (idempotent replay)',
    });
    expect(kafka.publish).not.toHaveBeenCalled();
  });
});
