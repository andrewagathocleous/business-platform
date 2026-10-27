-- One default gift-message template per company.
-- Prisma cannot model a partial unique index, so this is not declared in schema.prisma.
CREATE UNIQUE INDEX "gift_message_template_one_default_key"
  ON "gift_message_template" ("company_id")
  WHERE "is_default";
