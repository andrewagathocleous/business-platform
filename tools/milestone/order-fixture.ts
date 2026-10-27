/** Fictional id for one milestone import. A later run uses a later timestamp. */
export function milestoneExternalId(now = Date.now()): string {
  return `MS-${String(now)}`;
}

/** Greek gift text with the line breaks the acceptance check hashes. */
export function milestoneGiftMessage(externalId: string): string {
  return `Χρόνια πολλά!\n\nΜε αγάπη, \nο έλεγχος ${externalId}`;
}

/**
 * Shopify Admin GraphQL order shape, matching the demo fixtures.
 * The gift message is stored as the caller passed it.
 */
export function milestoneOrderPayload(
  externalId: string,
  gift: string,
  at: string,
): Record<string, unknown> {
  return {
    id: externalId,
    name: `#${externalId}`,
    createdAt: at,
    updatedAt: at,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    email: 'milestone.order@example.test',
    phone: '+35799001999',
    note: 'Παρακαλώ μετά τις 17:00.',
    currencyCode: 'EUR',
    customer: {
      id: 'gid://shopify/Customer/MS',
      displayName: 'Γιώργος Δημητρίου',
      email: 'milestone.order@example.test',
      phone: '+35799001999',
    },
    shippingAddress: {
      firstName: 'Μαρία',
      lastName: 'Παπαδοπούλου',
      address1: '1 Demo Street',
      city: 'Λευκωσία',
      zip: '1000',
      countryCodeV2: 'CY',
      phone: '+35799001001',
    },
    customAttributes: [{ key: 'Gift Message', value: gift }],
    shippingLine: { code: 'local', title: 'Local courier' },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${externalId}`,
          sku: 'NUTS',
          title: 'Mixed nuts',
          variantTitle: '250 g',
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: '8.5000', currencyCode: 'EUR' } },
          originalTotalSet: { shopMoney: { amount: '8.50', currencyCode: 'EUR' } },
        },
      ],
    },
    subtotalPriceSet: { shopMoney: { amount: '8.50', currencyCode: 'EUR' } },
    totalShippingPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    totalTaxSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    totalPriceSet: { shopMoney: { amount: '8.50', currencyCode: 'EUR' } },
  };
}
