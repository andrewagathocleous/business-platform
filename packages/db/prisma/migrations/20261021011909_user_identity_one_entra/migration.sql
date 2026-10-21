-- One Entra identity per user. A dev identity may still sit beside it.
-- Prisma cannot model a partial unique index, so this is not declared in schema.prisma.
CREATE UNIQUE INDEX "user_identity_one_entra_key"
  ON "user_identity" ("user_id")
  WHERE "provider" = 'entra';
