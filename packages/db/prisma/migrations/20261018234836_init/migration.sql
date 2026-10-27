-- Email columns use citext. The extension is trusted, so bp_owner can create it.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "locale" AS ENUM ('en', 'el');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "identity_provider" AS ENUM ('entra', 'dev');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('invited', 'active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "scope_type" AS ENUM ('company', 'store', 'location', 'mailbox', 'integration_account');

-- CreateEnum
CREATE TYPE "store_platform" AS ENUM ('shopify', 'prestashop', 'manual');

-- CreateEnum
CREATE TYPE "invoice_authority" AS ENUM ('undecided', 'store', 'platform');

-- CreateEnum
CREATE TYPE "connection_mode" AS ENUM ('mock', 'live');

-- CreateEnum
CREATE TYPE "client_kind" AS ENUM ('organisation', 'individual');

-- CreateEnum
CREATE TYPE "address_kind" AS ENUM ('billing', 'shipping');

-- CreateEnum
CREATE TYPE "tax_kind" AS ENUM ('standard', 'reduced', 'zero', 'exempt', 'reverse_charge', 'out_of_scope');

-- CreateEnum
CREATE TYPE "product_kind" AS ENUM ('product', 'service', 'shipping');

-- CreateEnum
CREATE TYPE "invoice_document_type" AS ENUM ('quote', 'invoice', 'credit_note');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'cancelled');

-- CreateEnum
CREATE TYPE "invoice_line_kind" AS ENUM ('item', 'shipping');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'authorized', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'unknown');

