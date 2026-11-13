-- R2-D3: issuing credit notes. Issued credit notes of one invoice, with the one being
-- issued, never credit a line beyond its quantity or a tax-code group beyond its net, tax or
-- gross; each credits positive quantities and amounts; and they carry the invoice's frozen
-- tax treatment.

-- One summary row per tax code (Prisma part, from `prisma migrate diff`): the limits below
-- compare groups by code.
CREATE UNIQUE INDEX "invoice_tax_summary_company_id_invoice_id_tax_code_id_key" ON "invoice_tax_summary"("company_id", "invoice_id", "tax_code_id");

-- True when the issued credit notes of the invoice that p_credit_note_id credits, together
-- with p_credit_note_id itself (issued or not), credit more than that invoice shows. The
-- application asks it before numbering; invoice_issue_guard refuses the issue with it.
-- Rows are read under the caller's RLS.
CREATE OR REPLACE FUNCTION credit_note_exceeds_original(p_company_id uuid, p_credit_note_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH note AS (
    SELECT credited_invoice_id
    FROM invoice
    WHERE company_id = p_company_id AND id = p_credit_note_id AND document_type = 'credit_note'
  ),
  credits AS (
    SELECT d.id
    FROM invoice d, note
    WHERE d.company_id = p_company_id
      AND d.credited_invoice_id = note.credited_invoice_id
      AND (d.status = 'issued' OR d.id = p_credit_note_id)
  ),
  lines AS (
    SELECT l.credited_line_id, sum(l.quantity) AS quantity
    FROM invoice_line l
    WHERE l.company_id = p_company_id AND l.invoice_id IN (SELECT id FROM credits)
    GROUP BY l.credited_line_id
  ),
  groups AS (
    SELECT s.tax_code_id, sum(s.net) AS net, sum(s.tax) AS tax, sum(s.gross) AS gross
    FROM invoice_tax_summary s
    WHERE s.company_id = p_company_id AND s.invoice_id IN (SELECT id FROM credits)
    GROUP BY s.tax_code_id
  )
  SELECT NOT EXISTS (SELECT 1 FROM note)
    OR EXISTS (
      SELECT 1
      FROM lines
      LEFT JOIN invoice_line o
        ON o.company_id = p_company_id
       AND o.id = lines.credited_line_id
       AND o.invoice_id = (SELECT credited_invoice_id FROM note)
      WHERE o.id IS NULL OR lines.quantity > o.quantity
    )
    OR EXISTS (
      SELECT 1
      FROM groups
      LEFT JOIN invoice_tax_summary o
        ON o.company_id = p_company_id
       AND o.invoice_id = (SELECT credited_invoice_id FROM note)
       AND o.tax_code_id = groups.tax_code_id
      WHERE o.id IS NULL OR groups.net > o.net OR groups.tax > o.tax OR groups.gross > o.gross
    );
$$;

-- invoice_issue_guard as in R2-C2, plus the credit-note checks at the end.
CREATE OR REPLACE FUNCTION invoice_issue_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a document is issued from a draft, never inserted as issued'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'issued' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be issued'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM 1
  FROM stored_file
  WHERE company_id = NEW.company_id
    AND id = NEW.pdf_file_id
    AND sealed
    AND kind = 'invoice_pdf'
    AND source_type = 'invoice'
    AND source_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an issued document needs its own sealed PDF'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoice_line WHERE company_id = NEW.company_id AND invoice_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM invoice_line
    WHERE company_id = NEW.company_id
      AND invoice_id = NEW.id
      AND (jsonb_typeof(tax_snapshot) IS DISTINCT FROM 'object' OR description !~ '[^[:space:]]')
  ) THEN
    RAISE EXCEPTION 'an issued document needs lines, each with a description and its tax snapshot'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM invoice_tax_summary WHERE company_id = NEW.company_id AND invoice_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM invoice_tax_summary
    WHERE company_id = NEW.company_id
      AND invoice_id = NEW.id
      AND jsonb_typeof(tax_snapshot) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'an issued document needs its tax summary, each row with its tax snapshot'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.document_type = 'credit_note' THEN
    -- Credits of one invoice are issued one at a time. The issuing path already holds this
    -- lock (it locks the credit note and its original together), so it waits for nothing.
    PERFORM 1 FROM invoice
    WHERE company_id = NEW.company_id AND id = NEW.credited_invoice_id
    FOR UPDATE;
    -- Credits only add up: a negative one would give back room for another.
    IF NEW.subtotal < 0 OR NEW.discount_total < 0 OR NEW.net_total < 0
       OR NEW.tax_total < 0 OR NEW.total < 0
       OR EXISTS (
         SELECT 1 FROM invoice_line
         WHERE company_id = NEW.company_id
           AND invoice_id = NEW.id
           AND (quantity <= 0 OR line_subtotal < 0 OR line_discount < 0
                OR line_net < 0 OR line_gross < 0)
       )
       OR EXISTS (
         SELECT 1 FROM invoice_tax_summary
         WHERE company_id = NEW.company_id
           AND invoice_id = NEW.id
           AND (net < 0 OR tax < 0 OR gross < 0)
       ) THEN
      RAISE EXCEPTION 'a credit note credits positive quantities and amounts'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM invoice_line c
      JOIN invoice_line o ON o.company_id = c.company_id AND o.id = c.credited_line_id
      WHERE c.company_id = NEW.company_id
        AND c.invoice_id = NEW.id
        AND c.tax_snapshot IS DISTINCT FROM o.tax_snapshot
    ) OR EXISTS (
      SELECT 1
      FROM invoice_tax_summary c
      LEFT JOIN invoice_tax_summary o
        ON o.company_id = c.company_id
       AND o.invoice_id = NEW.credited_invoice_id
       AND o.tax_code_id = c.tax_code_id
      WHERE c.company_id = NEW.company_id
        AND c.invoice_id = NEW.id
        AND (
          o.id IS NULL
          OR c.tax_rate_percent <> o.tax_rate_percent
          OR c.tax_snapshot IS DISTINCT FROM o.tax_snapshot
        )
    ) THEN
      RAISE EXCEPTION 'a credit note carries the tax treatment frozen on the invoice it credits'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF credit_note_exceeds_original(NEW.company_id, NEW.id) THEN
      RAISE EXCEPTION 'credit notes never credit more than the invoice''s lines or tax groups'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
