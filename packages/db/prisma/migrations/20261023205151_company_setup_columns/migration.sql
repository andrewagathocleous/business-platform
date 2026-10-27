-- Company version, and archive timestamps for brands and locations.
-- prisma migrate dev --create-only emitted only these three ADD COLUMN
-- statements. It did not drop a partial unique index, an RLS policy, a grant
-- or a trigger. Those objects stay.
ALTER TABLE "company" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "brand" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
ALTER TABLE "location" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
