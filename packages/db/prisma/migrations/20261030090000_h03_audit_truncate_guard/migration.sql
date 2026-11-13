-- H-03: TRUNCATE skips row triggers, so it gets past audit_event_no_update_delete.
-- refuse_truncate() is the function from 20261027193000_r2c_truncate_guard.
-- These tables already refuse TRUNCATE:
--   stored_file, invoice, invoice_line, invoice_tax_summary, invoice_delivery
--     (20261027193000_r2c_truncate_guard)
--   payment, allocation, refund
--     (20261029090000_r2e_payments)
-- Also guarded here:
--   audit_event is append-only for every role. The application never deletes its rows.
--   idempotency_record is append-only retry evidence; emptying it would let a key be reused.
--   client_import keeps each preview (status changes; rows are not deleted). TRUNCATE was
--     only revoked from bp_app, so the owner could still empty it.
--   print_job holds the request key and the first-print row. Production never deletes
--     those rows. Test cleanup deletes them with DELETE, which a TRUNCATE trigger does
--     not affect. Without this guard the owner could TRUNCATE print_job, and a retried
--     request with the same request key would print again.
-- A restore loads an empty database with pg_restore and never truncates.

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER idempotency_record_no_truncate
  BEFORE TRUNCATE ON "idempotency_record"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER client_import_no_truncate
  BEFORE TRUNCATE ON "client_import"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();

CREATE TRIGGER print_job_no_truncate
  BEFORE TRUNCATE ON "print_job"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_truncate();
