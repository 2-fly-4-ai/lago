import { DurableObject } from "cloudflare:workers";

export type ReservationRequest = {
  idempotencyKey: string;
  commandType: string;
  requestHash: string;
};

export type Reservation = ReservationRequest & {
  status: "reserved" | "completed";
  responseJson: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ReservationResult =
  | { ok: true; reservation: Reservation; replayed: boolean }
  | { ok: false; error: "invalid_reservation" | "idempotency_key_conflict" };

export type ReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; error: "reservation_not_found" | "reservation_already_completed" };

export class BillingAccount extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  reserveCommand(input: ReservationRequest): ReservationResult {
    if (!input.idempotencyKey || !input.commandType || !input.requestHash) {
      return { ok: false, error: "invalid_reservation" };
    }

    const existing = this.read(input.idempotencyKey);
    if (existing) {
      if (
        existing.commandType !== input.commandType ||
        existing.requestHash !== input.requestHash
      ) {
        return { ok: false, error: "idempotency_key_conflict" };
      }
      return { ok: true, reservation: existing, replayed: true };
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO command_reservations
       (idempotency_key, command_type, request_hash, status, response_json, created_at, completed_at)
       VALUES (?, ?, ?, 'reserved', NULL, ?, NULL)`,
      input.idempotencyKey,
      input.commandType,
      input.requestHash,
      now,
    );

    const reservation = this.read(input.idempotencyKey);
    if (!reservation) throw new Error("reservation_persistence_error");
    return { ok: true, reservation, replayed: false };
  }

  completeCommand(
    idempotencyKey: string,
    response: unknown,
  ): { reservation: Reservation; replayed: boolean } {
    const existing = this.read(idempotencyKey);
    if (!existing) throw new Error("reservation_not_found");

    if (existing.status === "completed") {
      return { reservation: existing, replayed: true };
    }

    this.ctx.storage.sql.exec(
      `UPDATE command_reservations
       SET status = 'completed', response_json = ?, completed_at = ?
       WHERE idempotency_key = ? AND status = 'reserved'`,
      JSON.stringify(response ?? null),
      new Date().toISOString(),
      idempotencyKey,
    );

    const reservation = this.read(idempotencyKey);
    if (!reservation) throw new Error("reservation_persistence_error");
    return { reservation, replayed: false };
  }

  getCommand(idempotencyKey: string): Reservation | null {
    return this.read(idempotencyKey);
  }

  releaseCommand(idempotencyKey: string, requestHash: string): ReleaseResult {
    const existing = this.read(idempotencyKey);
    if (!existing) return { ok: false, error: "reservation_not_found" };
    if (existing.status === "completed")
      return { ok: false, error: "reservation_already_completed" };
    if (existing.requestHash !== requestHash) return { ok: false, error: "reservation_not_found" };
    this.ctx.storage.sql.exec(
      "DELETE FROM command_reservations WHERE idempotency_key = ? AND request_hash = ? AND status = 'reserved'",
      idempotencyKey,
      requestHash,
    );
    return { ok: true, released: true };
  }

  private read(idempotencyKey: string): Reservation | null {
    const rows = this.ctx.storage.sql.exec<{
      idempotency_key: string;
      command_type: string;
      request_hash: string;
      status: "reserved" | "completed";
      response_json: string | null;
      created_at: string;
      completed_at: string | null;
    }>(
      `SELECT idempotency_key, command_type, request_hash, status, response_json, created_at, completed_at
       FROM command_reservations WHERE idempotency_key = ?`,
      idempotencyKey,
    );
    const row = [...rows][0];

    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      commandType: row.command_type,
      requestHash: row.request_hash,
      status: row.status,
      responseJson: row.response_json,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;
    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS command_reservations (
          idempotency_key TEXT PRIMARY KEY,
          command_type TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('reserved', 'completed')),
          response_json TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        ) STRICT;
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, datetime('now'));
      `);
    }
  }
}
