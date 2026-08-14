export class Decimal {
  private constructor(
    private readonly coefficient: bigint,
    private readonly scale: number,
  ) {}

  static parse(value: string | number | bigint): Decimal {
    const source = String(value).trim();
    const match = source.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) throw new Error(`invalid_decimal:${source}`);
    const sign = match[1] === "-" ? -1n : 1n;
    const fraction = match[3] ?? "";
    const coefficient = sign * BigInt(`${match[2]}${fraction}`);
    return new Decimal(coefficient, fraction.length).normalize();
  }

  static zero(): Decimal {
    return new Decimal(0n, 0);
  }

  add(other: Decimal): Decimal {
    const [left, right, scale] = this.align(other);
    return new Decimal(left + right, scale).normalize();
  }

  subtract(other: Decimal): Decimal {
    const [left, right, scale] = this.align(other);
    return new Decimal(left - right, scale).normalize();
  }

  negate(): Decimal {
    return new Decimal(-this.coefficient, this.scale);
  }

  multiply(other: Decimal): Decimal {
    return new Decimal(this.coefficient * other.coefficient, this.scale + other.scale).normalize();
  }

  divideByInteger(divisor: bigint, precision = 18): Decimal {
    if (divisor === 0n) throw new Error("division_by_zero");
    const expanded = this.coefficient * powerOfTen(precision);
    const quotient = divideRoundedHalfAwayFromZero(expanded, divisor);
    return new Decimal(quotient, this.scale + precision).normalize();
  }

  divideByIntegerCeilToScale(divisor: bigint, targetScale: number): Decimal {
    if (divisor <= 0n)
      throw new Error(divisor === 0n ? "division_by_zero" : "positive_divisor_required");
    if (!Number.isSafeInteger(targetScale) || targetScale < 0 || targetScale > 100) {
      throw new Error("invalid_decimal_scale");
    }
    const numerator = this.coefficient * powerOfTen(targetScale);
    const denominator = divisor * powerOfTen(this.scale);
    let quotient = numerator / denominator;
    if (numerator > 0n && numerator % denominator !== 0n) quotient += 1n;
    return new Decimal(quotient, targetScale).normalize();
  }

  divide(other: Decimal, precision = 18): Decimal {
    if (other.coefficient === 0n) throw new Error("division_by_zero");
    const numerator = this.coefficient * powerOfTen(precision + other.scale);
    const denominator = other.coefficient * powerOfTen(this.scale);
    return new Decimal(
      divideRoundedHalfAwayFromZero(numerator, denominator),
      precision,
    ).normalize();
  }

  ceil(): bigint {
    if (this.scale === 0) return this.coefficient;
    const divisor = powerOfTen(this.scale);
    const quotient = this.coefficient / divisor;
    const remainder = this.coefficient % divisor;
    return remainder > 0n ? quotient + 1n : quotient;
  }

  round(): bigint {
    if (this.scale === 0) return this.coefficient;
    return divideRoundedHalfAwayFromZero(this.coefficient, powerOfTen(this.scale));
  }

  truncate(): bigint {
    return this.scale === 0 ? this.coefficient : this.coefficient / powerOfTen(this.scale);
  }

  roundToScale(targetScale: number, mode: "half_up" | "ceiling" | "floor"): Decimal {
    if (!Number.isSafeInteger(targetScale) || targetScale < -100 || targetScale > 100) {
      throw new Error("invalid_decimal_scale");
    }
    const shift = this.scale - targetScale;
    if (shift <= 0) return this;
    const divisor = powerOfTen(shift);
    let quotient = this.coefficient / divisor;
    const remainder = this.coefficient % divisor;
    if (remainder !== 0n) {
      if (mode === "half_up") {
        const absoluteRemainder = remainder < 0n ? -remainder : remainder;
        if (absoluteRemainder * 2n >= divisor) quotient += this.coefficient < 0n ? -1n : 1n;
      } else if (mode === "ceiling" && this.coefficient > 0n) {
        quotient += 1n;
      } else if (mode === "floor" && this.coefficient < 0n) {
        quotient -= 1n;
      }
    }
    return targetScale >= 0
      ? new Decimal(quotient, targetScale).normalize()
      : new Decimal(quotient * powerOfTen(-targetScale), 0).normalize();
  }

  compare(other: Decimal): number {
    const [left, right] = this.align(other);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  isNegative(): boolean {
    return this.coefficient < 0n;
  }

  ceilDividePositive(other: Decimal): bigint {
    const [left, right] = this.align(other);
    if (left < 0n || right <= 0n) throw new Error("positive_decimal_required");
    return left === 0n ? 0n : (left + right - 1n) / right;
  }

  toString(): string {
    if (this.scale === 0) return this.coefficient.toString();
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, "0");
    const split = digits.length - this.scale;
    return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
  }

  private normalize(): Decimal {
    if (this.coefficient === 0n) return Decimal.zero();
    let coefficient = this.coefficient;
    let scale = this.scale;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale -= 1;
    }
    return coefficient === this.coefficient && scale === this.scale
      ? this
      : new Decimal(coefficient, scale);
  }

  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [
      this.coefficient * powerOfTen(scale - this.scale),
      other.coefficient * powerOfTen(scale - other.scale),
      scale,
    ];
  }
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 200) {
    throw new Error("invalid_decimal_scale");
  }
  return 10n ** BigInt(exponent);
}

function divideRoundedHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  if (absoluteRemainder * 2n < absoluteDenominator) return quotient;
  return quotient + (numerator < 0n !== denominator < 0n ? -1n : 1n);
}
