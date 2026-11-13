# Money, tax and rounding rules

Status: engineering default. **Accountant validation is required before real issuance (U1).** Rules are configurable per company where marked.

## Representation

- Arithmetic uses `decimal.js` with precision 40 and rounding `ROUND_HALF_UP`. Half-up rounds away from zero at exactly .5, so 0.125 → 0.13 and 0.005 → 0.01.
- Stored as `numeric(19,4)` for quantities and unit prices, `numeric(19,2)` for monetary amounts and `numeric(7,4)` for tax rates in percent.
- The API carries amounts as decimal strings. JSON numbers are rejected for money fields.
- Currency precision is 2 minor digits. Phase 1 rejects currencies with any other precision.

## Input constraints (invoice and quote lines)

- `quantity`: > 0, at most 4 decimal places, ≤ 1,000,000.
- `unitPrice`: ≥ 0, at most 4 decimal places, ≤ 10,000,000.
- `discountPercent`: 0–100, at most 2 decimal places.
- Every line has a tax code. The rate is snapshotted onto the line when the draft is saved.
- Negative lines are not allowed. Corrections and credits use credit notes (Phase 3).
- Shipping is a line of kind `shipping` with its own tax code.
- Document-level discounts are not in Phase 1.

## Tax-exclusive pricing (`pricesIncludeTax = false`)

For each line:

```
lineSubtotal = round2(quantity × unitPrice)
lineDiscount = round2(lineSubtotal × discountPercent / 100)
lineNet      = lineSubtotal − lineDiscount
```

For each tax code group (lines sharing a tax code):

```
groupNet = Σ lineNet
groupTax = round2(groupNet × rate / 100)
```

Document totals:

```
subtotal      = Σ lineSubtotal
discountTotal = Σ lineDiscount
netTotal      = Σ lineNet
taxTotal      = Σ groupTax
total         = netTotal + taxTotal
```

Tax is rounded **once per tax-code group**, not per line and not per rate. Two different codes with the same rate are separate groups, each rounded on its own, and each gets its own line in the invoice tax summary. That's because codes can differ in kind or legal note even when the rate matches. See E12.

## Tax-inclusive pricing (`pricesIncludeTax = true`)

For each line:

```
lineSubtotal = round2(quantity × unitPrice)          // gross
lineDiscount = round2(lineSubtotal × discountPercent / 100)
lineGross    = lineSubtotal − lineDiscount
```

For each tax code group:

```
groupGross = Σ lineGross
groupNet   = round2(groupGross × 100 / (100 + rate))
groupTax   = groupGross − groupNet
```

Line nets (stored and displayed) are allocated from `groupNet` by the **largest-remainder method**:

1. Compute each line's raw net, `lineGross × 100 / (100 + rate)`.
2. Truncate each to 2 decimal places.
3. Hand out the remaining cents one at a time to the lines with the largest truncated remainders. Ties go to the lower line position.

This makes `Σ lineNet = groupNet` exactly.

The net and the remainders are worked out in whole numbers (`packages/domain/src/money/exact.ts`), not with rounded division: within one group every remainder has the denominator `100 + rate`, so their numerators are compared exactly, and a tie really is a tie (E13).

Document totals:

```
total    = Σ groupGross
taxTotal = Σ groupTax
netTotal = total − taxTotal
```

## Worked examples (each one must be a unit test)

| # | Mode | Lines | Expected |
|---|---|---|---|
| E1 | excl | 3 × 0.3333 @19% | subtotal 1.00, tax 0.19, total 1.19 |
| E2 | excl | 1 × 0.125 @0% | net 0.13 (half-up), total 0.13 |
| E3 | excl | 1 × 0.005 @0% | net 0.01 |
| E4 | excl | 2 × 10.00, 15% discount @19% | subtotal 20.00, discount 3.00, net 17.00, tax 3.23, total 20.23 |
| E5 | excl | 1 × 10.00 @19% and 1 × 5.00 @9% | tax 1.90 + 0.45 = 2.35, total 17.35 |
| E6 | incl | 1 × 11.90 @19% | net 10.00, tax 1.90, total 11.90 |
| E7 | incl | 3 lines of 1 × 0.99 @19% | total 2.97, net 2.50, tax 0.47; line nets 0.84, 0.83, 0.83 |
| E8 | excl | 3 lines of 1 × 0.05 @19% | groupNet 0.15, tax round2(0.0285) = 0.03, total 0.18 |
| E9 | excl | 1 × 50.00, 100% discount @19% | net 0.00, tax 0.00, total 0.00 |
| E10 | excl | 1000000 × 9999999.9999 @19% | subtotal 9999999999900.00, tax 1899999999981.00, total 11899999999881.00 (fits `numeric(19,2)`; exact) |
| E11 | either | quantity 0, negative price, discount 101, 5-dp quantity | validation errors |
| E12 | excl | 1 × 0.03 with code `STD19` (19%) and 1 × 0.03 with code `ALT19` (also 19%) | two groups: tax 0.01 + 0.01 = 0.02, total 0.08 (grouping by rate would give 0.07; that's wrong under this rule) |
| E13 | incl | 1 × 0.27 and 1 × 0.06 @5% | net 0.31, tax 0.02; both remainders are exactly 0.0071428… of a cent, so the lower position gets it: line nets 0.26, 0.05 |

The tax rates in these examples are test inputs only. The seeded tax codes are labelled *example configuration — verify with accountant*.

## Not covered yet (Phase 3 backlog)

- Reverse charge and exempt legal notes, intra-EU B2B, OSS, triangulation.
- Document-level discounts, rounding lines and cash rounding.
- Foreign-currency invoices with an exchange-rate snapshot.
- Payment allocation rules (R2-E). Credit notes, including partial lines, follow the cumulative-difference rule in `docs/plan/release-2.md` (R2-D) and `packages/domain/src/money/credit.ts`.
