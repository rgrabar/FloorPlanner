// A tiny, safe expression language for furniture models. Never uses eval.
// tools/furniture.py implements exactly the same rules in Python; keep them in step.
//
//   numbers      12, 2.5, .5
//   strings      'wood' or "wood"
//   variables    $W  $shelfMat  $v  $i
//   arithmetic   + - * /  and ( )
//   comparisons  == != < > <= >=
//   logic        && || !
//
// Precedence, low to high: ||, &&, comparisons, + -, * /, unary - !, atoms.

export type Value = number | string | boolean

export class ExprError extends Error {}

type Token = { kind: 'num'; value: number } | { kind: 'str'; value: string } | { kind: 'var'; value: string } | { kind: 'op'; value: string }

const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||']
const ONE_CHAR_OPS = '+-*/()<>!'

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const rest = src.slice(i)
    const num = /^(\d+\.?\d*|\.\d+)/.exec(rest)
    if (num) {
      tokens.push({ kind: 'num', value: parseFloat(num[0]) })
      i += num[0].length
      continue
    }
    const name = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
    if (name) {
      tokens.push({ kind: 'var', value: name[1] })
      i += name[0].length
      continue
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      if (end < 0) throw new ExprError(`Unclosed string in "${src}"`)
      tokens.push({ kind: 'str', value: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ kind: 'op', value: two })
      i += 2
      continue
    }
    if (ONE_CHAR_OPS.includes(c)) {
      tokens.push({ kind: 'op', value: c })
      i++
      continue
    }
    throw new ExprError(`Unexpected "${c}" in "${src}"`)
  }
  return tokens
}

export function evaluate(src: string, vars: Record<string, Value>): Value {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (...ops: string[]) => peek()?.kind === 'op' && ops.includes(peek()!.value as string)
  const num = (v: Value, op: string): number => {
    if (typeof v !== 'number') throw new ExprError(`"${op}" needs numbers in "${src}"`)
    return v
  }

  const or = (): Value => {
    let left = and()
    while (isOp('||')) {
      pos++
      const right = and()
      left = Boolean(left) || Boolean(right)
    }
    return left
  }
  const and = (): Value => {
    let left = compare()
    while (isOp('&&')) {
      pos++
      const right = compare()
      left = Boolean(left) && Boolean(right)
    }
    return left
  }
  const compare = (): Value => {
    const left = add()
    if (!isOp('==', '!=', '<', '>', '<=', '>=')) return left
    const op = tokens[pos++].value as string
    const right = add()
    if (op === '==') return left === right
    if (op === '!=') return left !== right
    const l = num(left, op)
    const r = num(right, op)
    return op === '<' ? l < r : op === '>' ? l > r : op === '<=' ? l <= r : l >= r
  }
  const add = (): Value => {
    let left = mul()
    while (isOp('+', '-')) {
      const op = tokens[pos++].value as string
      const right = mul()
      left = op === '+' ? num(left, op) + num(right, op) : num(left, op) - num(right, op)
    }
    return left
  }
  const mul = (): Value => {
    let left = unary()
    while (isOp('*', '/')) {
      const op = tokens[pos++].value as string
      const right = num(unary(), op)
      if (op === '/' && right === 0) throw new ExprError(`Division by zero in "${src}"`)
      left = op === '*' ? num(left, op) * right : num(left, op) / right
    }
    return left
  }
  const unary = (): Value => {
    if (isOp('-')) {
      pos++
      return -num(unary(), '-')
    }
    if (isOp('!')) {
      pos++
      return !unary()
    }
    return atom()
  }
  const atom = (): Value => {
    const t = tokens[pos++]
    if (!t) throw new ExprError(`Unexpected end of "${src}"`)
    if (t.kind === 'num' || t.kind === 'str') return t.value
    if (t.kind === 'var') {
      if (!(t.value in vars)) throw new ExprError(`Unknown variable $${t.value} in "${src}"`)
      return vars[t.value]
    }
    if (t.value === '(') {
      const v = or()
      if (!isOp(')')) throw new ExprError(`Missing ")" in "${src}"`)
      pos++
      return v
    }
    throw new ExprError(`Unexpected "${t.value}" in "${src}"`)
  }

  const result = or()
  if (pos < tokens.length) throw new ExprError(`Unexpected "${String(tokens[pos].value)}" in "${src}"`)
  return result
}

/** A numeric model field: a number, or an expression string giving a number. */
export function numberOf(field: number | string, vars: Record<string, Value>): number {
  if (typeof field === 'number') return field
  const v = evaluate(field, vars)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(`"${field}" is not a number`)
  return v
}
