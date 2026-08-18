import { ApiError, json, objectAt, parseJsonObject, requiredString } from "../http";
import type { OperatorContext } from "./access";

type AiBinding = {
  run(
    model: string,
    input: { messages: AiPromptMessage[]; stream: true; max_tokens: number; temperature: number },
  ): Promise<ReadableStream<Uint8Array> | { response?: string }>;
};

type AiPromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ConversationRow = {
  id: string;
  title: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  messages_count: number;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type OperatorAiEnv = {
  AI?: AiBinding;
  AI_MODEL?: string;
};

export async function handleOperatorAiRequest(
  request: Request,
  env: OperatorAiEnv & { BILLING_DB: D1Database },
  operator: OperatorContext,
  requestId: string,
  executionContext?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/operator\/v1\/ai\/conversations(?:\/|$)/.test(url.pathname)) return null;

  if (url.pathname === "/api/operator/v1/ai/conversations") {
    if (request.method === "GET") {
      return listConversations(url, env.BILLING_DB, operator, requestId);
    }
    if (request.method === "POST") {
      return createConversation(request, env.BILLING_DB, operator, requestId);
    }
  }
  const messageMatch = url.pathname.match(
    /^\/api\/operator\/v1\/ai\/conversations\/([^/]+)\/messages$/,
  );
  if (messageMatch?.[1] && request.method === "POST") {
    return sendMessage(
      decodeURIComponent(messageMatch[1]),
      request,
      env,
      operator,
      requestId,
      executionContext,
    );
  }
  const conversationMatch = url.pathname.match(/^\/api\/operator\/v1\/ai\/conversations\/([^/]+)$/);
  if (conversationMatch?.[1] && request.method === "GET") {
    return showConversation(
      decodeURIComponent(conversationMatch[1]),
      env.BILLING_DB,
      operator,
      requestId,
    );
  }
  return null;
}

async function listConversations(
  url: URL,
  database: D1Database,
  operator: OperatorContext,
  requestId: string,
): Promise<Response> {
  const limit = boundedLimit(url.searchParams.get("limit"));
  const result = await database
    .prepare(
      `SELECT conversation.id, conversation.title, conversation.status,
              conversation.created_at, conversation.updated_at,
              COUNT(message.id) AS messages_count
       FROM ai_conversations conversation
       LEFT JOIN ai_messages message ON message.conversation_id = conversation.id
       WHERE conversation.organization_id = ? AND conversation.operator_membership_id = ?
         AND conversation.status = 'active'
       GROUP BY conversation.id
       ORDER BY conversation.updated_at DESC, conversation.id DESC LIMIT ?`,
    )
    .bind(operator.organizationId, operator.membershipId, limit)
    .all<ConversationRow>();
  return json({ conversations: result.results.map(serializeConversation) }, { requestId });
}

