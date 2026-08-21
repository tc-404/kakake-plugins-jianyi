import {
  getStatementHandler,
  hasBuiltinValue,
  invokeCallExpr,
  resolveBuiltinValue,
} from './builtins.js';
import { formatDateByPattern, formatKaTime, parseTimestampToDate } from '../lib/time.js';
import {
  getAtAt,
  fetchBotGroupStateResult,
  fetchGroupInfoResult,
  fetchGroupMuteResult,
  resolveGroupMemberRole,
  setGroupMemberMuteResult,
} from './message.js';
import type { KaCond, KaExpr, KaExecEnv, KaLoopSignal, KaMessageContext, KaScriptAst, KaStmt } from './types.js';

const FOR_MAX_ITERATIONS = 10000;

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (!Array.isArray(v) && ('成功' in o || '消息id' in o)) {
      return `成功=${o.成功} 消息id=${o.消息id ?? ''} 条数=${o.条数 ?? ''} 错误=${o.错误 ?? ''}`;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

async function flushPending(env: KaExecEnv): Promise<void> {
  if (!env.pendingSends.length) return;
  const batch = env.pendingSends.splice(0, env.pendingSends.length);
  await Promise.all(batch);
}

function createEnv(ctx: KaMessageContext, scriptRel: string, globals: Map<string, unknown>): KaExecEnv {
  const locals = new Map<string, unknown>();

  const env: KaExecEnv = {
    ctx,
    globals,
    locals,
    scriptRel,
    ended: false,
    loopSignal: 'none',
    lastMatch: null,
    pendingSends: [],
    async resolveExpr(expr: KaExpr): Promise<unknown> {
      return evalExpr(expr, env);
    },
    getVar(name: string): unknown {
      if (locals.has(name)) return locals.get(name);
      return globals.get(name);
    },
    setVar(name: string, value: unknown, scope: 'temp' | 'global' | 'auto') {
      if (scope === 'temp') {
        locals.set(name, value);
        return;
      }
      if (scope === 'global') {
        globals.set(name, value);
        return;
      }
      if (locals.has(name)) locals.set(name, value);
      else if (globals.has(name)) globals.set(name, value);
      else locals.set(name, value);
    },
  };

  return env;
}

/** 比大小用的纯数字：必须是 number 类型（无引号字面量 / 运算结果），字符串一律不算 */
function isPureNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 去空白后尝试转成有限数字；失败返回 null */
export function coerceToFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, '');
    if (!s) return null;
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type CoerceOk = { ok: true; value: number };
type CoerceFail = { ok: false };
type CoerceResult = CoerceOk | CoerceFail;

