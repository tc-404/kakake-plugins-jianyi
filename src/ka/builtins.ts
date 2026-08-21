import {
  approveGroupJoinRequestResult,
  eventLabel,
  getAtCount,
  getAuthorOpenId,
  getGroupOpenId,
  getMessageId,
  makeButtonRow,
  makeCallbackButton,
  makeLinkButton,
  makeCommandButton,
  makeKeyboard,
  makeSendResult,
  mdCmdEnter,
  mdCmdInput,
  parseJoinRequestFromEvent,
  setGroupMemberMuteResult,
} from './message.js';
import { readA, readB, writeA, writeB, type DataFsRoots } from '../lib/data-fs.js';
import { httpAccess } from '../lib/http-access.js';
import { takeJson } from '../lib/json-take.js';
import type { BuiltinValueResolver, KaExpr, KaExecEnv, KaSendResult, StatementHandler } from './types.js';

const statementHandlers = new Map<string, StatementHandler>();
const builtinValues = new Map<string, BuiltinValueResolver>();

export function registerStatement(name: string, handler: StatementHandler): void {
  statementHandlers.set(name, handler);
}

export function registerBuiltinValue(name: string, resolver: BuiltinValueResolver): void {
  builtinValues.set(name, resolver);
}

export function getStatementHandler(name: string): StatementHandler | undefined {
  return statementHandlers.get(name);
}

export function resolveBuiltinValue(name: string, env: Parameters<BuiltinValueResolver>[0]): unknown {
  const fn = builtinValues.get(name);
  if (!fn) return undefined;
  return fn(env);
}

export function hasBuiltinValue(name: string): boolean {
  return builtinValues.has(name);
}

function failResult(err: unknown): KaSendResult {
  const msg = err instanceof Error ? err.message : String(err);
  return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: msg });
}

function rootsFromEnv(env: KaExecEnv): DataFsRoots {
  return {
    dataPath: String(env.ctx.dataPath ?? '').trim(),
    pluginPath: String(env.ctx.pluginPath ?? '').trim(),
    logger: env.ctx.logger,
  };
}

/** 执行发消息 / 发详细消息 / 发Markdown / 撤回，await 并返回回执 */
export async function invokeSend(
  name: string,
  args: KaExpr[],
  env: KaExecEnv,
): Promise<KaSendResult> {
  try {
    if (name === '发消息') {
      const parts: string[] = [];
      for (const a of args) {
        parts.push(String((await env.resolveExpr(a)) ?? ''));
      }
      return await env.ctx.sendText(parts.join(''));
    }
    if (name === '发Markdown') {
      if (args.length < 1) {
        env.ctx.logger.warn('[mkjianyi] 发Markdown 需要内容参数');
        return makeSendResult({
          成功: false,
          消息id: '',
          条数: 0,
          错误: '发Markdown 需要内容参数',
        });
      }
      const content = String((await env.resolveExpr(args[0]!)) ?? '');
      let keyboard: unknown;
      if (args.length >= 2) {
        keyboard = await env.resolveExpr(args[1]!);
      }
      return await env.ctx.sendMarkdown(content, keyboard);
    }
    if (name === '发详细消息') {
      if (args.length < 3) {
        env.ctx.logger.warn('[mkjianyi] 发详细消息 需要 3 个参数: ("群"|"私", openid, 内容)');
        return makeSendResult({
          成功: false,
          消息id: '',
          条数: 0,
          错误: '发详细消息 需要 3 个参数',
        });
      }
      const kind = String((await env.resolveExpr(args[0])) ?? '').trim();
      const targetId = await env.resolveExpr(args[1]);
      const text = String((await env.resolveExpr(args[2])) ?? '');
      return await env.ctx.sendDetailed(kind, targetId, text);
    }
    if (name === '撤回') {
      if (args.length < 1) {
        env.ctx.logger.warn('[mkjianyi] 撤回 需要 1 个参数: (消息id)');
        return makeSendResult({
          成功: false,
          消息id: '',
          条数: 0,
          错误: '撤回 需要 1 个参数',
        });
      }
      const messageId = await env.resolveExpr(args[0]);
      return await env.ctx.recall(messageId);
    }
    return makeSendResult({
      成功: false,
      消息id: '',
      条数: 0,
      错误: `未知发送语句 ${name}`,
    });
  } catch (e) {
    env.ctx.logger.warn?.(`[mkjianyi] ${name} 失败:`, (e as Error)?.message || e);
    return failResult(e);
  }
}