async function createConversation(
  request: Request,
  database: D1Database,
  operator: OperatorContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = objectAt(body, "conversation");
  const titleValue = input.title;
  const title =
    typeof titleValue === "string" && titleValue.trim()
      ? titleValue.trim().slice(0, 160)
      : "New conversation";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO ai_conversations
       (id, organization_id, operator_membership_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(id, operator.organizationId, operator.membershipId, title, now, now)
    .run();
  return json(
    {
      conversation: {
        lago_id: id,
        title,
        status: "active",
        messages_count: 0,
        created_at: now,
        updated_at: now,
        messages: [],
      },
    },
    { requestId, status: 201 },
  );
}

async function showConversation(
  conversationId: string,
  database: D1Database,
  operator: OperatorContext,
  requestId: string,
): Promise<Response> {
  const conversation = await findConversation(database, operator, conversationId);
  if (!conversation) {
    throw new ApiError(404, "ai_conversation_not_found", "Conversation was not found");
  }
  const messages = await loadMessages(database, operator.organizationId, conversationId, 100);
  return json(
    {
      conversation: {
        ...serializeConversation(conversation),
        messages: messages.map(serializeMessage),
      },
    },
    { requestId },
  );
}

async function sendMessage(
  conversationId: string,
  request: Request,
  env: OperatorAiEnv & { BILLING_DB: D1Database },
  operator: OperatorContext,
  requestId: string,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const conversation = await findConversation(env.BILLING_DB, operator, conversationId);
  if (!conversation) {
    throw new ApiError(404, "ai_conversation_not_found", "Conversation was not found");
  }
  if (!env.AI) {
    throw new ApiError(503, "operator_ai_unavailable", "The Lago assistant is not configured");
  }
  const body = await parseJsonObject(request);
  const input = objectAt(body, "message");
  const content = requiredString(input, "content");
  if (content.length > 8_000) {
    throw new ApiError(
      422,
      "validation_error",
      "Assistant messages cannot exceed 8,000 characters",
    );
  }
  const now = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  const nextTitle =
    conversation.title === "New conversation" ? content.slice(0, 80) : conversation.title;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO ai_messages (id, organization_id, conversation_id, role, content, created_at)
         VALUES (?, ?, ?, 'user', ?, ?)`,
    ).bind(userMessageId, operator.organizationId, conversationId, content, now),
    env.BILLING_DB.prepare(
      `UPDATE ai_conversations SET title = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND operator_membership_id = ? AND status = 'active'`,
    ).bind(nextTitle, now, conversationId, operator.organizationId, operator.membershipId),
  ]);

  const history = await loadMessages(env.BILLING_DB, operator.organizationId, conversationId, 24);
  const context = await assistantContext(env.BILLING_DB, operator);
  const prompt: AiPromptMessage[] = [
    { role: "system", content: systemPrompt(operator.organizationName, context) },
    ...history.map((message) => ({ role: message.role, content: message.content })),
  ];
  const result = await env.AI.run(env.AI_MODEL?.trim() || "@cf/zai-org/glm-4.7-flash", {
    messages: prompt,
    stream: true,
    max_tokens: 1_200,
    temperature: 0.2,
  });

  if (!(result instanceof ReadableStream)) {
    const response = result.response?.trim();
    if (!response)
      throw new ApiError(
        503,
        "operator_ai_empty_response",
        "The Lago assistant returned no response",
      );
    await persistAssistantMessage(
      env.BILLING_DB,
      operator.organizationId,
      conversationId,
      response,
    );
    return sseResponse(response, conversationId, requestId);
  }

  const [clientStream, persistenceStream] = result.tee();
  const persistence = persistStreamedAssistant(
    persistenceStream,
    env.BILLING_DB,
    operator.organizationId,
    conversationId,
  );
  if (executionContext) executionContext.waitUntil(persistence);
  else await persistence;
  return new Response(clientStream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-AI-Conversation-Id": conversationId,
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function findConversation(
  database: D1Database,
  operator: OperatorContext,
  conversationId: string,
): Promise<ConversationRow | null> {
  return database
    .prepare(
      `SELECT conversation.id, conversation.title, conversation.status,
              conversation.created_at, conversation.updated_at,
              COUNT(message.id) AS messages_count
       FROM ai_conversations conversation
       LEFT JOIN ai_messages message ON message.conversation_id = conversation.id
       WHERE conversation.id = ? AND conversation.organization_id = ?
         AND conversation.operator_membership_id = ? AND conversation.status = 'active'
       GROUP BY conversation.id`,
    )
    .bind(conversationId, operator.organizationId, operator.membershipId)
    .first<ConversationRow>();
}

async function loadMessages(
  database: D1Database,
  organizationId: string,
  conversationId: string,
  limit: number,
): Promise<MessageRow[]> {
  const result = await database
    .prepare(
      `SELECT id, role, content, created_at FROM (
         SELECT id, role, content, created_at FROM ai_messages
         WHERE organization_id = ? AND conversation_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) ORDER BY created_at, id`,
    )
    .bind(organizationId, conversationId, limit)
    .all<MessageRow>();
  return result.results;
}

async function assistantContext(database: D1Database, operator: OperatorContext): Promise<string> {
  const results = await database.batch([
    database
      .prepare("SELECT COUNT(*) AS count FROM customers WHERE organization_id = ?")
      .bind(operator.organizationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM subscriptions
         WHERE organization_id = ? AND status IN ('active', 'past_due')`,
      )
      .bind(operator.organizationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total_due_minor), 0) AS amount_minor
         FROM invoices WHERE organization_id = ? AND status = 'finalized'`,
      )
      .bind(operator.organizationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM billable_metrics
         WHERE organization_id = ? AND active = 1`,
      )
      .bind(operator.organizationId),
  ]);
  const customers = results[0]?.results[0] as unknown as { count: number };
  const subscriptions = results[1]?.results[0] as unknown as { count: number };
  const invoices = results[2]?.results[0] as unknown as { count: number; amount_minor: number };
  const metrics = results[3]?.results[0] as unknown as { count: number };
  return JSON.stringify({
    customers: Number(customers?.count) || 0,
    active_subscriptions: Number(subscriptions?.count) || 0,
    finalized_invoices: Number(invoices?.count) || 0,
    finalized_invoice_amount_minor: Number(invoices?.amount_minor) || 0,
    billable_metrics: Number(metrics?.count) || 0,
  });
}