/** 强制数字运算求值（转数字 用）；失败 ok=false */
async function evalExprCoercedNumber(expr: KaExpr, env: KaExecEnv): Promise<CoerceResult> {
  switch (expr.kind) {
    case 'number':
      return Number.isFinite(expr.value) ? { ok: true, value: expr.value } : { ok: false };
    case 'literal':
    case 'template':
    case 'builtin':
    case 'time_get':
    case 'time_from':
    case 'at_get':
    case 'capture_get':
    case 'match':
    case 'index':
    case 'call_expr':
    case 'await_expr':
    case 'ident':
    case 'plugin_var': {
      const v = await evalExpr(expr, env);
      const n = coerceToFiniteNumber(v);
      return n == null ? { ok: false } : { ok: true, value: n };
    }
    case 'unary': {
      if (expr.op !== '-') return { ok: false };
      const inner = await evalExprCoercedNumber(expr.expr, env);
      if (!inner.ok) return { ok: false };
      return { ok: true, value: -inner.value };
    }
    case 'binary': {
      const left = await evalExprCoercedNumber(expr.left, env);
      const right = await evalExprCoercedNumber(expr.right, env);
      if (!left.ok || !right.ok) return { ok: false };
      const a = left.value;
      const b = right.value;
      let r: number;
      if (expr.op === '+') r = a + b;
      else if (expr.op === '-') r = a - b;
      else if (expr.op === '*') r = a * b;
      else if (expr.op === '/') r = b === 0 ? 0 : a / b;
      else return { ok: false };
      return Number.isFinite(r) ? { ok: true, value: r } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

/** 转数字(表达式)：成功返回 number；失败返回普通求值的字符串 */
async function evalToNumber(args: KaExpr[], env: KaExecEnv): Promise<unknown> {
  if (args.length !== 1) {
    env.ctx.logger.warn?.(`[mkjianyi] 转数字() 需要恰好 1 个参数 @ ${env.scriptRel}`);
    return '';
  }
  const arg = args[0]!;
  const coerced = await evalExprCoercedNumber(arg, env);
  if (coerced.ok) return coerced.value;
  return asString(await evalExpr(arg, env));
}

async function evalExpr(expr: KaExpr, env: KaExecEnv): Promise<unknown> {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'template': {
      let out = '';
      for (const part of expr.parts) {
        if (part.kind === 'text') {
          out += part.value;
          continue;
        }
        if (part.kind === 'slot_expr') {
          out += asString(await evalExpr(part.expr, env));
          continue;
        }
        // slot：临时 → 全局 → 同名内置
        const name = part.name;
        if (env.locals.has(name)) {
          out += asString(env.locals.get(name));
          continue;
        }
        if (env.globals.has(name)) {
          out += asString(env.globals.get(name));
          continue;
        }
        if (hasBuiltinValue(name)) {
          out += asString(resolveBuiltinValue(name, env));
          continue;
        }
        env.ctx.logger.warn(`[mkjianyi] 插值未定义 {${name}} @ ${env.scriptRel}`);
        out += '';
      }
      return out;
    }
    case 'number':
      return expr.value;
    case 'boolean':
      return expr.value;
    case 'builtin': {
      if (!hasBuiltinValue(expr.name)) {
        env.ctx.logger.warn(`[mkjianyi] 未知内置值 [${expr.name}] @ ${env.scriptRel}`);
        return undefined;
      }
      return resolveBuiltinValue(expr.name, env);
    }
    case 'time_get':
      return formatKaTime(expr.mode);
    case 'time_from': {
      const raw = await evalExpr(expr.value, env);
      const d = parseTimestampToDate(expr.unit, raw);
      if (!d) {
        env.ctx.logger.warn?.(
          `[mkjianyi] 转时间失败：无效时间戳 ${String(raw)} @ ${env.scriptRel}`,
        );
        return '';
      }
      return formatDateByPattern(d, expr.pattern);
    }
    case 'at_get': {
      const rawIdx = await evalExpr(expr.index, env);
      const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx)
        ? Math.trunc(rawIdx)
        : Number(rawIdx);
      return getAtAt(env.ctx.event || {}, Number.isInteger(idx) ? idx : -1);
    }
    case 'group_role_get': {
      let target: 'speaker' | 'self' | string = 'speaker';
      if (expr.target === 'speaker' || expr.target === 'self') {
        target = expr.target;
      } else {
        const tExpr = expr.target;
        if (tExpr.kind === 'ident') {
          const name = tExpr.name;
          if (env.locals.has(name) || env.globals.has(name)) {
            target = String(env.getVar(name) ?? '');
          } else {
            // 未定义变量：把标识符当 openid 字面量
            target = name;
          }
        } else {
          target = String((await evalExpr(tExpr, env)) ?? '');
        }
      }
      return resolveGroupMemberRole(
        {
          event: env.ctx.event || {},
          callBotApi: env.ctx.callBotApi,
          logger: env.ctx.logger,
        },
        target,
      );
    }
    case 'group_info_get':
      return fetchGroupInfoResult({
        event: env.ctx.event || {},
        callBotApi: env.ctx.callBotApi,
        logger: env.ctx.logger,
      });
    case 'group_bot_state_get':
      return fetchBotGroupStateResult({
        event: env.ctx.event || {},
        callBotApi: env.ctx.callBotApi,
        logger: env.ctx.logger,
      });
    case 'group_mute_query':
      return fetchGroupMuteResult({
        event: env.ctx.event || {},
        callBotApi: env.ctx.callBotApi,
        logger: env.ctx.logger,
      });
    case 'match': {
      const text = asString(await evalExpr(expr.target, env));
      try {
        const re = new RegExp(expr.pattern, expr.flags);
        const m = text.match(re);
        if (m) env.lastMatch = m;
        return m;
      } catch (e) {
        env.ctx.logger.warn?.(
          `[mkjianyi] 正则无效 /${expr.pattern}/${expr.flags}:`,
          (e as Error)?.message || e,
        );
        return null;
      }
    }
    case 'capture_get': {
      const rawIdx = await evalExpr(expr.index, env);
      const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx)
        ? Math.trunc(rawIdx)
        : Number(rawIdx);
      if (!Number.isInteger(idx) || idx < 0) return '';
      const m = env.lastMatch;
      if (!m) return '';
      const v = m[idx];
      return v == null ? '' : v;
    }
    case 'index': {
      const target = await evalExpr(expr.target, env);
      // 对象字段：回执["消息id"] 或 回执[消息id]（无同名变量时按字段名）
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        let key: unknown;
        if (expr.index.kind === 'ident') {
          const name = expr.index.name;
          if (env.locals.has(name) || env.globals.has(name)) {
            key = env.getVar(name);
          } else {
            key = name;
          }
        } else {
          key = await evalExpr(expr.index, env);
        }
        if (typeof key === 'string' || typeof key === 'number') {
          const v = (target as Record<string, unknown>)[key as string];
          return v == null ? '' : v;
        }
        return '';
      }
      const rawIdx = await evalExpr(expr.index, env);
      const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx)
        ? Math.trunc(rawIdx)
        : Number(rawIdx);
      if (!Number.isInteger(idx) || idx < 0) return '';
      if (Array.isArray(target)) {
        const v = target[idx];
        return v == null ? '' : v;
      }
      if (typeof target === 'string') {
        return idx < target.length ? target[idx] : '';
      }
      return '';
    }
    case 'call_expr':
      if (expr.name === '转数字') return evalToNumber(expr.args, env);
      return invokeCallExpr(expr.name, expr.args, env);
    case 'await_expr': {
      let v = await evalExpr(expr.expr, env);
      if (isThenable(v)) v = await v;
      return v;
    }
    case 'ident':
    case 'plugin_var': {
      if (env.locals.has(expr.name)) return env.locals.get(expr.name);
      if (env.globals.has(expr.name)) return env.globals.get(expr.name);
      env.ctx.logger.warn(
        `[mkjianyi] 未定义变量 ${expr.kind === 'plugin_var' ? `[插件定义:${expr.name}]` : expr.name} @ ${env.scriptRel}`,
      );
      return undefined;
    }
    case 'unary': {
      const v = await evalExpr(expr.expr, env);
      if (!isPureNumber(v)) return 0;
      return -v;
    }
    case 'binary': {
      const left = await evalExpr(expr.left, env);
      const right = await evalExpr(expr.right, env);
      if (expr.op === '+') {
        if (isPureNumber(left) && isPureNumber(right)) return left + right;
        return asString(left) + asString(right);
      }
      if (!isPureNumber(left) || !isPureNumber(right)) return 0;
      if (expr.op === '-') return left - right;
      if (expr.op === '*') return left * right;
      if (expr.op === '/') return right === 0 ? 0 : left / right;
      return 0;
    }
    default:
      return undefined;
  }
}

