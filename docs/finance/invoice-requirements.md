# Invoice requirements (Cyprus and EU)

Release 2, step R2-A (P3-01). This is research for the accountant's sign-off; **it is not legal advice.** The platform does not claim compliance from a template. Real issuance stays off (`invoice.issue_real`) until the accountant signs the checklist at the end (A10 in `docs/plan/release-2.md`).

**Sources, checked 2026-10-27:**
- **[ΚΔΠ 314/2001]** The Cyprus VAT Regulations (Οι περί Φόρου Προστιθέμενης Αξίας Κανονισμοί), in the consolidated text "last update ΚΔΠ 71/2025" published by the Tax Department on gov.cy in January 2026.
  - The consolidation prints superseded and current wording side by side. Only the wording in force is used here.
  - "reg." means a regulation of ΚΔΠ 314/2001.
- **[EC]** European Commission, "VAT invoicing rules" (https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en), on VAT Directive 2006/112/EC.
- **[TD rates]** Tax Department, "Συντελεστές Φ.Π.Α." (https://www.gov.cy/mof-tax/documents/syntelestes-f-p-a/).

Several third-party guides found online give wrong deadlines or retention periods. Where they disagree with the regulation text, the regulation text wins.

## 1. When a VAT invoice is required

**[reg. 11(1)]** A registered person must deliver a VAT invoice when they:
- make a taxable supply in Cyprus **to a taxable person**;
- make a non-exempt supply of goods or services to a person in another member state;
- receive an advance payment for supplies to another taxable person, or to a person referred to in **Article 31** of the VAT Law (for example certain public bodies);
- make the supplies in **reg. 88A** (qualifying intra-Community supplies of goods to taxable persons) or **reg. 88B** (qualifying excise goods to non-taxable persons in another member state). Ordinary distance sales to EU consumers are a different category, not covered here (section 8).

**Consumers in Cyprus [reg. 13A]**
- A **taxable** supply to a non-taxable person in Cyprus needs a **legal receipt** (νόμιμη απόδειξη), given at the time of supply, not a VAT invoice.
- It shows:
  - issue date and an identifying number;
  - the seller's name, address and registration number;
  - a description;
  - the total including VAT, and the total including VAT for each rate together with that rate;
  - whether the sale is for cash, an advance, a part payment, or otherwise.
- **13A(4):** a cash invoice issued under the tax-collection regulations replaces the legal receipt.
- **13A(3):** receipts issued with fiscal electronic devices or systems must also meet the Commissioner's notice on those systems.

**Retailers [reg. 14]**
- A retailer delivers a VAT invoice only when a taxable customer asks for one.
- **14(1):** for a sale of **€85 or less**, other than to a person in another member state, a simplified invoice is enough. It shows:
  - the retailer's name, address and registration number;
  - the issue date;
  - a description;
  - the total including VAT;
  - the total including VAT for each rate, with that rate.
- **14(2):** a reg. 14 invoice must not refer to exempt supplies.
- **14(3):** for the supplies it lists, made by suppliers not established in Cyprus where the customer accounts for the VAT, the full reg. 12 particulars apply.

**What this means for A1.** Web orders from consumers need a legal receipt (or a qualifying cash invoice), which PrestaShop may already provide. The platform's VAT invoices are mainly for business clients. If A1 brings receipts into the platform, 13A(3) and the fiscal-system notice must be checked first. The accountant confirms.

## 2. Deadlines, and they concern delivery

The regulations set a deadline for **delivering** the invoice to the customer (παραδίδονται), not only for creating it.
- **[reg. 11(5)]** Within **30 days** of the time of supply (Article 9 of the VAT Law), or a longer period the Commissioner allows **in writing**. This paragraph is subject to 11(6).
- **[reg. 11(6)]** For the goods in regs. 88A and 88B, and for services where the **customer** owes the VAT: **by the 15th day of the month after** the month of supply. Paragraph (6) has **no** extension by the Commissioner.

**In the platform:**
- **Supply date.** Each document has a supply date, which defaults to the issue date.
- **Which deadline applies.** Each tax code carries the deadline rule the accountant sets: the default 30 days, or the 15th of the following month.
- **Recording delivery.** Staff record when and how the invoice was delivered (handed over, posted, or emailed outside the platform). Emailing from the platform comes in R5.
- **Late invoices are warned about, not refused.** The platform shows invoices that are not yet delivered, with their deadline, and warns when a deadline is near or past. It never refuses to issue a late invoice, because refusing would make a late invoice impossible instead of merely late.

## 3. What a VAT invoice must show

These are the particulars in force under [reg. 12(1)], plus the items [EC] lists from the Directive, with where each comes from in the platform.

| Provision | Required | Platform source |
|---|---|---|
| 12(1)(α) | An identifying number. [EC]: unique and sequential | `number` from the series (R2-C) |
| 12(1)(β) | The time of supply, or the date of an advance payment | `supply_date` (R2-C), **always printed**, even when it equals the issue date. The Directive's "if different" qualification is not in the Cyprus text |
| 12(1)(γ) | Issue date | `issue_date`, the company's business date |
| 12(1)(δ) | Supplier name, address and VAT registration number | `seller_snapshot` |
| 12(1)(ε) | Customer name and address | `buyer_snapshot` |
| [EC] | The customer's VAT number when the customer is liable for the VAT | `buyer_snapshot`; required by the rule on reverse-charge lines |
| 12(1)(στ) | A description sufficient to identify the goods or services | Line description |
| 12(1)(ζ) | For each line: quantity, unit price or extent; VAT rate; amount payable excluding VAT | Line quantity, unit price, rate and net |
| [EC] | Unit price excluding VAT, and any discounts not already in it | Line unit price and discount. **On tax-inclusive documents the stored unit price includes VAT**, so the PDF prints a derived VAT-exclusive unit price: unit price × 100 / (100 + rate), rounded half-up to 4 decimals. For example €11.90 at 19 % prints €10.00. The line net from the totals engine remains the amount that counts |
| 12(1)(η) | Total payable excluding VAT | `net_total` |
| 12(1)(θ) | The rate of any cash discount offered | Not supported, because the platform offers no cash discounts. The accountant confirms none are used |
| 12(1)(ι) | **The total VAT payable**. The earlier "each rate and its VAT" wording was repealed | `tax_total`, printed as its own line |
| [EC] | The VAT amount by rate or exemption | Tax summary per tax code, printed as well |
| 12(3) | Exempt and zero-rated items shown separately, with a total for each kind of supply and rate | Tax summary per tax code and the code's kind |
| 12(1)(ξ) | "Αντίστροφη χρέωση" (reverse charge) when the customer owes the VAT. [EC]: the words "reverse charge" | The tax code's legal note, in Greek and English |
| [EC] | For exempt supplies, a reference to the exemption provision or another indication that the supply is exempt | The tax code's legal note |
| 12(1)(κ), (λ), (μ), (ν) | Margin scheme reference, VAT representative, "Καθεστώς Ταμειακής Λογιστικής" (cash accounting), "Αυτοτιμολόγηση" (self-billing) | Not used. The accountant confirms |
| 12(1Α) | Invoices **and amending documents** delivered to a person in another member state. See the rules after this table | Validation, on credit notes too |
| 12(4) | Amounts may be in any currency, but **the VAT due must be stated in euro**, converted at the ECB rate | R2 issues **in EUR only**, and refuses otherwise |

**The 12(1Α) rules:**
- the supplier's number with the **"CY"** prefix;
- the customer's registration number **if one exists**, with its country code. An EU consumer without a VAT number is not refused;
- for **new means of transport** (12(1Α)(ε)), particulars identifying them as such. The business does not sell these, so the platform refuses intra-EU lines marked as new means of transport, and the accountant confirms.

## 4. Credit notes and other amending documents

- **[EC, Article 219]** A document amending an invoice is treated as an invoice if it makes a specific, unambiguous reference to the original.
- **[EC, Article 226b(e)]** For simplified amending invoices, the specific details being amended must also be shown. The platform shows them on every credit note.
- **[reg. 12(1Α)]** It applies to amending documents too (section 3).
- **[reg. 13]** This covers a specific case. When a VAT rate, or the description of exempt or zero-rated supplies, changes, and an invoice was issued **before an election under Article 55** of the VAT Law, a credit note titled "Πιστωτικό σημείωμα - αλλαγή συντελεστή του Φ.Π.Α." must be delivered within 14 days. It contains:
  - its own number and issue date;
  - the supplier's name, address and VAT number;
  - the customer's name and address;
  - the original invoice's number and date;
  - a description;
  - the VAT credited.

**In the platform.** Every credit note shows, as a minimum:
- its own number and dates;
- the full supplier and customer particulars, including the 12(1Α) VAT identifiers where they apply;
- the original's number and date;
- the credited lines, the amounts changed, and the VAT credited per tax code.

The accountant confirms any other wording (A5), and whether reg. 13 credit notes are ever needed.

## 5. Electronic invoices and delivery

- **[reg. 11A(1)(γ)]** and [EC]: an electronic invoice may be used only if the **customer accepts** it.
- **[reg. 11B]** If an invoice is not in an official language, the Commissioner may require a translation within **30 days of written notice**.

**In the platform:**
- **Client acceptance.** Each client records whether it accepts electronic invoices. When a client does not, the invoice is printed (R1 printing) and delivered on paper, and the delivery is recorded (section 2).
- **Translations.** Documents can be produced in Greek, English or both (A6). A translation on request can be produced from the same snapshot.

## 6. Keeping records

**Retention [reg. 22(1)(β)]**, as amended by ΚΔΠ 360/2012: keep copies of all invoices and receipts issued, and all business records, for **6 years**, unless the Commissioner provides otherwise. Before 2012 the period was 7 years.

**Storage [regs. 11Γ–11Ε]:**
- **Original format, 11Γ(4).** Invoices are kept in the original format in which they were sent, together with the data that proves their authenticity and integrity.
- **Where they are kept.** Storage outside Cyprus needs **prior notification** to the Commissioner. Storage without full online access must stay **in Cyprus**. Some third countries are not allowed.
- **Access.** Records must be available on request within **5 days**. Storage in another member state must give the Tax Department electronic access, download and use.
- **Electronic invoices.** Authenticity of origin, integrity of content and legibility must be ensured for the whole storage period.

**In the platform:**
- **Electronic delivery.** The issued PDF is the original. It is written once, hashed, and checked on every read (R2-C).
- **Paper delivery.** The delivered paper is the original, so a PDF alone is not enough (reg. 11Γ(4); the Commission's explanatory notes treat electronically generated invoices delivered on paper as paper invoices).
  - Printing for paper delivery prints **two copies**: one for the client and one for the company's paper file.
  - Recording a paper delivery needs confirmation that the file copy was kept.
  - The accountant confirms this, or an officially supported alternative such as scanning (A8).
- **Where the data lives.** The live data is on the laptop in Cyprus.
- **Backups abroad.** The encrypted nightly backups (R0-C) go to a cloud-synced folder, which may be on servers outside Cyprus. **Whether that needs notification is a question for the accountant (A8).**
- **Deletion.** Nothing issued is ever deleted.
- The accountant also confirms that 6 years is enough, since company and income-tax rules may ask for longer.

## 7. VAT rates

[TD rates] gives these rates.

| Rate | Examples from the page |
|---|---|
| **19 %** | Standard rate, applying to everything not listed below |
| **9 %** | Taxis and coaches, restaurant and catering, hotel accommodation |
| **5 %** | **Food and drinks, except alcoholic drinks, beer and soft drinks**, and except those at 0 %. Also water, medicines and others |
| **3 %** | Books, newspapers and periodicals, including electronic ones, and some aids for people with disabilities |
| **0 %** | Exports of goods, some basic items, and others |
| **Exempt** | Listed separately |

**For this business:**
- the nuts are probably 5 %;
- gift boxes and non-food items are probably 19 %;
- shipping charges are for the accountant to treat.

The accountant picks the codes (A3), and they are entered as tax codes in R2-B.

## 8. Not covered yet

- OSS returns and invoicing for distance sales to EU consumers.
- Upcoming EU e-invoicing and digital reporting (ViDA). Check before they apply.
- Legal receipts issued by the platform, if A1 needs them (section 1).

## Accountant sign-off checklist (A10)

The accountant checks the sample documents from R2-I against this list, then signs and dates it.

| Item | OK |
|---|---|
| Sections 1–6 match current Cyprus requirements for this business | |
| The tax codes, legal notes and deadline rules entered (A3, A4) are right | |
| Series, prefix and yearly restart (A2) are right | |
| The sample invoice shows every item in section 3 that applies, including the supply date and total VAT | |
| The sample credit note shows the section 4 contents | |
| Delivery: how invoices reach clients (electronic acceptance or paper), and the delivery record | |
| Language of the documents (A6), and handling a translation request | |
| Retention period, and whether backups stored abroad need notification (A8) | |
| Which sales the platform invoices, and which the shops handle with receipts (A1) | |
| Export format for the accountant's software (A9) | |

Signed: ____________  Date: ____________
