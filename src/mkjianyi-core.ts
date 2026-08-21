import fs from 'node:fs';
import path from 'node:path';
import { registerDefaultBuiltins } from './ka/builtins.js';
import {
  ackInteraction,
  eventLabel,
  getAuthorizeInteraction,
  getButtonData,
  getTextFromMessage,
  isInteractionEvent,
  isLifecycleEvent,
  isOfficialMessageEvent,
  makeSendResult,
  normalizeKeyboard,
  recallMessage,
  rememberGroupMemberRole,
  forgetGroupMemberRole,
  setCachedGroupMemberRole,
  getAuthorMemberRole,
  getGroupOpenId,
  getAuthorOpenId,
  isAdminOnlyButtonData,
  isCachedGroupAdmin,
  getCachedGroupMemberRole,
  unwrapAdminOnlyButtonData,
  replyMarkdown,
  replyText,
  resolveBotAppId,
  sendDetailedText,
  取事件回复目标,
  取互动目标,
  取发送目标,
  type GfSendTarget,
} from './ka/message.js';
import { runKaScript } from './ka/runtime.js';
import { KaScriptRegistry } from './ka/scanner.js';
import type { KaLoadedScript, KaMessageContext, KaSendResult } from './ka/types.js';

const SCRIPTS_DIR_NAME = '文本类插件';

let gCtx: any = null;
let gLogger: any = console;
let gPluginPath = '';
let gDataPath = '';
let gScriptsDir = '';
const registry = new KaScriptRegistry();
/** 每个 .ka 相对路径一份全局变量表；脚本重载时清空 */
const globalStore = new Map<string, Map<string, unknown>>();
const lastMtime = new Map<string, number>();

function resolveScriptsDir(pluginPath: string): string {
  return path.join(pluginPath, SCRIPTS_DIR_NAME);
}

/** 账号可写目录：dataPath → dirname(configPath) → pluginPath/data */
function resolveDataPath(ctx: any, pluginPath: string): string {
  const fromCtx = String(ctx?.dataPath || gDataPath || '').trim();
  if (fromCtx) return fromCtx;
  const configPath = String(ctx?.configPath || '').trim();
  if (configPath) return path.dirname(configPath);
  if (pluginPath) return path.join(pluginPath, 'data');
  return '';
}

function refreshPluginPath(ctx: any): void {
  const pluginPath = String(ctx?.pluginPath || gPluginPath || '');
  if (pluginPath && pluginPath !== gPluginPath) {
    gPluginPath = pluginPath;
    gScriptsDir = resolveScriptsDir(gPluginPath);
    registry.setScriptsDir(gScriptsDir);
    registry.forceRefresh(gLogger);
  }
  const dp = resolveDataPath(ctx, pluginPath || gPluginPath);
  if (dp) gDataPath = dp;
}

function syncGlobalStore(scripts: KaLoadedScript[]): void {
  const alive = new Set(scripts.map((s) => s.relPath));

  for (const key of [...globalStore.keys()]) {
    if (!alive.has(key)) {
      globalStore.delete(key);
      lastMtime.delete(key);
    }
  }

  for (const s of scripts) {
    const prev = lastMtime.get(s.relPath);
    if (prev !== s.mtimeMs) {
      globalStore.set(s.relPath, new Map());
      lastMtime.set(s.relPath, s.mtimeMs);
    } else if (!globalStore.has(s.relPath)) {
      globalStore.set(s.relPath, new Map());
    }
  }
}

function ensureScripts(): KaLoadedScript[] {
  const { scripts, refreshed } = registry.ensure(gLogger);
  if (refreshed) syncGlobalStore(scripts);
  return scripts;
}