-- CreateEnum
CREATE TYPE "fulfilment_status" AS ENUM ('new', 'review_required', 'preparing', 'ready', 'handed_to_courier', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('synced', 'stale', 'error');

-- CreateEnum
CREATE TYPE "delivery_method" AS ENUM ('courier_cy', 'post_international', 'collection', 'unknown');

-- CreateEnum
CREATE TYPE "inbox_status" AS ENUM ('received', 'processed', 'stale', 'failed');

-- CreateEnum
CREATE TYPE "stored_file_kind" AS ENUM ('invoice_pdf', 'packing_slip', 'gift_message', 'test_print');

-- CreateEnum
CREATE TYPE "gift_align" AS ENUM ('left', 'center');

-- CreateEnum
CREATE TYPE "gift_vertical_align" AS ENUM ('top', 'middle');

-- CreateEnum
CREATE TYPE "printer_provider" AS ENUM ('mock', 'printnode');

-- CreateEnum
CREATE TYPE "printer_status" AS ENUM ('online', 'offline', 'unknown');

-- CreateEnum
CREATE TYPE "print_document_type" AS ENUM ('invoice', 'packing_slip', 'gift_message', 'shipping_label');

-- CreateEnum
CREATE TYPE "print_source_type" AS ENUM ('order', 'invoice', 'test');

-- CreateEnum
CREATE TYPE "print_job_status" AS ENUM ('queued', 'held', 'submitting', 'submitted', 'delivered_to_printer', 'done_reported', 'confirmed_printed', 'not_printed', 'failed', 'uncertain', 'cancelled');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'held', 'uncertain', 'cancelled');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'service', 'system');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('success', 'denied', 'failure');

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "locale" "locale" NOT NULL DEFAULT 'en',
    "is_platform_owner" BOOLEAN NOT NULL DEFAULT false,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "tenant_id" TEXT,
    "email_at_link" CITEXT,
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "auth_method" TEXT NOT NULL,
    "mfa_satisfied" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_flow" (
    "id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "browser_binding_hash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "redirect_after" TEXT,
    "invitation_token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "auth_flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trading_name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT 'CY',
    "registration_number" TEXT,
    "vat_number" TEXT,
    "tax_office" TEXT,
    "address" JSONB NOT NULL,
    "default_currency" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Nicosia',
    "default_locale" "locale" NOT NULL DEFAULT 'en',
    "document_language" "locale" NOT NULL DEFAULT 'en',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_fictional" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" "membership_status" NOT NULL DEFAULT 'invited',
    "suspended_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "membership_role" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "scope_type" NOT NULL,
    "scope_id" UUID,
    "granted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role_assignments" JSONB NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "invited_by" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_identity" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "permissions" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_switch" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_switch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "timeout_ms" INTEGER,
    "last_error" TEXT,
    "correlation_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_bank_account" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "bic" TEXT,
    "account_holder" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "company_bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "timezone" TEXT,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "platform" "store_platform" NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "invoice_authority" "invoice_authority" NOT NULL DEFAULT 'undecided',
    "gift_message_keys" TEXT[] DEFAULT ARRAY['Gift Message', 'gift_message', 'Gift message']::TEXT[],
    "delivery_method_map" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_connection" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "mode" "connection_mode" NOT NULL DEFAULT 'mock',
    "status" TEXT NOT NULL DEFAULT 'active',
    "credential_id" UUID,
    "read_only" BOOLEAN NOT NULL DEFAULT true,
    "write_back_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_event_at" TIMESTAMPTZ(6),
    "last_sync_at" TIMESTAMPTZ(6),
    "sync_checkpoint" JSONB,

    CONSTRAINT "store_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credential" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "hint" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "integration_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_inbox" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "external_object_id" TEXT,
    "source_updated_at" TIMESTAMPTZ(6),
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "inbox_status" NOT NULL DEFAULT 'received',
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "correlation_id" TEXT,

    CONSTRAINT "integration_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "client_kind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "vat_number" TEXT,
    "tax_id" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "default_currency" TEXT,
    "default_language" TEXT,
    "payment_terms_days" INTEGER,
    "name_normalized" TEXT,
    "email_normalized" TEXT,
    "vat_normalized" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_contact" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" CITEXT,
    "phone" TEXT,
    "position" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "client_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_address" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "kind" "address_kind" NOT NULL,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "client_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_code" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_percent" DECIMAL(7,4) NOT NULL,
    "kind" "tax_kind" NOT NULL,
    "note_en" TEXT,
    "note_el" TEXT,
    "is_example" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tax_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "product_kind" NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL,
    "tax_code_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_series" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_type" "invoice_document_type" NOT NULL,
    "code" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_type" "invoice_document_type" NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "client_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL,
    "issue_date" DATE,
    "due_date" DATE,
    "series_id" UUID,
    "number" TEXT,
    "number_seq" INTEGER,
    "subtotal" DECIMAL(19,2) NOT NULL,
    "discount_total" DECIMAL(19,2) NOT NULL,
    "net_total" DECIMAL(19,2) NOT NULL,
    "tax_total" DECIMAL(19,2) NOT NULL,
    "total" DECIMAL(19,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "source_order_id" UUID,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "issued_by" UUID,
    "issued_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "invoice_line_kind" NOT NULL,
    "product_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL,
    "tax_code_id" UUID NOT NULL,
    "tax_rate_percent" DECIMAL(7,4) NOT NULL,
    "line_subtotal" DECIMAL(19,2) NOT NULL,
    "line_discount" DECIMAL(19,2) NOT NULL,
    "line_net" DECIMAL(19,2) NOT NULL,
    "line_gross" DECIMAL(19,2) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_tax_summary" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "tax_code_id" UUID NOT NULL,
    "tax_rate_percent" DECIMAL(7,4) NOT NULL,
    "net" DECIMAL(19,2) NOT NULL,
    "tax" DECIMAL(19,2) NOT NULL,
    "gross" DECIMAL(19,2) NOT NULL,

    CONSTRAINT "invoice_tax_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_number" TEXT NOT NULL,
    "source_platform" "store_platform" NOT NULL,
    "source_status" JSONB NOT NULL,
    "source_created_at" TIMESTAMPTZ(6),
    "source_updated_at" TIMESTAMPTZ(6),
    "payment_status" "payment_status" NOT NULL,
    "fulfilment_status" "fulfilment_status" NOT NULL,
    "integration_status" "integration_status" NOT NULL,
    "review_reason" TEXT,
    "attention_reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "customer" JSONB,
    "recipient" JSONB,
    "billing_address" JSONB,
    "delivery_method" "delivery_method" NOT NULL,
    "shipping_line" JSONB,
    "gift_message" TEXT,
    "gift_message_meta" JSONB,
    "customer_note" TEXT,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(19,2) NOT NULL,
    "shipping_total" DECIMAL(19,2) NOT NULL,
    "tax_total" DECIMAL(19,2) NOT NULL,
    "total" DECIMAL(19,2) NOT NULL,
    "assigned_to_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "external_line_id" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "variant_title" TEXT,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL,
    "total" DECIMAL(19,2) NOT NULL,

    CONSTRAINT "sales_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_note" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_file" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "stored_file_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "source_version" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_message_template" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "page_width_mm" DECIMAL(6,2) NOT NULL,
    "page_height_mm" DECIMAL(6,2) NOT NULL,
    "margin_top_mm" DECIMAL(6,2) NOT NULL,
    "margin_right_mm" DECIMAL(6,2) NOT NULL,
    "margin_bottom_mm" DECIMAL(6,2) NOT NULL,
    "margin_left_mm" DECIMAL(6,2) NOT NULL,
    "font_size_pt" DECIMAL(6,2) NOT NULL,
    "min_font_size_pt" DECIMAL(6,2) NOT NULL,
    "line_height" DECIMAL(6,3) NOT NULL,
    "align" "gift_align" NOT NULL,
    "vertical_align" "gift_vertical_align" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gift_message_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printer" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "provider" "printer_provider" NOT NULL,
    "external_printer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paper_sizes" TEXT[],
    "status" "printer_status" NOT NULL DEFAULT 'unknown',
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printer_mapping" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "document_type" "print_document_type" NOT NULL,
    "printer_id" UUID NOT NULL,
    "paper_size" TEXT NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "printer_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_job" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "printer_id" UUID NOT NULL,
    "document_type" "print_document_type" NOT NULL,
    "source_type" "print_source_type" NOT NULL,
    "source_id" UUID NOT NULL,
    "source_version" INTEGER NOT NULL,
    "file_id" UUID,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "paper_size" TEXT NOT NULL,
    "status" "print_job_status" NOT NULL DEFAULT 'queued',
    "is_reprint" BOOLEAN NOT NULL DEFAULT false,
    "reprint_of_id" UUID,
    "reprint_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "provider_job_id" TEXT,
    "provider_state" TEXT,
    "requested_by" UUID NOT NULL,
    "queue_job_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "correlation_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "print_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" UUID,
    "outcome" "audit_outcome" NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "ip" INET,
    "user_agent" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_provider_issuer_subject_key" ON "user_identity"("provider", "issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "membership_user_id_company_id_key" ON "membership"("user_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_company_id_key_key" ON "role"("company_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "job_idempotency_key_key" ON "job"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_status_run_after_idx" ON "job"("status", "run_after");

-- CreateIndex
CREATE UNIQUE INDEX "brand_company_id_id_key" ON "brand"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "location_company_id_id_key" ON "location"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_company_id_id_key" ON "store"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_connection_company_id_id_key" ON "store_connection"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credential_company_id_id_key" ON "integration_credential"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_inbox_company_id_connection_id_external_event_i_key" ON "integration_inbox"("company_id", "connection_id", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_company_id_id_key" ON "client"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_code_company_id_id_key" ON "tax_code"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_code_company_id_code_key" ON "tax_code"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "product_company_id_id_key" ON "product"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_company_id_id_key" ON "invoice_series"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_company_id_code_key" ON "invoice_series"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_company_id_id_key" ON "invoice"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_company_id_id_key" ON "sales_order"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_company_id_connection_id_external_id_key" ON "sales_order"("company_id", "connection_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_storage_key_key" ON "stored_file"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_company_id_id_key" ON "stored_file"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "printer_company_id_id_key" ON "printer"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "printer_mapping_company_id_location_id_document_type_key" ON "printer_mapping"("company_id", "location_id", "document_type");

-- CreateIndex
CREATE UNIQUE INDEX "print_job_company_id_id_key" ON "print_job"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "print_job_company_id_idempotency_key_key" ON "print_job"("company_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_identity" ADD CONSTRAINT "service_identity_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_identity" ADD CONSTRAINT "service_identity_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_switch" ADD CONSTRAINT "automation_switch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_switch" ADD CONSTRAINT "automation_switch_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_bank_account" ADD CONSTRAINT "company_bank_account_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_company_id_brand_id_fkey" FOREIGN KEY ("company_id", "brand_id") REFERENCES "brand"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_company_id_location_id_fkey" FOREIGN KEY ("company_id", "location_id") REFERENCES "location"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connection" ADD CONSTRAINT "store_connection_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connection" ADD CONSTRAINT "store_connection_company_id_store_id_fkey" FOREIGN KEY ("company_id", "store_id") REFERENCES "store"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_connection" ADD CONSTRAINT "store_connection_company_id_credential_id_fkey" FOREIGN KEY ("company_id", "credential_id") REFERENCES "integration_credential"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_company_id_connection_id_fkey" FOREIGN KEY ("company_id", "connection_id") REFERENCES "store_connection"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_contact" ADD CONSTRAINT "client_contact_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_contact" ADD CONSTRAINT "client_contact_company_id_client_id_fkey" FOREIGN KEY ("company_id", "client_id") REFERENCES "client"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_address" ADD CONSTRAINT "client_address_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_address" ADD CONSTRAINT "client_address_company_id_client_id_fkey" FOREIGN KEY ("company_id", "client_id") REFERENCES "client"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_company_id_tax_code_id_fkey" FOREIGN KEY ("company_id", "tax_code_id") REFERENCES "tax_code"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_client_id_fkey" FOREIGN KEY ("company_id", "client_id") REFERENCES "client"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_series_id_fkey" FOREIGN KEY ("company_id", "series_id") REFERENCES "invoice_series"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_source_order_id_fkey" FOREIGN KEY ("company_id", "source_order_id") REFERENCES "sales_order"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_product_id_fkey" FOREIGN KEY ("company_id", "product_id") REFERENCES "product"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_tax_code_id_fkey" FOREIGN KEY ("company_id", "tax_code_id") REFERENCES "tax_code"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_tax_summary" ADD CONSTRAINT "invoice_tax_summary_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_tax_summary" ADD CONSTRAINT "invoice_tax_summary_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_tax_summary" ADD CONSTRAINT "invoice_tax_summary_company_id_tax_code_id_fkey" FOREIGN KEY ("company_id", "tax_code_id") REFERENCES "tax_code"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_company_id_store_id_fkey" FOREIGN KEY ("company_id", "store_id") REFERENCES "store"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_company_id_connection_id_fkey" FOREIGN KEY ("company_id", "connection_id") REFERENCES "store_connection"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "sales_order"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_note" ADD CONSTRAINT "order_note_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_note" ADD CONSTRAINT "order_note_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "sales_order"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_note" ADD CONSTRAINT "order_note_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_message_template" ADD CONSTRAINT "gift_message_template_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer" ADD CONSTRAINT "printer_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer" ADD CONSTRAINT "printer_company_id_location_id_fkey" FOREIGN KEY ("company_id", "location_id") REFERENCES "location"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_mapping" ADD CONSTRAINT "printer_mapping_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_mapping" ADD CONSTRAINT "printer_mapping_company_id_location_id_fkey" FOREIGN KEY ("company_id", "location_id") REFERENCES "location"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_mapping" ADD CONSTRAINT "printer_mapping_company_id_printer_id_fkey" FOREIGN KEY ("company_id", "printer_id") REFERENCES "printer"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_company_id_printer_id_fkey" FOREIGN KEY ("company_id", "printer_id") REFERENCES "printer"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_company_id_file_id_fkey" FOREIGN KEY ("company_id", "file_id") REFERENCES "stored_file"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_company_id_reprint_of_id_fkey" FOREIGN KEY ("company_id", "reprint_of_id") REFERENCES "print_job"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_queue_job_id_fkey" FOREIGN KEY ("queue_job_id") REFERENCES "job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

