export type TokenType =
  | 'Number' | 'String' | 'True' | 'False' | 'Null' | 'Identifier'
  | 'Let' | 'Const' | 'Func' | 'Return' | 'If' | 'Else' | 'For' | 'In' | 'While' | 'Break' | 'Continue'
  | 'New' | 'Scope' | 'OnEvent' | 'Try' | 'Catch' | 'Import'
  | '+' | '-' | '*' | '/' | '%' | '=' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||' | '!'
  | '(' | ')' | '{' | '}' | '[' | ']' | ',' | '.' | ';' | ':'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export class LexerError extends Error {
  override name = 'LexerError';
}

const KEYWORDS: Record<string, TokenType> = {
  let: 'Let', const: 'Const', func: 'Func', function: 'Func', return: 'Return', if: 'If', else: 'Else',
  for: 'For', in: 'In', while: 'While', break: 'Break', continue: 'Continue', new: 'New', Scope: 'Scope',
  OnEvent: 'OnEvent', try: 'Try', catch: 'Catch', import: 'Import', true: 'True', false: 'False', null: 'Null',
};

const TWO_CHAR = new Set(['==', '!=', '>=', '<=', '&&', '||']);
const ONE_CHAR = new Set(['+', '-', '*', '/', '%', '=', '>', '<', '!', '(', ')', '{', '}', '[', ']', ',', '.', ';', ':']);
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const at = (o = 0) => source[i + o] ?? '';
  const advance = () => {
    if (source[i] === '\n') {
      line++;
      col = 1;
    } else col++;
    i++;
  };
  const push = (type: TokenType, value: string, l: number, c: number) => tokens.push({ type, value, line: l, column: c });

  while (i < source.length) {
    const ch = at();
    const l = line;
    const c = col;
    if (ch === '/' && at(1) === '/') {
      while (i < source.length && at() !== '\n') advance();
      continue;
    }
    if (ch === '/' && at(1) === '*') {
      advance();
      advance();
      while (i < source.length && !(at() === '*' && at(1) === '/')) advance();
      if (i >= source.length) throw new LexerError(`Unterminated multi-line comment (started on line ${l})`);
      advance();
      advance();
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '"' || ch === "'") {
      advance();
      let out = '';
      while (i < source.length && at() !== ch) {
        if (at() === '\n' || at() === '\r') throw new LexerError(`Unterminated string literal on line ${l}: newline found before closing quote`);
        if (at() === '\\') {
          advance();
          if (i < source.length) {
            out += ESCAPES[at()] ?? at();
            advance();
          }
        } else {
          out += at();
          advance();
        }
      }
      if (i >= source.length) throw new LexerError(`Unterminated string literal on line ${l}: reached end of file before closing quote`);
      advance();
      push('String', out, l, c);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let num = '';
      let dot = false;
      while (i < source.length && (/[0-9]/.test(at()) || (at() === '.' && !dot && /[0-9]/.test(at(1))))) {
        if (at() === '.') dot = true;
        num += at();
        advance();
      }
      push('Number', num, l, c);
      continue;
    }
    if (/[\p{L}_]/u.test(ch)) {
      let id = '';
      while (i < source.length && /[\p{L}\p{N}_]/u.test(at())) {
        id += at();
        advance();
      }
      push(KEYWORDS[id] ?? 'Identifier', id, l, c);
      continue;
    }
    const two = ch + at(1);
    if (TWO_CHAR.has(two)) {
      advance();
      advance();
      push(two as TokenType, two, l, c);
      continue;
    }
    if (ONE_CHAR.has(ch)) {
      advance();
      push(ch as TokenType, ch, l, c);
      continue;
    }
    throw new LexerError(`Unrecognised character in source: ${ch} (line ${l}, column ${c})`);
  }
  tokens.push({ type: 'EOF', value: 'EndOfFile', line, column: col });
  return tokens;
}
