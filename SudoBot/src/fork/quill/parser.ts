import type { Expr, Program, Stmt } from './ast.ts';
import type { Token, TokenType } from './lexer.ts';

export class ParseError extends Error {
  override name = 'ParseError';
}

export function parse(tokens: Token[]): Program {
  let pos = 0;
  const cur = () => tokens[Math.min(pos, tokens.length - 1)]!;
  const check = (...types: TokenType[]) => types.includes(cur().type);
  const describe = (t: Token) => (t.type === 'EOF' ? 'end of file' : t.type === 'Identifier' || t.type === 'Number' || t.type === 'String' ? `${t.type} "${t.value}"` : `"${t.value}"`);
  const expect = (type: TokenType, what?: string): Token => {
    const t = cur();
    if (t.type !== type) throw new ParseError(`Expected ${what ?? `"${type}"`}, but found ${describe(t)} on line ${t.line}`);
    pos++;
    return t;
  };
  const optionalSemicolon = () => {
    if (check(';')) pos++;
  };

  const block = (): Stmt[] => {
    expect('{');
    const out: Stmt[] = [];
    while (!check('}', 'EOF')) out.push(statement());
    expect('}');
    return out;
  };

  const commaList = <T>(close: TokenType, item: () => T): T[] => {
    const out: T[] = [];
    if (!check(close)) {
      do {
        if (check(',')) pos++;
        out.push(item());
      } while (check(','));
    }
    return out;
  };

  function statement(): Stmt {
    const t = cur();
    const at = { line: t.line, column: t.column };
    switch (t.type) {
      case 'Let':
      case 'Const': {
        pos++;
        const name = expect('Identifier', 'a variable name').value;
        expect('=');
        const value = expression();
        optionalSemicolon();
        return { kind: 'Let', name, value, isConst: t.type === 'Const', ...at };
      }
      case 'Func': {
        pos++;
        const name = expect('Identifier', 'a function name').value;
        expect('(');
        const params = commaList(')', () => expect('Identifier', 'a parameter name').value);
        expect(')');
        return { kind: 'Func', name, params, body: block(), ...at };
      }
      case 'Return': {
        pos++;
        const value = check(';', '}') ? null : expression();
        optionalSemicolon();
        return { kind: 'Return', value, ...at };
      }
      case 'If':
        return ifStatement();
      case 'While': {
        pos++;
        const condition = expression();
        return { kind: 'While', condition, body: block(), ...at };
      }
      case 'For': {
        pos++;
        const variable = expect('Identifier', 'a loop variable').value;
        expect('In', '"in"');
        const iterable = expression();
        return { kind: 'For', variable, iterable, body: block(), ...at };
      }
      case 'Break':
      case 'Continue':
        pos++;
        optionalSemicolon();
        return { kind: t.type, ...at };
      case 'Try': {
        pos++;
        const body = block();
        expect('Catch', '"catch"');
        const errorVar = expect('Identifier', 'an error variable name').value;
        return { kind: 'Try', body, errorVar, handler: block(), ...at };
      }
      case 'OnEvent': {
        pos++;
        expect('(');
        const event = expect('Identifier', 'an event name').value;
        expect(')');
        return { kind: 'OnEvent', event, body: block(), ...at };
      }
      default: {
        const expr = expression();
        optionalSemicolon();
        return { kind: 'Expr', expr, ...at };
      }
    }
  }

  function ifStatement(): Stmt {
    const t = expect('If');
    const condition = expression();
    const then = block();
    let otherwise: Stmt[] | null = null;
    if (check('Else')) {
      pos++;
      otherwise = check('If') ? [ifStatement()] : block();
    }
    return { kind: 'If', condition, then, else: otherwise, line: t.line, column: t.column };
  }

  const expression = (): Expr => assignment();

  function assignment(): Expr {
    const target = binary(0);
    if (check('=')) {
      const t = cur();
      pos++;
      return { kind: 'Assign', target, value: assignment(), line: t.line, column: t.column };
    }
    return target;
  }

  const LEVELS: TokenType[][] = [['||'], ['&&'], ['==', '!='], ['>', '>=', '<', '<='], ['+', '-'], ['*', '/', '%']];
  function binary(level: number): Expr {
    if (level >= LEVELS.length) return unary();
    let left = binary(level + 1);
    while (check(...LEVELS[level]!)) {
      const t = cur();
      pos++;
      left = { kind: 'Binary', left, op: t.value, right: binary(level + 1), line: t.line, column: t.column };
    }
    return left;
  }

  function unary(): Expr {
    if (check('!', '-')) {
      const t = cur();
      pos++;
      return { kind: 'Unary', op: t.value, operand: unary(), line: t.line, column: t.column };
    }
    return postfix();
  }

  function postfix(): Expr {
    let expr = primary();
    for (;;) {
      const t = cur();
      if (check('.')) {
        pos++;
        expr = { kind: 'Member', object: expr, property: expect('Identifier', 'a property name').value, line: t.line, column: t.column };
      } else if (check('[')) {
        pos++;
        const index = expression();
        expect(']');
        expr = { kind: 'Index', object: expr, index, line: t.line, column: t.column };
      } else if (check('(')) {
        pos++;
        const args = commaList(')', expression);
        expect(')');
        expr = { kind: 'Call', callee: expr, args, line: t.line, column: t.column };
      } else return expr;
    }
  }

  function primary(): Expr {
    const t = cur();
    const at = { line: t.line, column: t.column };
    switch (t.type) {
      case 'Number':
        pos++;
        return { kind: 'Number', value: Number(t.value), ...at };
      case 'String':
        pos++;
        return { kind: 'String', value: t.value, ...at };
      case 'True':
      case 'False':
        pos++;
        return { kind: 'Boolean', value: t.type === 'True', ...at };
      case 'Null':
        pos++;
        return { kind: 'Null', ...at };
      case 'Identifier':
        pos++;
        return { kind: 'Identifier', name: t.value, ...at };
      case '(': {
        pos++;
        const e = expression();
        expect(')');
        return e;
      }
      case '[': {
        pos++;
        const elements = commaList(']', expression);
        expect(']');
        return { kind: 'List', elements, ...at };
      }
      case '{': {
        pos++;
        const entries = commaList('}', () => {
          const k = cur();
          if (k.type !== 'Identifier' && k.type !== 'String') throw new ParseError(`Expected identifier or string as map key, but found ${describe(k)} on line ${k.line}`);
          pos++;
          expect(':');
          return { key: k.value, value: expression() };
        });
        expect('}');
        return { kind: 'Map', entries, ...at };
      }
      case 'New': {
        pos++;
        expect('Scope', '"Scope"');
        expect('(');
        const args = commaList(')', expression);
        expect(')');
        return { kind: 'NewScope', args, ...at };
      }
      default:
        throw new ParseError(`Unexpected ${describe(t)} on line ${t.line}`);
    }
  }

  const body: Stmt[] = [];
  while (!check('EOF')) body.push(statement());
  return { body };
}
