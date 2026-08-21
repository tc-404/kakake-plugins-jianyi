import { DEFAULT_TIME_PATTERN } from '../lib/time.js';
import type {
  KaBinaryOp,
  KaCond,
  KaCondOp,
  KaExpr,
  KaMeta,
  KaScriptAst,
  KaStmt,
  KaTemplatePart,
} from './types.js';

class ParseError extends Error {
  constructor(message: string, public line?: number) {
    super(line != null ? `第 ${line} 行: ${message}` : message);
    this.name = 'ParseError';
  }
}

/**
 * 注释（整行忽略，不影响排版）：
 * - 以 # / // / ； 开头的整行
 * - 行尾：字符串外的 # … 或 // …
 */
function stripLineComment(line: string): string {
  const trimmedStart = line.replace(/^\s+/, '');
  if (
    trimmedStart.startsWith('#')
    || trimmedStart.startsWith('//')
    || trimmedStart.startsWith('；')
  ) {
    return '';
  }

  let quote: '"' | '`' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
    if (ch === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unescapeString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1]!;
      if (n === 'n') {
        out += '\n';
        i++;
        continue;
      }
      if (n === 't') {
        out += '\t';
        i++;
        continue;
      }
      if (n === 'r') {
        out += '\r';
        i++;
        continue;
      }
      if (n === '\\') {
        out += '\\';
        i++;
        continue;
      }
      if (n === '"') {
        out += '"';
        i++;
        continue;
      }
      if (n === '`') {
        out += '`';
        i++;
        continue;
      }
      if (n === '{') {
        out += '{';
        i++;
        continue;
      }
      if (n === 'u' && i + 5 < raw.length) {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
      }
      out += n;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** 方括号 / 花括号槽内层：插件定义、取艾特、取括号、内置 */
function parseBracketInner(inner: string): KaExpr {
  const s = inner.trim();
  if (!s) throw new ParseError('内置值缺少名称');
  const pluginVar = s.match(/^插件定义\s*:\s*(.+)$/);
  if (pluginVar) {
    const name = pluginVar[1].trim();
    if (!name) throw new ParseError('[插件定义:] 缺少变量名');
    return { kind: 'plugin_var', name };
  }
  if (s === '取艾特') {
    return { kind: 'at_get', index: { kind: 'number', value: 0 } };
  }
  // 正式冒号；兼容旧分号
  const atGetNum = s.match(/^取艾特\s*[:;]\s*(\d+)$/);
  if (atGetNum) {
    return { kind: 'at_get', index: { kind: 'number', value: Number(atGetNum[1]) } };
  }
  const atGetIdent = s.match(/^取艾特\s*[:;]\s*([\u4e00-\u9fff\w]+)$/u);
  if (atGetIdent) {
    return { kind: 'at_get', index: { kind: 'ident', name: atGetIdent[1] } };
  }
  if (s === '取括号') {
    return { kind: 'capture_get', index: { kind: 'number', value: 0 } };
  }
  const capNum = s.match(/^取括号\s*:\s*(\d+)$/);
  if (capNum) {
    return { kind: 'capture_get', index: { kind: 'number', value: Number(capNum[1]) } };
  }
  const capIdent = s.match(/^取括号\s*:\s*([\u4e00-\u9fff\w]+)$/u);
  if (capIdent) {
    return { kind: 'capture_get', index: { kind: 'ident', name: capIdent[1] } };
  }

  // [获取群身份] / [获取群身份:自己|发言人|变量|openid]
  if (s === '获取群身份') {
    return { kind: 'group_role_get', target: 'speaker' };
  }
  const roleGet = s.match(/^获取群身份\s*:\s*(.+)$/u);
  if (roleGet) {
    const key = roleGet[1].trim();
    if (!key) throw new ParseError('[获取群身份:] 缺少目标');
    if (key === '自己') return { kind: 'group_role_get', target: 'self' };
    if (key === '发言人') return { kind: 'group_role_get', target: 'speaker' };
    if (/^[\u4e00-\u9fff\w]+$/u.test(key)) {
      return { kind: 'group_role_get', target: { kind: 'ident', name: key } };
    }
    throw new ParseError(`[获取群身份:] 无法识别目标: ${key}`);
  }
  if (s === '获取群信息') return { kind: 'group_info_get' };
  if (s === '获取机器人群状态') return { kind: 'group_bot_state_get' };
  if (s === '查询群禁言') return { kind: 'group_mute_query' };

  // [转时间:时间戳毫秒|时间戳秒,值] / [转时间:…,值,"模板"]（须在 [时间:…] 之前）
  if (/^转时间\s*:/.test(s)) {
    const head = s.match(/^转时间\s*:\s*(时间戳毫秒|时间戳秒)\s*,\s*([\s\S]+)$/);
    if (!head) {
      throw new ParseError(
        '转时间格式不正确（例：[转时间:时间戳毫秒,值] 或 [转时间:时间戳毫秒,值,"YYYY-MM-DD HH:mm:ss"]）',
      );
    }
    const unit: 'ms' | 's' = head[1] === '时间戳秒' ? 's' : 'ms';
    let rest = head[2].trim();
    let pattern = DEFAULT_TIME_PATTERN;
    const fmtTail = rest.match(/^([\s\S]*),\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (fmtTail) {
      rest = fmtTail[1].trim();
      pattern = fmtTail[2]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"');
    }
    if (!rest) throw new ParseError('[转时间:…] 缺少时间戳表达式');
    return {
      kind: 'time_from',
      unit,
      value: parseExpr(rest),
      pattern,
    };
  }

  if (s === '时间') {
    return { kind: 'time_get', mode: '' };
  }
  const timeMode = s.match(/^时间\s*:\s*(.+)$/);
  if (timeMode) {
    return { kind: 'time_get', mode: timeMode[1].trim() };
  }
  return { kind: 'builtin', name: s };
}

/**
 * 把字符串内容解析为 literal 或 template。
 * 支持 {名字} / ${名字}；另支持 {取括号:1} / {取艾特:i}；\{ 为字面 {
 */
function parseStringContent(raw: string): KaExpr {
  const parts: KaTemplatePart[] = [];
  let text = '';
  let i = 0;
  let hasSlot = false;

  const flushText = () => {
    if (text) {
      parts.push({ kind: 'text', value: text });
      text = '';
    }
  };

  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1]!;
      if (n === 'n') text += '\n';
      else if (n === 't') text += '\t';
      else if (n === 'r') text += '\r';
      else if (n === '\\') text += '\\';
      else if (n === '"') text += '"';
      else if (n === '`') text += '`';
      else if (n === '{') text += '{';
      else if (n === 'u' && i + 5 < raw.length && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        text += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      } else text += n;
      i += 2;
      continue;
    }

    // ${名字} 或 {名字} / {取括号:1} / {取艾特;i}
    if (c === '$' && raw[i + 1] === '{') {
      const close = raw.indexOf('}', i + 2);
      if (close < 0) throw new ParseError('字符串插值缺少 }');
      const inner = raw.slice(i + 2, close).trim();
      flushText();
      hasSlot = true;
      parts.push(slotFromInner(inner));
      i = close + 1;
      continue;
    }
    if (c === '{') {
      const close = raw.indexOf('}', i + 1);
      if (close < 0) throw new ParseError('字符串插值缺少 }');
      const inner = raw.slice(i + 1, close).trim();
      flushText();
      hasSlot = true;
      parts.push(slotFromInner(inner));
      i = close + 1;
      continue;
    }

    text += c;
    i++;
  }
  flushText();

  if (!hasSlot) {
    return { kind: 'literal', value: unescapeString(raw) };
  }
  return { kind: 'template', parts };
}