function buildMsgCtx(
  ctx: any,
  event: Record<string, unknown>,
  text: string,
  replyTarget: GfSendTarget | null,
): KaMessageContext {
  const pluginPath = String(ctx?.pluginPath || gPluginPath || '');
  const dataPath = resolveDataPath(ctx, pluginPath);
  const actionCtx = {
    ...ctx,
    event,
    pluginPath,
    dataPath,
    logger: ctx?.logger || gLogger,
  };

  const skipSend = (op: string, detail: string): KaSendResult => {
    const label = eventLabel(event);
    const t = String(event.t ?? '').trim();
    gLogger.info?.(
      `[mkjianyi] ${op}已跳过（事件「${label || '?'}」/${t || '?'} 不可回复）: ${detail.slice(0, 200)}`,
    );
    return makeSendResult({
      成功: false,
      消息id: '',
      条数: 0,
      错误: '当前事件不可回复',
    });
  };

  return {
    text,
    event,
    appId: resolveBotAppId(ctx),
    dataPath,
    pluginPath,
    logger: gLogger,
    sendText: async (body: string): Promise<KaSendResult> => {
      if (!replyTarget) return skipSend('发消息', String(body ?? ''));
      try {
        return await replyText(actionCtx, replyTarget, body);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        gLogger.warn?.('[mkjianyi] 发消息失败:', msg);
        return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: msg });
      }
    },
    sendDetailed: async (kind: string, targetId: unknown, body: string): Promise<KaSendResult> => {
      if (!replyTarget) {
        return skipSend('发详细消息', `${kind}|${targetId}|${String(body ?? '')}`);
      }
      try {
        return await sendDetailedText(actionCtx, event, kind, targetId, body);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        gLogger.warn?.('[mkjianyi] 发详细消息失败:', msg);
        return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: msg });
      }
    },
    sendMarkdown: async (body: string, keyboard?: unknown): Promise<KaSendResult> => {
      if (!replyTarget) return skipSend('发Markdown', String(body ?? ''));
      try {
        return await replyMarkdown(
          actionCtx,
          replyTarget,
          body,
          normalizeKeyboard(keyboard),
        );
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        gLogger.warn?.('[mkjianyi] 发Markdown失败:', msg);
        return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: msg });
      }
    },
    recall: async (messageId: unknown): Promise<KaSendResult> => {
      if (!replyTarget) return skipSend('撤回', String(messageId ?? ''));
      try {
        return await recallMessage(actionCtx, replyTarget, messageId);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        gLogger.warn?.('[mkjianyi] 撤回失败:', msg);
        return makeSendResult({ 成功: false, 消息id: String(messageId ?? ''), 条数: 0, 错误: msg });
      }
    },
    callBotApi: async (apiPath: string, params: Record<string, unknown> = {}) => {
      return actionCtx.actions.call(apiPath, params, actionCtx.adapterName);
    },
  };
}

async function runAllScripts(msgCtx: KaMessageContext): Promise<void> {
  const scripts = ensureScripts();
  const tasks: Promise<void>[] = [];
  for (const script of scripts) {
    if (!script.ast) continue;
    let globals = globalStore.get(script.relPath);
    if (!globals) {
      globals = new Map();
      globalStore.set(script.relPath, globals);
    }

    tasks.push(
      runKaScript(script.ast, msgCtx, script.relPath, globals).catch((e) => {
        gLogger.warn?.(
          `[mkjianyi] 执行失败 ${script.relPath}:`,
          (e as Error)?.message || e,
        );
      }),
    );
  }

  if (tasks.length) await Promise.all(tasks);
}

async function handleInteraction(ctx: any, event: Record<string, unknown>): Promise<void> {
  const actionCtx = {
    ...ctx,
    pluginPath: String(ctx?.pluginPath || gPluginPath || ''),
    logger: ctx?.logger || gLogger,
  };
  const interactionId = String(event.id ?? '').trim();
  const outerType = Number(event.type);
  // 官方：仅 type=11/12 必须回应；授权等可选。统一 ACK 无害。
  const needAck = !Number.isFinite(outerType) || outerType === 11 || outerType === 12
    || outerType === 18 || outerType === 19 || outerType === 20;
  let ackCode = 0;

  try {
    const auth = getAuthorizeInteraction(event);
    if (auth) {
      gLogger.info?.(
        `[mkjianyi] 授权互动「${auth.label}」(scope=${auth.scope}, canReply=${auth.canReply})`,
      );
      let replyTarget: GfSendTarget | null = null;
      if (auth.canReply) {
        try {
          replyTarget = 取互动目标(event);
        } catch (e) {
          gLogger.warn?.(
            `[mkjianyi] 授权互动无发送目标:`,
            (e as Error)?.message || e,
          );
        }
      }
      const msgCtx = buildMsgCtx(ctx, event, auth.label, replyTarget);
      await runAllScripts(msgCtx);
      return;
    }

    const btn = getButtonData(event);
    if (!btn?.data) {
      gLogger.warn?.('[mkjianyi] 互动无 button_data / authorize_data，跳过脚本');
    } else {
      const replyTarget = 取互动目标(event);
      const { needAdmin, data: plainData } = unwrapAdminOnlyButtonData(btn.data);
      // 群聊客户端常不拦 type=1；以点击者身份缓存为准（与谁呼出按钮无关）
      if ((needAdmin || isAdminOnlyButtonData(btn.data)) && !isCachedGroupAdmin(event)) {
        const role = getCachedGroupMemberRole(event);
        gLogger.info?.(
          `[mkjianyi] 拒绝非管理点击「仅管理」按钮 data=${plainData} openid=${String(getAuthorOpenId(event))} role=${role || 0}`,
        );
        const denyCtx = buildMsgCtx(ctx, event, plainData, replyTarget);
        try {
          await denyCtx.sendText(
            `无权限：此按钮仅群主/管理员可点（你的身份=${role || '未知/未缓存'}，需管理在群里发过言后才会识别）`,
          );
        } catch (e) {
          gLogger.warn?.('[mkjianyi] 发送无权限提示失败:', (e as Error)?.message || e);
        }
        return;
      }
      const msgCtx = buildMsgCtx(ctx, event, plainData, replyTarget);
      await runAllScripts(msgCtx);
    }
  } catch (e) {
    ackCode = 1;
    gLogger.error?.('[mkjianyi] 回调按钮处理失败:', (e as Error)?.message || e);
  } finally {
    if (needAck && interactionId) {
      try {
        await ackInteraction(actionCtx, interactionId, ackCode);
      } catch (e) {
        gLogger.error?.('[mkjianyi] 回应互动失败:', (e as Error)?.message || e);
      }
    }
  }
}

