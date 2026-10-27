import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { connectionHealth, type ConnectionHealth } from '@bp/domain';
import type { RequestContext } from '../authz/request-context';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import { readPrestashopSettings } from './prestashop-settings';

const WAITING_MS = 15 * 60 * 1000;
const FAILED_PRINT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PrestashopHealthRow = {
  storeId: string;
  storeName: string;
  connection: null | {
    id: string;
    status: string;
    keySet: boolean;
    lastSyncAt: string | null;
    lastErrorClass: string | null;
    lastErrorAt: string | null;
    pollIntervalSeconds: number | null;
    health: ConnectionHealth;
    failedImports: number;
    waitingImports: number;
    reviewRequired: number;
  };
};

type MappedPrinter = { printerName: string; paper: string; printerStatus: string } | null;

export type IntegrationHealthView = {
  now: string;
  prestashop: PrestashopHealthRow[];
  printing: {
    printNodeKeySet: boolean;
    printNodeKeySetAt: string | null;
    printers: {
      id: string;
      name: string;
      provider: string;
      status: string;
      lastSeenAt: string | null;
      locationName: string;
    }[];
    lastDiscoveryAt: string | null;
    mappings: {
      locationId: string;
      locationName: string;
      giftMessage: MappedPrinter;
      packingSlip: MappedPrinter;
    }[];
    failedLast24h: number;
  };
};

/**
 * Read-only health for the Integrations screen. Database reads only; no provider call.
 * It never returns keys, hints, credential ids, settings beyond the poll interval, or customer data.
 */
@Injectable()
export class IntegrationHealthService {
  private readonly tenants: TenantDb;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.tenants = new TenantDb(prisma.client);
  }

  async read(ctx: RequestContext): Promise<IntegrationHealthView> {
    const actor = requireActor(ctx);
    return this.tenants.run(
      { companyId: ctx.companyId, actor, correlationId: ctx.correlationId },
      async (tx) => {
        const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const now = clock[0]?.now ?? new Date();
        return {
          now: now.toISOString(),
          prestashop: await this.prestashop(tx, ctx.companyId, now),
          printing: await this.printing(tx, ctx.companyId, now),
        };
      },
    );
  }

  private async prestashop(tx: TenantTransaction, companyId: string, now: Date): Promise<PrestashopHealthRow[]> {
    const stores = await tx.store.findMany({
      where: { companyId, platform: 'prestashop', status: { not: 'archived' } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        connections: {
          where: { mode: 'live' },
          select: {
            id: true,
            status: true,
            settings: true,
            lastSyncAt: true,
            lastErrorClass: true,
            lastErrorAt: true,
            credential: { select: { provider: true, label: true, revokedAt: true } },
          },
        },
      },
    });
    const connectionIds = stores.flatMap((store) => store.connections.map((connection) => connection.id));
    const storeIds = stores.map((store) => store.id);
    const failed = await tx.integrationInbox.groupBy({
      by: ['connectionId'],
      where: { companyId, connectionId: { in: connectionIds }, status: 'failed' },
      _count: { _all: true },
    });
    const waiting = await tx.integrationInbox.groupBy({
      by: ['connectionId'],
      where: {
        companyId,
        connectionId: { in: connectionIds },
        status: 'received',
        receivedAt: { lt: new Date(now.getTime() - WAITING_MS) },
      },
      _count: { _all: true },
    });
    const review = await tx.salesOrder.groupBy({
      by: ['storeId'],
      where: { companyId, storeId: { in: storeIds }, fulfilmentStatus: 'review_required' },
      _count: { _all: true },
    });
    const failedBy = new Map(failed.map((row) => [row.connectionId, row._count._all]));
    const waitingBy = new Map(waiting.map((row) => [row.connectionId, row._count._all]));
    const reviewBy = new Map(review.map((row) => [row.storeId, row._count._all]));
    return stores.map((store) => {
      const connection = store.connections[0];
      if (!connection) {
        return { storeId: store.id, storeName: store.name, connection: null };
      }
      const settings = readPrestashopSettings(connection.settings);
      const pollIntervalSeconds = settings?.pollIntervalSeconds ?? null;
      const credential = connection.credential;
      return {
        storeId: store.id,
        storeName: store.name,
        connection: {
          id: connection.id,
          status: connection.status,
          keySet:
            credential !== null &&
            credential.revokedAt === null &&
            credential.provider === 'prestashop' &&
            credential.label === 'webservice_key',
          lastSyncAt: iso(connection.lastSyncAt),
          lastErrorClass: connection.lastErrorClass,
          lastErrorAt: iso(connection.lastErrorAt),
          pollIntervalSeconds,
          health: connectionHealth({
            status: connection.status,
            lastSyncAt: connection.lastSyncAt,
            lastErrorAt: connection.lastErrorAt,
            // Unreadable settings cannot be polled; the default interval only shapes the age rule.
            pollIntervalSeconds: pollIntervalSeconds ?? 180,
            now,
          }),
          failedImports: failedBy.get(connection.id) ?? 0,
          waitingImports: waitingBy.get(connection.id) ?? 0,
          reviewRequired: reviewBy.get(store.id) ?? 0,
        },
      };
    });
  }

  private async printing(
    tx: TenantTransaction,
    companyId: string,
    now: Date,
  ): Promise<IntegrationHealthView['printing']> {
    const key = await tx.integrationCredential.findFirst({
      where: { companyId, provider: 'printnode', label: 'api_key', revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    const printers = await tx.printer.findMany({
      where: { companyId, location: { archivedAt: null } },
      orderBy: [{ location: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        provider: true,
        status: true,
        lastSeenAt: true,
        location: { select: { name: true } },
      },
    });
    const locations = await tx.location.findMany({
      where: { companyId, archivedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    const mappings = await tx.printerMapping.findMany({
      where: {
        companyId,
        locationId: { in: locations.map((location) => location.id) },
        documentType: { in: ['gift_message', 'packing_slip'] },
      },
      select: {
        locationId: true,
        documentType: true,
        paperSize: true,
        printer: { select: { name: true, status: true } },
      },
    });
    const failedLast24h = await tx.printJob.count({
      where: {
        companyId,
        status: { in: ['failed', 'uncertain'] },
        createdAt: { gt: new Date(now.getTime() - FAILED_PRINT_WINDOW_MS) },
      },
    });
    const seen = printers
      .filter((printer) => printer.provider === 'printnode' && printer.lastSeenAt !== null)
      .map((printer) => printer.lastSeenAt?.getTime() ?? 0);
    const mapped = (locationId: string, documentType: 'gift_message' | 'packing_slip'): MappedPrinter => {
      const row = mappings.find((item) => item.locationId === locationId && item.documentType === documentType);
      return row ? { printerName: row.printer.name, paper: row.paperSize, printerStatus: row.printer.status } : null;
    };
    return {
      printNodeKeySet: key !== null,
      printNodeKeySetAt: key ? key.createdAt.toISOString() : null,
      printers: printers.map((printer) => ({
        id: printer.id,
        name: printer.name,
        provider: printer.provider,
        status: printer.status,
        lastSeenAt: iso(printer.lastSeenAt),
        locationName: printer.location.name,
      })),
      lastDiscoveryAt: seen.length > 0 ? new Date(Math.max(...seen)).toISOString() : null,
      mappings: locations.map((location) => ({
        locationId: location.id,
        locationName: location.name,
        giftMessage: mapped(location.id, 'gift_message'),
        packingSlip: mapped(location.id, 'packing_slip'),
      })),
      failedLast24h,
    };
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