function slotFromInner(inner: string): KaTemplatePart {
  if (!inner) throw new ParseError('字符串插值 {} 为空');
  // 取艾特 / 取括号 / 时间 / 转时间（可带 :后缀）
  if (
    inner === '取艾特'
    || /^取艾特\s*[:;]/.test(inner)
    || inner === '取括号'
    || /^取括号\s*:/.test(inner)
    || inner === '时间'
    || /^时间\s*:/.test(inner)
    || /^转时间\s*:/.test(inner)
    || inner === '获取群身份'
    || /^获取群身份\s*:/.test(inner)
    || inner === '获取群信息'
    || inner === '获取机器人群状态'
    || inner === '查询群禁言'
  ) {
    return { kind: 'slot_expr', expr: parseBracketInner(inner) };
  }
  // 简单名：变量或内置
  if (/^[\u4e00-\u9fff\w]+$/u.test(inner)) {
    return { kind: 'slot', name: inner };
  }
  // 表达式：{回执[消息id]} / {1+2} / {转数字(1+2)} 等
  return { kind: 'slot_expr', expr: parseExpr(inner) };
}

/** 方括号是否为「拼接用内置/插件定义」（相对下标 m[1]） */
function looksLikeConcatBracket(src: string, pos: number): boolean {
  const m = src.slice(pos).match(/^\[\s*([^\]]*)\]/);
  if (!m) return false;
  const inner = m[1].trim();
  if (!inner) return false;
  if (inner.startsWith('插件定义')) return true;
  if (
    inner === '文本消息'
    || inner === '事件'
    || inner === '群号'
    || inner === '发言人'
    || inner === 'AppID'
    || inner === '消息ID'
    || inner === '取艾特数'
    || inner === '取括号'
    || inner === '时间'
  ) {
    return true;
  }
  if (inner === '取艾特' || /^取艾特\s*[:;]/.test(inner)) return true;
  if (/^取括号\s*:/.test(inner)) return true;
  if (/^时间\s*:/.test(inner)) return true;
  if (/^转时间\s*:/.test(inner)) return true;
  if (inner === '获取群身份' || /^获取群身份\s*:/.test(inner)) return true;
  if (inner === '获取群信息' || inner === '获取机器人群状态' || inner === '查询群禁言') return true;
  // 纯数字 / 普通变量名 → 下标，不是拼接
  if (/^\d+$/.test(inner) || /^[\u4e00-\u9fff\w]+$/u.test(inner)) return false;
  return false;
}