export async function plugin_init(ctx: any): Promise<void> {
  registerDefaultBuiltins();
  gCtx = ctx;
  gLogger = ctx?.logger || console;
  gPluginPath = String(ctx?.pluginPath || '');
  gDataPath = resolveDataPath(ctx, gPluginPath);
  gScriptsDir = resolveScriptsDir(gPluginPath);
  registry.setScriptsDir(gScriptsDir);
  const list = registry.forceRefresh(gLogger);
  syncGlobalStore(list);
  gLogger.info?.(
    `[mkjianyi] 官方机器人插件已初始化，脚本目录: ${gScriptsDir}，数据目录: ${gDataPath || '(无)'}，发现 ${list.length} 个 .ka`,
  );
}

export async function plugin_cleanup(_ctx?: any): Promise<void> {
  registry.stopWatch();
  globalStore.clear();
  lastMtime.clear();
  gCtx = null;
  gLogger.info?.('[mkjianyi] 已卸载');
}

export async function plugin_onmessage(ctx: any, event: Record<string, unknown>): Promise<void> {
  if (!event || typeof event !== 'object') return;

  gCtx = ctx || gCtx;
  gLogger = ctx?.logger || gLogger;
  refreshPluginPath(ctx);

  if (isInteractionEvent(event)) {
    await handleInteraction(ctx, event);
    return;
  }

  if (!isOfficialMessageEvent(event)) return;

  // 任意成功上报的群消息都先刷身份缓存（与是否命中指令无关）
  rememberGroupMemberRole(event, gLogger);

  const text = getTextFromMessage(event);
  const replyTarget = 取发送目标(event);
  const msgCtx = buildMsgCtx(ctx, event, text, replyTarget);
  await runAllScripts(msgCtx);
}

/**
 * 生命周期事件（进群/退群/好友/通知开关/成员进退）。
 * 消息与 INTERACTION 只走 plugin_onmessage，避免双跑。
 */
export async function plugin_onevent(ctx: any, event: Record<string, unknown>): Promise<void> {
  if (!event || typeof event !== 'object') return;
  if (!isLifecycleEvent(event)) return;

  gCtx = ctx || gCtx;
  gLogger = ctx?.logger || gLogger;
  refreshPluginPath(ctx);

  const t = String(event.t ?? '').trim();
  if (t === 'GROUP_MEMBER_REMOVE') {
    forgetGroupMemberRole(event, gLogger);
  } else if (t === 'GROUP_MEMBER_ADD') {
    const role = getAuthorMemberRole(event);
    const gid = getGroupOpenId(event);
    const oid = getAuthorOpenId(event);
    if (role && gid !== 0 && oid !== 0) {
      setCachedGroupMemberRole(gid, oid, role, gLogger);
    }
  }

  const label = eventLabel(event);
  const replyTarget = 取事件回复目标(event);

  if (!replyTarget) {
    gLogger.info?.(
      `[mkjianyi] 生命周期事件「${label}」(${t})：不可回复，仅跑脚本/打日志`,
    );
  } else {
    gLogger.info?.(`[mkjianyi] 生命周期事件「${label}」(${t})`);
  }

  // 事件驱动：文本消息 = 中文简短名，便于 [如果]([文本消息] == "进群")
  const msgCtx = buildMsgCtx(ctx, event, label, replyTarget);
  await runAllScripts(msgCtx);
}