/** 表达式内函数调用 */
export async function invokeCallExpr(
  name: string,
  args: KaExpr[],
  env: KaExecEnv,
): Promise<unknown> {
  if (name === '发消息' || name === '发详细消息' || name === '发Markdown' || name === '撤回') {
    return invokeSend(name, args, env);
  }
  if (name === '指令输入') {
    if (args.length < 1) {
      env.ctx.logger.warn('[mkjianyi] 指令输入 需要至少 1 个参数: (填入内容, 显示文字?)');
      return '';
    }
    const fill = await env.resolveExpr(args[0]!);
    const show = args.length >= 2 ? await env.resolveExpr(args[1]!) : undefined;
    return mdCmdInput(fill, show);
  }
  if (name === '回车指令') {
    if (args.length < 1) {
      env.ctx.logger.warn('[mkjianyi] 回车指令 需要至少 1 个参数: (发送内容, 显示文字?)');
      return '';
    }
    const send = await env.resolveExpr(args[0]!);
    const show = args.length >= 2 ? await env.resolveExpr(args[1]!) : undefined;
    return mdCmdEnter(send, show);
  }
  if (name === '回调钮') {
    if (args.length < 3) {
      env.ctx.logger.warn(
        '[mkjianyi] 回调钮 需要至少 3 个参数: (id, 文字, data, 样式?, 点后文字?, 权限?, 指定用户?)',
      );
      return undefined;
    }
    const id = await env.resolveExpr(args[0]!);
    const label = await env.resolveExpr(args[1]!);
    const data = await env.resolveExpr(args[2]!);
    const style = args.length >= 4 ? await env.resolveExpr(args[3]!) : 1;
    const visited = args.length >= 5 ? await env.resolveExpr(args[4]!) : undefined;
    const perm = args.length >= 6 ? await env.resolveExpr(args[5]!) : 2;
    const users = args.length >= 7 ? await env.resolveExpr(args[6]!) : undefined;
    return makeCallbackButton(id, label, data, style, visited, perm, users);
  }
  if (name === '跳转钮') {
    if (args.length < 3) {
      env.ctx.logger.warn('[mkjianyi] 跳转钮 需要至少 3 个参数: (id, 文字, url, 样式?, 点后文字?)');
      return undefined;
    }
    const id = await env.resolveExpr(args[0]!);
    const label = await env.resolveExpr(args[1]!);
    const url = await env.resolveExpr(args[2]!);
    const style = args.length >= 4 ? await env.resolveExpr(args[3]!) : 1;
    const visited = args.length >= 5 ? await env.resolveExpr(args[4]!) : undefined;
    return makeLinkButton(id, label, url, style, visited);
  }
  if (name === '指令钮') {
    if (args.length < 3) {
      env.ctx.logger.warn(
        '[mkjianyi] 指令钮 需要至少 3 个参数: (id, 文字, data, 样式?, 点后文字?, 回车?, 引用?)',
      );
      return undefined;
    }
    const id = await env.resolveExpr(args[0]!);
    const label = await env.resolveExpr(args[1]!);
    const data = await env.resolveExpr(args[2]!);
    const style = args.length >= 4 ? await env.resolveExpr(args[3]!) : 1;
    const visited = args.length >= 5 ? await env.resolveExpr(args[4]!) : undefined;
    const enter = args.length >= 6 ? await env.resolveExpr(args[5]!) : false;
    const reply = args.length >= 7 ? await env.resolveExpr(args[6]!) : false;
    return makeCommandButton(id, label, data, style, visited, enter, reply);
  }
  if (name === '按钮行') {
    const buttons: unknown[] = [];
    for (const a of args) {
      buttons.push(await env.resolveExpr(a));
    }
    return makeButtonRow(...buttons);
  }
  if (name === '键盘') {
    const rows: unknown[] = [];
    for (const a of args) {
      rows.push(await env.resolveExpr(a));
    }
    return makeKeyboard(...rows);
  }
  if (name === '设置群禁言') {
    if (args.length < 2) {
      env.ctx.logger.warn('[mkjianyi] 设置群禁言 需要 2 个参数: (openid, 秒数)');
      return { 成功: false, 错误: '设置群禁言 需要 (openid, 秒数)' };
    }
    const mid = await env.resolveExpr(args[0]!);
    const sec = await env.resolveExpr(args[1]!);
    return setGroupMemberMuteResult(
      {
        event: env.ctx.event || {},
        callBotApi: env.ctx.callBotApi,
        logger: env.ctx.logger,
      },
      mid,
      sec,
    );
  }
  if (name === '取入群申请') {
    return parseJoinRequestFromEvent(env.ctx.event || {});
  }
  if (name === '审批入群申请') {
    if (args.length < 2) {
      env.ctx.logger.warn(
        '[mkjianyi] 审批入群申请 需要至少 2 个参数: (openid, 同意|拒绝|拉黑, 申请ID?, 拒绝理由?)',
      );
      return { 成功: false, 错误: '审批入群申请 需要 (openid, 操作, ...)' };
    }
    const mid = await env.resolveExpr(args[0]!);
    const op = await env.resolveExpr(args[1]!);
    const rid = args.length >= 3 ? await env.resolveExpr(args[2]!) : undefined;
    const reason = args.length >= 4 ? await env.resolveExpr(args[3]!) : undefined;
    return approveGroupJoinRequestResult(
      {
        event: env.ctx.event || {},
        callBotApi: env.ctx.callBotApi,
        logger: env.ctx.logger,
      },
      mid,
      op,
      rid,
      reason,
    );
  }
  if (name === '读') {
    if (args.length < 2) {
      env.ctx.logger.warn('[mkjianyi] 读 需要至少 2 个参数: (路径, 键, 默认值?)');
      return '';
    }
    const file = String((await env.resolveExpr(args[0]!)) ?? '');
    const key = String((await env.resolveExpr(args[1]!)) ?? '');
    const def = args.length >= 3 ? await env.resolveExpr(args[2]!) : '';
    return readB(rootsFromEnv(env), file, key, def);
  }
  if (name === '写') {
    if (args.length < 3) {
      env.ctx.logger.warn('[mkjianyi] 写 需要 3 个参数: (路径, 键, 值)');
      return false;
    }
    const file = String((await env.resolveExpr(args[0]!)) ?? '');
    const key = String((await env.resolveExpr(args[1]!)) ?? '');
    const value = await env.resolveExpr(args[2]!);
    return writeB(rootsFromEnv(env), file, key, value);
  }
  if (name === '读文件') {
    if (args.length < 1) {
      env.ctx.logger.warn('[mkjianyi] 读文件 需要 1 个参数: (路径)');
      return '';
    }
    const file = String((await env.resolveExpr(args[0]!)) ?? '');
    return readA(rootsFromEnv(env), file);
  }
  if (name === '写文件') {
    if (args.length < 2) {
      env.ctx.logger.warn('[mkjianyi] 写文件 需要 2 个参数: (路径, 内容)');
      return false;
    }
    const file = String((await env.resolveExpr(args[0]!)) ?? '');
    const content = String((await env.resolveExpr(args[1]!)) ?? '');
    return writeA(rootsFromEnv(env), file, content);
  }
  if (name === '访问') {
    if (args.length < 2) {
      env.ctx.logger.warn('[mkjianyi] 访问 需要至少 2 个参数: (GET|POST, 网址, ...)');
      return { 成功: false, 状态码: 0, 内容: '', 错误: '访问 需要 (方法, 网址, ...)' };
    }
    const method = await env.resolveExpr(args[0]!);
    const url = await env.resolveExpr(args[1]!);
    const arg3 = args.length >= 3 ? await env.resolveExpr(args[2]!) : undefined;
    const arg4 = args.length >= 4 ? await env.resolveExpr(args[3]!) : undefined;
    return httpAccess(method, url, arg3, arg4, { logger: env.ctx.logger });
  }
  if (name === '取JSON') {
    if (args.length < 1) {
      env.ctx.logger.warn('[mkjianyi] 取JSON 需要至少 1 个参数: (JSON文本, 路径…?)');
      return '';
    }
    const raw = await env.resolveExpr(args[0]!);
    const path: unknown[] = [];
    for (let i = 1; i < args.length; i++) {
      path.push(await env.resolveExpr(args[i]!));
    }
    return takeJson(raw, ...path);
  }
  if (name === '取长度') {
    if (args.length < 1) {
      env.ctx.logger.warn('[mkjianyi] 取长度 需要 1 个参数: (数组|字符串|JSON文本)');
      return 0;
    }
    let v = await env.resolveExpr(args[0]!);
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('[') || s.startsWith('{')) {
        try {
          v = JSON.parse(s);
        } catch {
          return s.length;
        }
      } else {
        return s.length;
      }
    }
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v as object).length;
    return 0;
  }
  env.ctx.logger.warn(`[mkjianyi] 表达式中未知函数 ${name}() @ ${env.scriptRel}`);
  return undefined;
}