/** 算式表达式：数字 / 字符串 / 变量 / [内置] / + - * / / 括号 */
export function parseExpr(input: string): KaExpr {
  const s = input.trim();
  if (!s) throw new ParseError('空表达式');
  const p = new ExprParser(s);
  const expr = p.parseAdd();
  p.skipWs();
  if (!p.eof()) throw new ParseError(`表达式多余内容: ${s.slice(p.pos)}`);
  return expr;
}

class ExprParser {
  pos = 0;
  constructor(public readonly src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  peek(): string {
    return this.src[this.pos] || '';
  }

  parseAdd(): KaExpr {
    let left = this.parseMul();
    for (;;) {
      this.skipWs();
      const op = this.peek();
      if (op === '+' || op === '-') {
        this.pos++;
        const right = this.parseMul();
        left = { kind: 'binary', op: op as KaBinaryOp, left, right };
        continue;
      }
      // 紧挨拼接： "文字" [插件定义:加] / [文本消息] 等内置（非下标）
      if (op === '"' || op === '`') {
        const right = this.parseMul();
        left = { kind: 'binary', op: '+', left, right };
        continue;
      }
      if (op === '[' && looksLikeConcatBracket(this.src, this.pos)) {
        const right = this.parseMul();
        left = { kind: 'binary', op: '+', left, right };
        continue;
      }
      break;
    }
    return left;
  }

  parseMul(): KaExpr {
    let left = this.parseUnary();
    for (;;) {
      this.skipWs();
      const op = this.peek();
      if (op !== '*' && op !== '/') break;
      this.pos++;
      const right = this.parseUnary();
      left = { kind: 'binary', op: op as KaBinaryOp, left, right };
    }
    return left;
  }

  parseUnary(): KaExpr {
    this.skipWs();
    // 表达式前缀 [等待]，可与定义同用：x = [等待] 发消息(出)
    if (this.src.startsWith('[等待]', this.pos)) {
      this.pos += '[等待]'.length;
      this.skipWs();
      return { kind: 'await_expr', expr: this.parseUnary() };
    }
    if (this.peek() === '-') {
      this.pos++;
      return { kind: 'unary', op: '-', expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  /** 后缀：.match(/正则/flags) 与 [下标] */
  parsePostfix(): KaExpr {
    let left = this.parsePrimary();
    for (;;) {
      this.skipWs();
      if (this.src.startsWith('.match', this.pos)) {
        this.pos += '.match'.length;
        this.skipWs();
        if (this.peek() !== '(') throw new ParseError('.match 后缺少 (');
        this.pos++;
        this.skipWs();
        const re = this.parseRegexLiteral();
        this.skipWs();
        if (this.peek() !== ')') throw new ParseError('.match 后缺少 )');
        this.pos++;
        left = { kind: 'match', target: left, pattern: re.pattern, flags: re.flags };
        continue;
      }
      // m[1] / .match(...)[0]；内置 [文本消息] 留给拼接，不在这里吃掉
      if (this.peek() === '[' && !looksLikeConcatBracket(this.src, this.pos)) {
        this.pos++;
        this.skipWs();
        const index = this.parseAdd();
        this.skipWs();
        if (this.peek() !== ']') throw new ParseError('下标缺少 ]');
        this.pos++;
        left = { kind: 'index', target: left, index };
        continue;
      }
      break;
    }
    return left;
  }

  parseRegexLiteral(): { pattern: string; flags: string } {
    if (this.peek() !== '/') throw new ParseError('期望正则字面量 /.../');
    this.pos++;
    let pattern = '';
    while (!this.eof()) {
      const c = this.src[this.pos];
      if (c === '\\' && this.pos + 1 < this.src.length) {
        pattern += c + this.src[this.pos + 1];
        this.pos += 2;
        continue;
      }
      if (c === '/') {
        this.pos++;
        let flags = '';
        while (!this.eof() && /[gimsuy]/.test(this.peek())) {
          flags += this.peek();
          this.pos++;
        }
        return { pattern, flags };
      }
      pattern += c;
      this.pos++;
    }
    throw new ParseError('正则未闭合');
  }

  parsePrimary(): KaExpr {
    this.skipWs();
    if (this.eof()) throw new ParseError('表达式不完整');

    if (this.peek() === '(') {
      this.pos++;
      const inner = this.parseAdd();
      this.skipWs();
      if (this.peek() !== ')') throw new ParseError('缺少 )');
      this.pos++;
      return inner;
    }

    const ch = this.peek();
    if (ch === '"' || ch === '`') {
      const quote = ch;
      this.pos++;
      let raw = '';
      while (!this.eof()) {
        const c = this.src[this.pos];
        if (c === '\\' && this.pos + 1 < this.src.length) {
          raw += c + this.src[this.pos + 1];
          this.pos += 2;
          continue;
        }
        if (c === quote) {
          this.pos++;
          return parseStringContent(raw);
        }
        raw += c;
        this.pos++;
      }
      throw new ParseError('字符串未闭合');
    }

    if (ch === '[') {
      // 方括号内容需跳过字符串内的 ]，再交给 parseBracketInner
      let j = this.pos + 1;
      let q: '"' | '`' | null = null;
      let depth = 1;
      while (j < this.src.length && depth > 0) {
        const c = this.src[j]!;
        if (q) {
          if (c === '\\' && j + 1 < this.src.length) {
            j += 2;
            continue;
          }
          if (c === q) q = null;
          j++;
          continue;
        }
        if (c === '"' || c === '`') {
          q = c;
          j++;
          continue;
        }
        if (c === '[') depth++;
        else if (c === ']') depth--;
        j++;
      }
      if (depth !== 0) throw new ParseError('内置值缺少 ]');
      const inner = this.src.slice(this.pos + 1, j - 1).trim();
      this.pos = j;
      return parseBracketInner(inner);
    }

    if (/\d/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.src.length && /\d/.test(this.src[this.pos])) this.pos++;
      const n = Number(this.src.slice(start, this.pos));
      return { kind: 'number', value: n };
    }

    // 标识符（中文 / 字母数字下划线）；后跟 ( 则为函数调用表达式
    const idMatch = this.src.slice(this.pos).match(/^[\u4e00-\u9fff\w]+/u);
    if (idMatch) {
      const name = idMatch[0];
      this.pos += name.length;
      this.skipWs();
      if (this.peek() === '(') {
        this.pos++; // skip (
        const argsStart = this.pos;
        let depth = 1;
        let quote: '"' | '`' | null = null;
        while (!this.eof() && depth > 0) {
          const c = this.peek();
          if (quote) {
            if (c === '\\' && this.pos + 1 < this.src.length) {
              this.pos += 2;
              continue;
            }
            if (c === quote) quote = null;
            this.pos++;
            continue;
          }
          if (c === '"' || c === '`') {
            quote = c;
            this.pos++;
            continue;
          }
          if (c === '(') {
            depth++;
            this.pos++;
            continue;
          }
          if (c === ')') {
            depth--;
            if (depth === 0) break;
            this.pos++;
            continue;
          }
          this.pos++;
        }
        if (depth !== 0) throw new ParseError('函数调用缺少 )');
        const argsRaw = this.src.slice(argsStart, this.pos);
        this.pos++; // skip )
        return {
          kind: 'call_expr',
          name,
          args: parseCallArgs(argsRaw),
        };
      }
      if (name === 'true' || name === '真') return { kind: 'boolean', value: true };
      if (name === 'false' || name === '假') return { kind: 'boolean', value: false };
      return { kind: 'ident', name };
    }

    throw new ParseError(`无法解析表达式: ${this.src.slice(this.pos)}`);
  }
}

const OP_MAP: Record<string, KaCondOp> = {
  '==': 'eq',
  '!=': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  // 全角比较符
  '＞': 'gt',
  '＞＝': 'gte',
  '＜': 'lt',
  '＜＝': 'lte',
  '＝＝': 'eq',
};

/** 在括号/字符串外找到比较运算符，再分别 parseExpr；否则按真值表达式（如 .match） */
function parseCond(input: string): KaCond {
  const s = input.trim();
  let quote: '"' | '`' | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    // 跳过正则字面量 /.../，避免把正则里的 < > 当比较符
    if (ch === '/' && depth === 0) {
      i++;
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
          i += 2;
          continue;
        }
        if (s[i] === '/') {
          i++;
          while (i < s.length && /[gimsuy]/.test(s[i])) i++;
          i--;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    let opLen = 0;
    let opStr = '';
    if (
      s.startsWith('==', i)
      || s.startsWith('!=', i)
      || s.startsWith('>=', i)
      || s.startsWith('<=', i)
      || s.startsWith('＞＝', i)
      || s.startsWith('＜＝', i)
      || s.startsWith('＝＝', i)
    ) {
      opLen = 2;
      opStr = s.slice(i, i + 2);
    } else if (ch === '>' || ch === '<' || ch === '＞' || ch === '＜') {
      opLen = 1;
      opStr = ch;
    }
    if (!opLen) continue;

    const op = OP_MAP[opStr];
    if (!op) continue;
    const left = s.slice(0, i).trim();
    const right = s.slice(i + opLen).trim();
    if (!left || !right) throw new ParseError(`无法解析条件: ${s}`);
    return { kind: op, left: parseExpr(left), right: parseExpr(right) };
  }

  // 无比较符：整段当真值表达式，如 [文本消息].match(/测试6([\s\S]*)/)
  return { kind: 'truthy', expr: parseExpr(s) };
}

function parseCallArgs(argsRaw: string): KaExpr[] {
  const s = argsRaw.trim();
  if (!s) return [];
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | '`' | null = null;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') {
      paren++;
      buf += ch;
      continue;
    }
    if (ch === ')') {
      paren--;
      buf += ch;
      continue;
    }
    if (ch === '[') {
      bracket++;
      buf += ch;
      continue;
    }
    if (ch === ']') {
      bracket--;
      buf += ch;
      continue;
    }
    if (ch === ',' && paren === 0 && bracket === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => parseExpr(p));
}

const RE_TEMP_DEF = /^(?:\[临时定义\]|临时定义)\s+([\u4e00-\u9fff\w]+)\s*=\s*(.+)$/su;
const RE_GLOBAL_DEF = /^(?:\[全局定义\]|全局定义)\s+([\u4e00-\u9fff\w]+)\s*=\s*(.+)$/su;
const RE_IF_OPEN = /^\[如果\]\s*\((.+)\)\s*\{\s*$/s;
const RE_FOR_OPEN = /^\[For循环\]\s*\((.+)\)\s*\{\s*$/;
const RE_FANZHI_OPEN = /^\[反之\]\s*\{\s*$/;
const RE_BLOCK_CLOSE = /^\}(.*)$/;

type BlockResult = {
  stmts: KaStmt[];
  /** 闭合行的下一行下标 */
  nextIndex: number;
  /** 闭合行去掉注释后的原文（如 } 或 }[反之]{） */
  closeLine: string;
};

function parseBlock(lines: string[], startIndex: number): BlockResult {
  const stmts: KaStmt[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = stripLineComment(lines[i]).trim();
    const lineNo = i + 1;

    if (!line) {
      i++;
      continue;
    }

    const close = line.match(RE_BLOCK_CLOSE);
    if (close) {
      return { stmts, nextIndex: i + 1, closeLine: line };
    }

    try {
      const parsed = parseStmtAt(lines, i, line, lineNo);
      stmts.push(parsed.stmt);
      i = parsed.nextIndex;
    } catch (e) {
      if (e instanceof ParseError) throw e;
      throw new ParseError((e as Error).message, lineNo);
    }
  }

  throw new ParseError('缺少闭合 }');
}

type StmtParse = { stmt: KaStmt; nextIndex: number };

function parseIfAfterOpen(
  lines: string[],
  bodyStart: number,
  cond: KaCond,
): StmtParse {
  const thenBlock = parseBlock(lines, bodyStart);
  let elseBody: KaStmt[] | undefined;
  let nextIndex = thenBlock.nextIndex;

  const suffix = thenBlock.closeLine.replace(/^\}/, '').trim();
  if (suffix) {
    if (!RE_FANZHI_OPEN.test(suffix)) {
      throw new ParseError(`} 后无法识别: ${suffix}`);
    }
    const elseBlock = parseBlock(lines, thenBlock.nextIndex);
    elseBody = elseBlock.stmts;
    nextIndex = elseBlock.nextIndex;
    const elseSuffix = elseBlock.closeLine.replace(/^\}/, '').trim();
    if (elseSuffix) {
      throw new ParseError(`[反之] 块结束后多余内容: ${elseSuffix}`);
    }
  } else {
    // 下一非空行是否为 [反之]{
    let j = thenBlock.nextIndex;
    while (j < lines.length && !stripLineComment(lines[j]).trim()) j++;
    if (j < lines.length) {
      const peek = stripLineComment(lines[j]).trim();
      if (RE_FANZHI_OPEN.test(peek)) {
        const elseBlock = parseBlock(lines, j + 1);
        elseBody = elseBlock.stmts;
        nextIndex = elseBlock.nextIndex;
        const elseSuffix = elseBlock.closeLine.replace(/^\}/, '').trim();
        if (elseSuffix) {
          throw new ParseError(`[反之] 块结束后多余内容: ${elseSuffix}`);
        }
      }
    }
  }

  return {
    stmt: { kind: 'if', cond, body: thenBlock.stmts, elseBody },
    nextIndex,
  };
}

function parseForAfterOpen(
  lines: string[],
  bodyStart: number,
  cond: KaCond,
): StmtParse {
  const body = parseBlock(lines, bodyStart);
  const suffix = body.closeLine.replace(/^\}/, '').trim();
  if (suffix) {
    throw new ParseError(`[For循环] 块结束后多余内容: ${suffix}`);
  }
  return {
    stmt: { kind: 'for', cond, body: body.stmts },
    nextIndex: body.nextIndex,
  };
}

