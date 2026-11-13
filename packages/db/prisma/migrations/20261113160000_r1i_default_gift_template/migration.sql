-- R1-I. One default Zebra 100 × 150 mm gift-card template for every company that has none.
-- Prisma migrate runs this as bp_owner, the migration role (DATABASE_URL_OWNER).
-- One audit row per template created. A company that already has a template is skipped,
-- so running the statement again does nothing.
-- Keep the inserted values equal to DEFAULT_GIFT_TEMPLATE in
-- apps/api/src/documents/default-gift-template.ts.

DO $r1i$
DECLARE
  company_row record;
  template_id uuid;
BEGIN
  IF current_user <> 'bp_owner' THEN
    RAISE EXCEPTION 'default gift-card template backfill must run as bp_owner';
  END IF;

  FOR company_row IN
    SELECT id FROM company ORDER BY id
  LOOP
    PERFORM set_config('app.company_id', company_row.id::text, true);
    IF EXISTS (
      SELECT 1 FROM gift_message_template WHERE company_id = company_row.id
    ) THEN
      CONTINUE;
    END IF;

    template_id := gen_random_uuid();
    INSERT INTO gift_message_template (
      id, company_id, name,
      page_width_mm, page_height_mm,
      margin_top_mm, margin_right_mm, margin_bottom_mm, margin_left_mm,
      font_size_pt, min_font_size_pt, line_height,
      align, vertical_align, is_default
    ) VALUES (
      template_id,
      company_row.id,
      'Zebra 100 × 150 mm',
      100.00, 150.00,
      5.00, 5.00, 5.00, 5.00,
      16.00, 9.00, 1.250,
      'center', 'middle',
      true
    );

    INSERT INTO audit_event (
      id, company_id, actor_type, actor_label,
      action, object_type, object_id, outcome, correlation_id, details
    ) VALUES (
      gen_random_uuid(),
      company_row.id,
      'system',
      'bp_owner',
      'gift_message_template.created',
      'gift_message_template',
      template_id,
      'success',
      'r1i-default-gift-template',
      jsonb_build_object(
        'name', 'Zebra 100 × 150 mm',
        'isDefault', true,
        'preset', 'zebra-100x150'
      )
    );
  END LOOP;
END
$r1i$;
