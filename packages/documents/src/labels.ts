export type DocumentLanguage = 'en' | 'el';

export type DocumentLabels = {
  invoice: string;
  quote: string;
  creditNote: string;
  draft: string;
  seller: string;
  client: string;
  issueDate: string;
  dueDate: string;
  notIssued: string;
  currency: string;
  reference: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount: string;
  taxRate: string;
  net: string;
  taxSummary: string;
  taxCode: string;
  tax: string;
  gross: string;
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  notes: string;
  terms: string;
  pricesIncludeTax: string;
  pricesExcludeTax: string;
  number: string;
  supplyDate: string;
  vatNumber: string;
  registrationNumber: string;
  unitPriceExclVat: string;
  netTotalExclVat: string;
  totalVat: string;
  totalPayable: string;
  vatNotes: string;
  bankDetails: string;
  bank: string;
  accountHolder: string;
  creditsInvoice: string;
  creditReason: string;
};

const EN: DocumentLabels = {
  invoice: 'Invoice',
  quote: 'Quote',
  creditNote: 'Credit note',
  draft: 'Draft',
  seller: 'From',
  client: 'Bill to',
  issueDate: 'Issue date',
  dueDate: 'Due date',
  notIssued: 'Not issued',
  currency: 'Currency',
  reference: 'Reference',
  description: 'Description',
  quantity: 'Qty',
  unit: 'Unit',
  unitPrice: 'Unit price',
  discount: 'Discount',
  taxRate: 'VAT',
  net: 'Net',
  taxSummary: 'Tax summary',
  taxCode: 'Tax code',
  tax: 'Tax',
  gross: 'Gross',
  subtotal: 'Subtotal',
  discountTotal: 'Discount',
  netTotal: 'Net total',
  taxTotal: 'Tax total',
  total: 'Total',
  notes: 'Notes',
  terms: 'Terms',
  pricesIncludeTax: 'Prices include tax',
  pricesExcludeTax: 'Prices exclude tax',
  number: 'No.',
  supplyDate: 'Date of supply',
  vatNumber: 'VAT no.',
  registrationNumber: 'Company reg. no.',
  unitPriceExclVat: 'Unit price excl. VAT',
  netTotalExclVat: 'Total excl. VAT',
  totalVat: 'Total VAT',
  totalPayable: 'Total payable',
  vatNotes: 'VAT notes',
  bankDetails: 'Bank details',
  bank: 'Bank',
  accountHolder: 'Account holder',
  creditsInvoice: 'Credits invoice',
  creditReason: 'Reason',
};

const EL: DocumentLabels = {
  invoice: 'Τιμολόγιο',
  quote: 'Προσφορά',
  creditNote: 'Πιστωτικό σημείωμα',
  draft: 'Προσχέδιο',
  seller: 'Από',
  client: 'Πελάτης',
  issueDate: 'Ημερομηνία έκδοσης',
  dueDate: 'Ημερομηνία λήξης',
  notIssued: 'Δεν έχει εκδοθεί',
  currency: 'Νόμισμα',
  reference: 'Αναφορά',
  description: 'Περιγραφή',
  quantity: 'Ποσ.',
  unit: 'Μον.',
  unitPrice: 'Τιμή μονάδας',
  discount: 'Έκπτωση',
  taxRate: 'ΦΠΑ',
  net: 'Καθαρή αξία',
  taxSummary: 'Ανάλυση φόρου',
  taxCode: 'Κωδικός',
  tax: 'Φόρος',
  gross: 'Μικτή αξία',
  subtotal: 'Μερικό σύνολο',
  discountTotal: 'Έκπτωση',
  netTotal: 'Καθαρό σύνολο',
  taxTotal: 'Σύνολο φόρου',
  total: 'Σύνολο',
  notes: 'Σημειώσεις',
  terms: 'Όροι',
  pricesIncludeTax: 'Οι τιμές περιλαμβάνουν φόρο',
  pricesExcludeTax: 'Οι τιμές δεν περιλαμβάνουν φόρο',
  number: 'Αριθμός',
  supplyDate: 'Χρόνος προμήθειας',
  vatNumber: 'Αρ. Μητρώου ΦΠΑ',
  registrationNumber: 'Αρ. Εγγραφής Εταιρείας',
  unitPriceExclVat: 'Τιμή μονάδας χωρίς ΦΠΑ',
  netTotalExclVat: 'Σύνολο χωρίς ΦΠΑ',
  totalVat: 'Σύνολο ΦΠΑ',
  totalPayable: 'Πληρωτέο σύνολο',
  vatNotes: 'Σημειώσεις ΦΠΑ',
  bankDetails: 'Τραπεζικά στοιχεία',
  bank: 'Τράπεζα',
  accountHolder: 'Δικαιούχος',
  creditsInvoice: 'Πιστώνει το τιμολόγιο',
  creditReason: 'Αιτία',
};

export function labelsFor(language: DocumentLanguage): DocumentLabels {
  return language === 'el' ? EL : EN;
}

export type PackingLabels = {
  title: string;
  orderNumber: string;
  store: string;
  delivery: string;
  recipient: string;
  items: string;
  sku: string;
  item: string;
  variant: string;
  quantity: string;
  giftMessage: string;
  giftYes: string;
  giftNo: string;
  deliveryMethods: Readonly<Record<string, string>>;
};

const PACKING_EN: PackingLabels = {
  title: 'Packing slip',
  orderNumber: 'Order',
  store: 'Store',
  delivery: 'Delivery',
  recipient: 'Recipient',
  items: 'Items',
  sku: 'SKU',
  item: 'Item',
  variant: 'Variant',
  quantity: 'Qty',
  giftMessage: 'Gift message',
  giftYes: 'Yes',
  giftNo: 'No',
  deliveryMethods: {
    courier_cy: 'Courier (Cyprus)',
    post_international: 'International post',
    collection: 'Collection',
    unknown: 'Unknown',
  },
};

const PACKING_EL: PackingLabels = {
  title: 'Δελτίο συσκευασίας',
  orderNumber: 'Παραγγελία',
  store: 'Κατάστημα',
  delivery: 'Παράδοση',
  recipient: 'Παραλήπτης',
  items: 'Είδη',
  sku: 'Κωδικός',
  item: 'Είδος',
  variant: 'Παραλλαγή',
  quantity: 'Ποσ.',
  giftMessage: 'Μήνυμα δώρου',
  giftYes: 'Ναι',
  giftNo: 'Όχι',
  deliveryMethods: {
    courier_cy: 'Ταχυμεταφορέας (Κύπρος)',
    post_international: 'Διεθνές ταχυδρομείο',
    collection: 'Παραλαβή',
    unknown: 'Άγνωστη',
  },
};

export function packingLabels(language: DocumentLanguage): PackingLabels {
  return language === 'el' ? PACKING_EL : PACKING_EN;
}