function parseStmtAt(lines: string[], index: number, line: string, lineNo: number): StmtParse {
  const ifMatch = line.match(RE_IF_OPEN);
  if (ifMatch) {
    return parseIfAfterOpen(lines, index + 1, parseCond(ifMatch[1]));
  }

  const forMatch = line.match(RE_FOR_OPEN);
  if (forMatch) {
    return parseForAfterOpen(lines, index + 1, parseCond(forMatch[1]));
  }

  if (line === '[结束]') {
    return { stmt: { kind: 'end' }, nextIndex: index + 1 };
  }
  if (line === '[跳过]') {
    return { stmt: { kind: 'continue' }, nextIndex: index + 1 };
  }
  if (line === '[中断]') {
    return { stmt: { kind: 'break' }, nextIndex: index + 1 };
  }

  const awaitDelay = line.match(/^\[等待:\s*(.+)\]\s*$/u);
  if (awaitDelay) {
    return {
      stmt: { kind: 'await', delayMs: parseExpr(awaitDelay[1].trim()) },
      nextIndex: index + 1,
    };
  }

  const awaitMatch = line.match(/^\[等待\](?:\s+(.+))?$/u);
  if (awaitMatch) {
    const raw = (awaitMatch[1] || '').trim();
    return {
      stmt: { kind: 'await', expr: raw ? parseExpr(raw) : undefined },
      nextIndex: index + 1,
    };
  }

  const globalDef = line.match(RE_GLOBAL_DEF);
  if (globalDef) {
    return {
      stmt: { kind: 'global_def', name: globalDef[1], expr: parseExpr(globalDef[2]) },
      nextIndex: index + 1,
    };
  }

  const tempDef = line.match(RE_TEMP_DEF);
  if (tempDef) {
    return {
      stmt: { kind: 'temp_def', name: tempDef[1], expr: parseExpr(tempDef[2]) },
      nextIndex: index + 1,
    };
  }

  const incMatch = line.match(/^([\u4e00-\u9fff\w]+)\s*\+\+\s*$/u);
  if (incMatch) {
    return { stmt: { kind: 'inc', name: incMatch[1] }, nextIndex: index + 1 };
  }

  const assignAdd = line.match(/^([\u4e00-\u9fff\w]+)\s*\+=\s*(.+)$/su);
  if (assignAdd) {
    return {
      stmt: { kind: 'assign_add', name: assignAdd[1], expr: parseExpr(assignAdd[2]) },
      nextIndex: index + 1,
    };
  }

  // 已有变量再赋值：风险 = "无" / 回 = 审批入群申请(...)
  const assign = line.match(/^([\u4e00-\u9fff\w]+)\s*=\s*(.+)$/su);
  if (assign) {
    return {
      stmt: { kind: 'assign', name: assign[1], expr: parseExpr(assign[2]) },
      nextIndex: index + 1,
    };
  }

  const callMatch = line.match(/^([\u4e00-\u9fff\w]+)\s*\((.*)\)\s*$/su);
  if (callMatch) {
    return {
      stmt: { kind: 'call', name: callMatch[1], args: parseCallArgs(callMatch[2]) },
      nextIndex: index + 1,
    };
  }

  throw new ParseError(`无法识别语句: ${line}`, lineNo);
}