function systemPrompt(organizationName: string, aggregateContext: string): string {
  return [
    "You are Lago Assistant, a concise read-only billing operations assistant.",
    `You are scoped only to the organization ${JSON.stringify(organizationName)}.`,
    "Never claim to change billing data, send invoices, contact customers, or call providers.",
    "Explain calculations, identify likely operational follow-ups, and say when the available aggregate context is insufficient.",
    `Current tenant-scoped aggregate context: ${aggregateContext}`,
  ].join("\n");
}

async function persistStreamedAssistant(
  stream: ReadableStream<Uint8Array>,
  database: D1Database,
  organizationId: string,
  conversationId: string,
): Promise<void> {
  const text = await collectSseResponse(stream);
  if (text.trim())
    await persistAssistantMessage(database, organizationId, conversationId, text.trim());
}

async function collectSseResponse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let response = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) response += responseFromSseLine(line);
      if (done) break;
    }
    if (buffer) response += responseFromSseLine(buffer);
  } finally {
    reader.releaseLock();
  }
  return response;
}

function responseFromSseLine(line: string): string {
  if (!line.startsWith("data:")) return "";
  const value = line.slice(5).trim();
  if (!value || value === "[DONE]") return "";
  try {
    const parsed = JSON.parse(value) as { response?: unknown };
    return typeof parsed.response === "string" ? parsed.response : "";
  } catch {
    return "";
  }
}

async function persistAssistantMessage(
  database: D1Database,
  organizationId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO ai_messages (id, organization_id, conversation_id, role, content, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      )
      .bind(crypto.randomUUID(), organizationId, conversationId, content.slice(0, 32_000), now),
    database
      .prepare(
        `UPDATE ai_conversations SET updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
      )
      .bind(now, conversationId, organizationId),
  ]);
}

function sseResponse(content: string, conversationId: string, requestId: string): Response {
  const body = `data: ${JSON.stringify({ response: content })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-AI-Conversation-Id": conversationId,
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function serializeConversation(row: ConversationRow) {
  return {
    lago_id: row.id,
    title: row.title,
    status: row.status,
    messages_count: Number(row.messages_count) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeMessage(row: MessageRow) {
  return {
    lago_id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
  };
}

function boundedLimit(value: string | null): number {
  if (!value) return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new ApiError(422, "validation_error", "limit is invalid");
  }
  return parsed;
}
