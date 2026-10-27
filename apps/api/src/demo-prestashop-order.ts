import { TenantDb } from '@bp/db';
import { type PrismaService } from './database/prisma.service';
import { PRESTASHOP_MILESTONE_EXTERNAL_ID, PRESTASHOP_MILESTONE_NUMBER } from './demo-import-args';

const PRESTASHOP_STORE = 'Nutbox Demo PrestaShop';
export const PRESTASHOP_GIFT = 'Δοκιμαστικό μήνυμα.\nΜόνο για τον έλεγχο απομόνωσης.';

/**
 * Inserts the milestone PrestaShop order once. The inbox rejects that provider.
 * The line relation is `(companyId, orderId)`, so the nested create omits `companyId`.
 */
export async function ensurePrestashopOrder(prisma: PrismaService, companyId: string): Promise<void> {
  await new TenantDb(prisma.client).run(
    { companyId, actor: 'demo-import', correlationId: 'demo-import-prestashop' },
    async (tx) => {
      const existing = await tx.salesOrder.findFirst({
        where: { companyId, externalId: PRESTASHOP_MILESTONE_EXTERNAL_ID },
        select: { id: true },
      });
      if (existing) {
        return;
      }
      const store = await tx.store.findFirst({
        where: { companyId, name: PRESTASHOP_STORE, platform: 'prestashop' },
      });
      if (!store) {
        throw new Error(`store ${PRESTASHOP_STORE} was not found`);
      }
      const connection = await tx.storeConnection.findFirst({
        where: { companyId, storeId: store.id, status: 'active', mode: 'mock' },
      });
      if (!connection) {
        throw new Error(`mock connection for ${PRESTASHOP_STORE} was not found`);
      }
      await tx.salesOrder.create({
        data: {
          companyId,
          storeId: store.id,
          connectionId: connection.id,
          externalId: PRESTASHOP_MILESTONE_EXTERNAL_ID,
          externalNumber: PRESTASHOP_MILESTONE_NUMBER,
          sourcePlatform: 'prestashop',
          sourceStatus: { displayFulfillmentStatus: null, cancelledAt: null },
          sourceCreatedAt: new Date('2026-03-02T10:00:00.000Z'),
          sourceUpdatedAt: new Date('2026-03-02T10:00:00.000Z'),
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '12.00',
          shippingTotal: '0.00',
          taxTotal: '2.28',
          total: '14.28',
          version: 1,
          giftMessage: PRESTASHOP_GIFT,
          customer: {
            displayName: 'Presta Milestone (fictional)',
            email: 'presta.milestone@example.test',
            phone: null,
            id: null,
          },
          lines: {
            create: [
              {
                title: 'Fictional PrestaShop tin',
                quantity: '1.0000',
                unitPrice: '12.0000',
                total: '12.00',
              },
            ],
          },
        },
      });
    },
  );
}