/**
 * 合并跨行未闭合的 "…" / `…` 字符串，使多行 MD 等可写在临时定义里。
 * 须在 stripLineComment 之前调用，否则中间行的 # 会被当注释吃掉。
 */
function unclosedQuote(s: string): '"' | '`' | null {
  let quote: '"' | '`' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '`') quote = c;
  }
  return quote;
}

function mergeMultilineQuotedLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let combined = lines[i]!;
    while (unclosedQuote(combined) != null && i + 1 < lines.length) {
      i++;
      combined += `\n${lines[i]!}`;
    }
    out.push(combined);
    i++;
  }
  return out;
}

/** 字符串外未闭合的 ( 数量；用于把 按钮行(…)、发Markdown(…) 等跨行写法并成一句 */
function unclosedParenDepth(s: string): number {
  let depth = 0;
  let quote: '"' | '`' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * 合并跨行未闭合的函数括号，便于键盘/按钮等长参数换行书写。
 * 接在 mergeMultilineQuotedLines 之后；续行先去注释，空白/纯注释行跳过。
 */
function mergeMultilineParenLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let combined = lines[i]!;
    while (unclosedParenDepth(combined) > 0 && i + 1 < lines.length) {
      i++;
      const cont = stripLineComment(lines[i]!).trim();
      if (!cont) continue;
      combined += ` ${cont}`;
    }
    out.push(combined);
    i++;
  }
  return out;
}

export function parseKaSource(source: string): KaScriptAst {
  const lines = mergeMultilineParenLines(
    mergeMultilineQuotedLines(
      source.replace(/^\uFEFF/, '').split(/\r?\n/),
    ),
  );
  const meta: KaMeta = {};
  const topStmts: KaStmt[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = stripLineComment(lines[i]).trim();
    const lineNo = i + 1;
    if (!line) {
      i++;
      continue;
    }

    const style = line.match(/^\[风格标准\]\s*:\s*(.+)$/);
    if (style) {
      meta.style = style[1].trim();
      i++;
      continue;
    }

    try {
      const parsed = parseStmtAt(lines, i, line, lineNo);
      topStmts.push(parsed.stmt);
      i = parsed.nextIndex;
    } catch (e) {
      if (e instanceof ParseError && e.line != null) throw e;
      throw new ParseError((e as Error).message, lineNo);
    }
  }

  return { meta, stmts: topStmts };
}