function enqueueSend(name: string, args: KaExpr[], env: KaExecEnv): void {
  const p = invokeSend(name, args, env);
  env.pendingSends.push(p);
}

/** 注册内置：文本消息 / 事件 / 群号 / 发言人 / 发消息 / 发Markdown / 撤回 等 */
export function registerDefaultBuiltins(): void {
  if (!builtinValues.has('文本消息')) {
    registerBuiltinValue('文本消息', (env) => env.ctx.text);
  }

  if (!builtinValues.has('事件')) {
    registerBuiltinValue('事件', (env) => eventLabel(env.ctx.event || {}));
  }

  if (!builtinValues.has('群号')) {
    registerBuiltinValue('群号', (env) => getGroupOpenId(env.ctx.event || {}));
  }

  if (!builtinValues.has('发言人')) {
    registerBuiltinValue('发言人', (env) => getAuthorOpenId(env.ctx.event || {}));
  }

  if (!builtinValues.has('AppID')) {
    registerBuiltinValue('AppID', (env) => {
      const id = String(env.ctx.appId ?? '').trim();
      return id || 0;
    });
  }

  if (!builtinValues.has('消息ID')) {
    registerBuiltinValue('消息ID', (env) => getMessageId(env.ctx.event || {}));
  }

  if (!builtinValues.has('取艾特数')) {
    registerBuiltinValue('取艾特数', (env) => getAtCount(env.ctx.event || {}));
  }

  if (!statementHandlers.has('发消息')) {
    registerStatement('发消息', (args, env) => {
      enqueueSend('发消息', args, env);
    });
  }

  if (!statementHandlers.has('发详细消息')) {
    registerStatement('发详细消息', (args, env) => {
      enqueueSend('发详细消息', args, env);
    });
  }

  if (!statementHandlers.has('发Markdown')) {
    registerStatement('发Markdown', (args, env) => {
      enqueueSend('发Markdown', args, env);
    });
  }

  if (!statementHandlers.has('撤回')) {
    registerStatement('撤回', (args, env) => {
      enqueueSend('撤回', args, env);
    });
  }
}
