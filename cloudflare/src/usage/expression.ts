import { Decimal } from "../rating/decimal";

const MAX_EXPRESSION_LENGTH = 1024;
const MAX_TOKENS = 256;
const MAX_DEPTH = 32;
const MAX_FUNCTION_ARGUMENTS = 32;

type ExpressionValue = Decimal | string;
type ExpressionNode =
  | { type: "decimal"; value: Decimal }
  | { type: "string"; value: string }
  | { type: "variable"; attribute: "code" | "timestamp" }
  | { type: "property"; name: string }
  | { type: "unary"; value: ExpressionNode }
  | {
      type: "binary";
      operator: "+" | "-" | "*" | "/";
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { type: "function"; name: FunctionName; arguments: ExpressionNode[] };

type FunctionName = "ceil" | "concat" | "round" | "floor" | "least" | "greatest";
type Token =
  | { type: "decimal" | "string" | "identifier"; value: string }
  | { type: "symbol"; value: "+" | "-" | "*" | "/" | "(" | ")" | "," }
  | { type: "eof"; value: "" };

export type ExpressionEvent = {
  code: string;
  timestamp: string | number;
  properties: Record<string, unknown>;
};

export class UsageExpressionError extends Error {
  constructor(
    readonly code: "invalid_expression" | "expression_evaluation_failed",
    message: string,
  ) {
    super(message);
  }
}

export function validateUsageExpression(expression: string): void {
  parseUsageExpression(expression);
}

export function evaluateUsageExpression(expression: string, event: ExpressionEvent): string {
  const ast = parseUsageExpression(expression);
  try {
    return serializeResult(evaluate(ast, event, 0));
  } catch (error) {
    if (error instanceof UsageExpressionError) throw error;
    const message = error instanceof Error ? error.message : "Expression could not be evaluated";
    throw new UsageExpressionError("expression_evaluation_failed", message);
  }
}

function parseUsageExpression(expression: string): ExpressionNode {
  if (!expression || expression.length > MAX_EXPRESSION_LENGTH) {
    throw new UsageExpressionError("invalid_expression", "Expression is invalid");
  }
  try {
    return new Parser(tokenize(expression)).parse();
  } catch (error) {
    if (error instanceof UsageExpressionError) throw error;
    throw new UsageExpressionError("invalid_expression", "Expression is invalid");
  }
}

class Parser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode {
    const expression = this.parseAdditive(0);
    if (this.peek().type !== "eof") this.invalid();
    return expression;
  }

  private parseAdditive(depth: number): ExpressionNode {
    let node = this.parseMultiplicative(depth + 1);
    while (this.symbol("+") || this.symbol("-")) {
      const operator = this.take().value as "+" | "-";
      node = this.node({
        type: "binary",
        operator,
        left: node,
        right: this.parseMultiplicative(depth + 1),
      });
    }
    return node;
  }

  private parseMultiplicative(depth: number): ExpressionNode {
    let node = this.parseUnary(depth + 1);
    while (this.symbol("*") || this.symbol("/")) {
      const operator = this.take().value as "*" | "/";
      node = this.node({
        type: "binary",
        operator,
        left: node,
        right: this.parseUnary(depth + 1),
      });
    }
    return node;
  }

  private parseUnary(depth: number): ExpressionNode {
    this.checkDepth(depth);
    if (this.symbol("-")) {
      this.take();
      return this.node({ type: "unary", value: this.parseUnary(depth + 1) });
    }
    return this.parsePrimary(depth + 1);
  }

  private parsePrimary(depth: number): ExpressionNode {
    this.checkDepth(depth);
    const token = this.take();
    if (token.type === "decimal") {
      return this.node({ type: "decimal", value: Decimal.parse(token.value) });
    }
    if (token.type === "string") return this.node({ type: "string", value: token.value });
    if (token.type === "identifier") {
      if (this.symbol("(")) return this.parseFunction(token.value, depth + 1);
      if (token.value === "event.code") {
        return this.node({ type: "variable", attribute: "code" });
      }
      if (token.value === "event.timestamp") {
        return this.node({ type: "variable", attribute: "timestamp" });
      }
      const property = token.value.match(/^event\.properties\.([A-Za-z][A-Za-z0-9_]*)$/)?.[1];
      if (property) return this.node({ type: "property", name: property });
      this.invalid();
    }
    if (token.type === "symbol" && token.value === "(") {
      const expression = this.parseAdditive(depth + 1);
      this.expectSymbol(")");
      return expression;
    }
    this.invalid();
  }

  private parseFunction(rawName: string, depth: number): ExpressionNode {
    const name = normalizeFunctionName(rawName);
    this.expectSymbol("(");
    const arguments_: ExpressionNode[] = [];
    if (this.symbol(")")) this.invalid();
    while (true) {
      if (arguments_.length >= MAX_FUNCTION_ARGUMENTS) this.invalid();
      arguments_.push(this.parseAdditive(depth + 1));
      if (!this.symbol(",")) break;
      this.take();
    }
    this.expectSymbol(")");
    if ((name === "round" || name === "ceil" || name === "floor") && arguments_.length > 2) {
      this.invalid();
    }
    if ((name === "round" || name === "ceil" || name === "floor") && arguments_.length < 1) {
      this.invalid();
    }
    return this.node({ type: "function", name, arguments: arguments_ });
  }

  private node<T extends ExpressionNode>(node: T): T {
    this.nodes += 1;
    if (this.nodes > MAX_TOKENS) this.invalid();
    return node;
  }

  private checkDepth(depth: number): void {
    if (depth > MAX_DEPTH) this.invalid();
  }

  private symbol(value: Token["value"]): boolean {
    const token = this.peek();
    return token.type === "symbol" && token.value === value;
  }

  private expectSymbol(value: "(" | ")" | ","): void {
    if (!this.symbol(value)) this.invalid();
    this.take();
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { type: "eof", value: "" };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private invalid(): never {
    throw new UsageExpressionError("invalid_expression", "Expression is invalid");
  }
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (character === " ") {
      index += 1;
      continue;
    }
    if (character === "'") {
      const end = expression.indexOf("'", index + 1);
      if (end < 0) invalidExpression();
      tokens.push({ type: "string", value: expression.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[0-9]/.test(character)) {
      const match = expression.slice(index).match(/^\d+(?:\.\d+)?/);
      if (!match) invalidExpression();
      tokens.push({ type: "decimal", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(character)) {
      const match = expression.slice(index).match(/^[A-Za-z][A-Za-z0-9_.]*/);
      if (!match) invalidExpression();
      tokens.push({ type: "identifier", value: match[0] });
      index += match[0].length;
      continue;
    }
    if ("+-*/(),".includes(character)) {
      tokens.push({
        type: "symbol",
        value: character as Extract<Token, { type: "symbol" }>["value"],
      });
      index += 1;
      continue;
    }
    invalidExpression();
  }
  if (tokens.length > MAX_TOKENS) invalidExpression();
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function normalizeFunctionName(value: string): FunctionName {
  for (const name of ["ceil", "concat", "round", "floor", "least", "greatest"] as const) {
    if (value === name || value === name.toUpperCase() || value === capitalize(name)) return name;
  }
  return invalidExpression();
}

function evaluate(node: ExpressionNode, event: ExpressionEvent, depth: number): ExpressionValue {
  if (depth > MAX_DEPTH) return evaluationFailure("Expression is too deeply nested");
  if (node.type === "decimal" || node.type === "string") return node.value;
  if (node.type === "variable") {
    return node.attribute === "code" ? event.code : decimalValue(event.timestamp);
  }
  if (node.type === "property") return eventProperty(node.name, event.properties);
  if (node.type === "unary") return decimal(evaluate(node.value, event, depth + 1)).negate();
  if (node.type === "binary") {
    const left = decimal(evaluate(node.left, event, depth + 1));
    const right = decimal(evaluate(node.right, event, depth + 1));
    if (node.operator === "+") return left.add(right);
    if (node.operator === "-") return left.subtract(right);
    if (node.operator === "*") return left.multiply(right);
    return left.divide(right);
  }
  const values = node.arguments.map((argument) => evaluate(argument, event, depth + 1));
  if (node.name === "concat") return values.map(display).join("");
  if (node.name === "least" || node.name === "greatest") {
    const decimals = values.map(decimal);
    if (decimals.length === 0) return evaluationFailure("Expected non-empty argument list");
    return decimals.reduce((selected, value) => {
      const comparison = value.compare(selected);
      return node.name === "least"
        ? comparison < 0
          ? value
          : selected
        : comparison > 0
          ? value
          : selected;
    });
  }
  const value = decimal(values[0]!);
  const scaleValue = values[1];
  const scale = scaleValue === undefined ? 0 : Number(decimal(scaleValue).truncate());
  if (!Number.isSafeInteger(scale) || scale < -100 || scale > 100) {
    return evaluationFailure("Expected a decimal");
  }
  return value.roundToScale(
    scale,
    node.name === "round" ? "half_up" : node.name === "ceil" ? "ceiling" : "floor",
  );
}

function eventProperty(name: string, properties: Record<string, unknown>): ExpressionValue {
  if (!Object.hasOwn(properties, name)) {
    return evaluationFailure(`Variable: ${name} not found`);
  }
  return scalarValue(properties[name]);
}

function scalarValue(value: unknown): ExpressionValue {
  if (typeof value === "number") return decimalValue(value);
  if (typeof value === "string") {
    try {
      return Decimal.parse(value);
    } catch {
      return value;
    }
  }
  return evaluationFailure("Expected a decimal");
}

function decimalValue(value: string | number): Decimal {
  try {
    return Decimal.parse(value);
  } catch {
    return evaluationFailure("Expected a decimal");
  }
}

function decimal(value: ExpressionValue): Decimal {
  if (value instanceof Decimal) return value;
  return evaluationFailure("Expected a decimal");
}

function display(value: ExpressionValue): string {
  return value instanceof Decimal ? value.toString() : value;
}

function serializeResult(value: ExpressionValue): string {
  if (!(value instanceof Decimal)) return value;
  const result = value.toString();
  return result.includes(".") ? result : `${result}.0`;
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function invalidExpression(): never {
  throw new UsageExpressionError("invalid_expression", "Expression is invalid");
}

function evaluationFailure(message: string): never {
  throw new UsageExpressionError("expression_evaluation_failed", message);
}