function isTruthy(v: unknown): boolean {
  if (v == null || v === false) return false;
  if (v === 0 || v === '') return false;
  return true;
}

async function evalCond(cond: KaCond, env: KaExecEnv): Promise<boolean> {
  if (cond.kind === 'truthy') {
    const v = await env.resolveExpr(cond.expr);
    if (Array.isArray(v)) env.lastMatch = v as RegExpMatchArray;
    return isTruthy(v);
  }

  const left = await env.resolveExpr(cond.left);
  const right = await env.resolveExpr(cond.right);

  if (cond.kind === 'eq') return asString(left) === asString(right);
  if (cond.kind === 'neq') return asString(left) !== asString(right);

  if (!isPureNumber(left) || !isPureNumber(right)) return false;

  switch (cond.kind) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    default:
      return false;
  }
}

function clearLoopSignal(env: KaExecEnv): void {
  env.loopSignal = 'none';
}

async function execStmts(stmts: KaStmt[], env: KaExecEnv): Promise<void> {
  for (const stmt of stmts) {
    if (env.ended) return;
    if (env.loopSignal !== 'none') return;

    switch (stmt.kind) {
      case 'end':
        env.ended = true;
        return;

      case 'continue':
        env.loopSignal = 'continue';
        return;

      case 'break':
        env.loopSignal = 'break';
        return;

      case 'global_def':
        env.setVar(stmt.name, await env.resolveExpr(stmt.expr), 'global');
        break;

      case 'temp_def':
        env.setVar(stmt.name, await env.resolveExpr(stmt.expr), 'temp');
        break;

      case 'assign':
        env.setVar(stmt.name, await env.resolveExpr(stmt.expr), 'auto');
        break;

      case 'inc': {
        const prev = env.getVar(stmt.name);
        const n = isPureNumber(prev) ? prev : Number(prev);
        env.setVar(stmt.name, Number.isFinite(n) ? n + 1 : 1, 'auto');
        break;
      }

      case 'assign_add': {
        const prev = asString(env.getVar(stmt.name));
        const add = asString(await env.resolveExpr(stmt.expr));
        env.setVar(stmt.name, prev + add, 'auto');
        break;
      }

      case 'await': {
        if (stmt.delayMs) {
          const raw = await env.resolveExpr(stmt.delayMs);
          const ms = typeof raw === 'number' && Number.isFinite(raw)
            ? Math.trunc(raw)
            : Math.trunc(Number(raw));
          if (Number.isFinite(ms) && ms > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            });
          }
          break;
        }
        if (!stmt.expr) {
          await flushPending(env);
          break;
        }
        if (stmt.expr.kind === 'ident') {
          const name = stmt.expr.name;
          let v = env.getVar(name);
          if (isThenable(v)) {
            v = await v;
            env.setVar(name, v, 'auto');
          }
          break;
        }
        await env.resolveExpr(stmt.expr);
        break;
      }

      case 'call': {
        const handler = getStatementHandler(stmt.name);
        if (handler) {
          await handler(stmt.args, env);
          break;
        }
        // 无专用语句处理器时按表达式函数执行（写 / 读 / 设置群禁言 等）
        await invokeCallExpr(stmt.name, stmt.args, env);
        break;
      }

      case 'if': {
        if (await evalCond(stmt.cond, env)) {
          await execStmts(stmt.body, env);
        } else if (stmt.elseBody?.length) {
          await execStmts(stmt.elseBody, env);
        }
        break;
      }

      case 'for': {
        let guard = 0;
        while (await evalCond(stmt.cond, env)) {
          if (env.ended) return;
          guard++;
          if (guard > FOR_MAX_ITERATIONS) {
            env.ctx.logger.warn(
              `[mkjianyi] [For循环] 超过安全上限 ${FOR_MAX_ITERATIONS}，已强制中断 @ ${env.scriptRel}`,
            );
            break;
          }
          clearLoopSignal(env);
          await execStmts(stmt.body, env);
          if (env.ended) return;
          const signal = env.loopSignal as KaLoopSignal;
          if (signal === 'break') {
            clearLoopSignal(env);
            break;
          }
          // continue / none → 下一轮
          clearLoopSignal(env);
        }
        break;
      }

      default:
        break;
    }
  }
}

/**
 * 执行单个 .ka 脚本。
 * - 顶层 `全局定义` 先扫一遍写入 globals（再跑全部语句，保证示例里全局在 if 外也能被后面用到）
 * - 每次消息新建 locals；globals 在同文件内跨规则共享（同一次 refresh 后的脚本实例内）
 * - 结束时 flush 未 [等待] 的语句版发送，保证一定发出
 */
export async function runKaScript(
  ast: KaScriptAst,
  ctx: KaMessageContext,
  scriptRel: string,
  globals: Map<string, unknown>,
): Promise<void> {
  const env = createEnv(ctx, scriptRel, globals);

  for (const stmt of ast.stmts) {
    if (stmt.kind === 'global_def') {
      env.setVar(stmt.name, await env.resolveExpr(stmt.expr), 'global');
    }
  }

  await execStmts(ast.stmts, env);
  await flushPending(env);
}
