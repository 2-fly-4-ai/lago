export type DomainEvent = {
  id: string;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  causationId: string | null;
  correlationId: string;
  payload: Record<string, unknown>;
};

export function isDomainEvent(value: unknown): value is DomainEvent {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<DomainEvent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.version === "number" &&
    typeof candidate.aggregateType === "string" &&
    typeof candidate.aggregateId === "string" &&
    typeof candidate.aggregateVersion === "number" &&
    typeof candidate.occurredAt === "string" &&
    (candidate.causationId === null || typeof candidate.causationId === "string") &&
    typeof candidate.correlationId === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}
