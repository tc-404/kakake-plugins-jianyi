/**
 * QQ 官方机器人传输层（GF 车道，非 OneBot）
 * 对齐 GF_mk：openid + /v2/.../messages + 富媒体上传
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePluginRelativePath } from '../lib/paths.js';
import type { KaSendResult } from './types.js';

export type GfSendScope = 'group' | 'c2c';

export type GfSendTarget = {
  scope: GfSendScope;
  group_openid?: string;
  user_openid?: string;
  /** 被动回复：对应用户消息 id */
  msg_id?: string;
  /** 被动回复：事件 id（与 msg_id 互斥；进群等生命周期事件） */
  event_id?: string;
  next_msg_seq?: number;
};

/** 官方 keyboard 按钮（回调 / 跳转 / 指令） */
export type GfKeyboardButton = {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    /** 现网可用：1蓝 / 2白 / 3红；其它值回退为 1 */
    style?: 1 | 2 | 3;
  };
  action: {
    /** 0 跳转 / 1 回调 / 2 指令 */
    type: 0 | 1 | 2;
    permission: {
      type: number;
      specify_user_ids?: string[];
      specify_role_ids?: string[];
    };
    data: string;
    unsupport_tips: string;
    /** 指令钮：点击后直接发送（群聊不支持） */
    enter?: boolean;
    /** 指令钮：是否引用本消息 */
    reply?: boolean;
  };
};

export type GfKeyboardRow = { buttons: GfKeyboardButton[] };
export type GfKeyboardContent = { rows: GfKeyboardRow[] };

type ActionCtx = {
  actions: {
    call: (
      action: string,
      params?: Record<string, unknown>,
      adapter?: string,
    ) => Promise<unknown>;
  };
  adapterName?: string;
  /** 插件根目录，供 [图片,本地:相对路径] 解析 */
  pluginPath?: string;
  /** 当前事件（发 keyboard 时用于补「仅管理」指定用户） */
  event?: Record<string, unknown>;
  logger?: {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
};

/** 群成员身份缓存：openid → role（来自消息事件；互动回调本身不带 member_role） */
const groupRoleCache = new Map<string, Map<string, 'member' | 'admin' | 'owner'>>();

type RoleCacheLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

/**
 * 写入回调 data 的持久标记（进程重启后 Set 会丢，但旧按钮仍带此前缀）。
 * 脚本侧 [文本消息] 会剥掉此前缀，仍是用户写的 data。
 */
export const ADMIN_BUTTON_DATA_PREFIX = '\u0001MKADMIN\u0001';

/** @deprecated 仅作进程内加速；权威标记看 data 前缀 */
const adminOnlyButtonData = new Set<string>();

export function wrapAdminOnlyButtonData(data: unknown): string {
  const s = String(data ?? '');
  if (s.startsWith(ADMIN_BUTTON_DATA_PREFIX)) return s;
  return ADMIN_BUTTON_DATA_PREFIX + s;
}

export function unwrapAdminOnlyButtonData(data: unknown): { needAdmin: boolean; data: string } {
  const s = String(data ?? '');
  if (s.startsWith(ADMIN_BUTTON_DATA_PREFIX)) {
    return { needAdmin: true, data: s.slice(ADMIN_BUTTON_DATA_PREFIX.length) };
  }
  return { needAdmin: false, data: s };
}

/**
 * 写入/刷新群成员身份缓存。
 * 群消息路径会自动调用；生命周期（如成员进群）可显式传入 role。
 */
export function setCachedGroupMemberRole(
  groupOpenId: string | number,
  memberOpenId: string | number,
  role: 'member' | 'admin' | 'owner',
  logger?: RoleCacheLogger,
): void {
  const g = String(groupOpenId ?? '').trim();
  const u = String(memberOpenId ?? '').trim();
  if (!g || !u || g === '0' || u === '0') return;
  let m = groupRoleCache.get(g);
  if (!m) {
    m = new Map();
    groupRoleCache.set(g, m);
  }
  const prev = m.get(u);
  if (prev === role) {
    logger?.debug?.(`[mkjianyi] 群身份未变 group=${g} openid=${u} role=${role}`);
    return;
  }
  m.set(u, role);
  if (prev) {
    logger?.info?.(`[mkjianyi] 群身份变更 group=${g} openid=${u} ${prev}→${role}`);
  } else {
    logger?.info?.(`[mkjianyi] 群身份记录 group=${g} openid=${u} role=${role}`);
  }
}

/**
 * 从成功上报的群消息写入/刷新发言人身份（官方 `author.member_role`）。
 * 与是否命中任何 .ka 指令无关：只要插件收到群消息事件且带身份字段就更新。
 * 升/降管会覆盖旧值，供「仅管理」按钮回调验权。
 */
export function rememberGroupMemberRole(
  event: Record<string, unknown>,
  logger?: RoleCacheLogger,
): void {
  const t = clean(event.t);
  // 仅群消息；私聊 / 互动不写（成员进群请走 setCached / forget）
  if (t && t !== 'GROUP_AT_MESSAGE_CREATE' && t !== 'GROUP_MESSAGE_CREATE') return;

  const gid = getGroupOpenId(event);
  if (gid === 0 || !gid) return;
  const oid = getAuthorOpenId(event);
  if (oid === 0 || !oid) return;
  const role = getAuthorMemberRole(event);
  if (!role) return;
  setCachedGroupMemberRole(gid, oid, role, logger);
}

/** 成员退群等：从缓存去掉，避免旧 admin 残留 */
export function forgetGroupMemberRole(event: Record<string, unknown>, logger?: RoleCacheLogger): void {
  const gid = getGroupOpenId(event);
  if (gid === 0 || !gid) return;
  const oid = getAuthorOpenId(event);
  if (oid === 0 || !oid) return;
  const g = String(gid);
  const u = String(oid);
  const m = groupRoleCache.get(g);
  if (!m?.has(u)) return;
  const prev = m.get(u);
  m.delete(u);
  if (m.size === 0) groupRoleCache.delete(g);
  logger?.info?.(`[mkjianyi] 群身份清除 group=${g} openid=${u} 原=${prev}`);
}

function listCachedAdmins(groupOpenId: string): string[] {
  const m = groupRoleCache.get(groupOpenId);
  if (!m) return [];
  const out: string[] = [];
  for (const [oid, role] of m) {
    if (role === 'admin' || role === 'owner') out.push(oid);
  }
  return out;
}

/** 查询群身份：事件字段优先，否则用发言缓存（互动无 member_role） */
export function getCachedGroupMemberRole(
  event: Record<string, unknown>,
): 'member' | 'admin' | 'owner' | 0 {
  const fromEvent = getAuthorMemberRole(event);
  if (fromEvent) return fromEvent;
  const gid = getGroupOpenId(event);
  const oid = getAuthorOpenId(event);
  if (gid === 0 || !gid || oid === 0 || !oid) return 0;
  return groupRoleCache.get(String(gid))?.get(String(oid)) ?? 0;
}

export function isCachedGroupAdmin(event: Record<string, unknown>): boolean {
  const role = getCachedGroupMemberRole(event);
  return role === 'admin' || role === 'owner';
}

export function isAdminOnlyButtonData(data: unknown): boolean {
  const { needAdmin } = unwrapAdminOnlyButtonData(data);
  if (needAdmin) return true;
  return adminOnlyButtonData.has(String(data ?? '').trim());
}

/**
 * 群聊现网：permission.type=1 客户端经常不拦截。
 * 发送时附带「已知管理员」openid 作客户端软拦截（与谁呼出无关）；真正权限以回调验身份为准。
 * 无已知管理员时用占位 id，避免裸 type=1 谁都能点。
 */
export function patchKeyboardAdminPermission(
  keyboard: GfKeyboardContent | undefined,
  event?: Record<string, unknown> | null,
  logger?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void },
): GfKeyboardContent | undefined {
  if (!keyboard?.rows?.length) return keyboard;
  const gid = event ? getGroupOpenId(event) : 0;
  if (gid === 0 || !gid) return keyboard;

  // 与「谁点的测试12-17」无关：只用群内已缓存的管理/群主 + 若当前发言人本身是管理则并入
  const admins = new Set(listCachedAdmins(String(gid)));
  if (event) {
    const role = getAuthorMemberRole(event);
    const oid = getAuthorOpenId(event);
    if ((role === 'admin' || role === 'owner') && oid !== 0) {
      admins.add(String(oid));
    }
  }
  const adminList = [...admins];
  const userIds = adminList.length ? adminList : ['_mkjianyi_no_admin_'];
  if (!adminList.length) {
    logger?.warn?.(
      '[mkjianyi] 「仅管理」尚无已知管理员（需群主/管理先在群里发过言）；客户端先做成无人可点，回调仍会验权',
    );
  }

  let patched = 0;
  const rows = keyboard.rows.map((row) => ({
    buttons: (row.buttons || []).map((btn) => {
      const permType = Number(btn?.action?.permission?.type);
      if (permType !== 1) return btn;
      patched++;
      const rawData = String(btn.action?.data ?? '');
      const wrapped = wrapAdminOnlyButtonData(rawData);
      adminOnlyButtonData.add(wrapped);
      adminOnlyButtonData.add(unwrapAdminOnlyButtonData(wrapped).data);
      return {
        ...btn,
        action: {
          ...btn.action,
          data: wrapped,
          permission: {
            type: 0,
            specify_user_ids: userIds,
          },
        },
      };
    }),
  }));
  if (patched && adminList.length) {
    logger?.info?.(
      `[mkjianyi] 「仅管理」×${patched}：客户端软拦 ${adminList.length} 个已知管理 openid；回调再按身份缓存验权`,
    );
  }
  return { rows };
}

function clean(v: unknown): string {
  return String(v ?? '').trim();
}

const RE_AT = /<@!?([A-Za-z0-9_]+)>/g;

/** 去掉 @机器人 / @某人 标记后的纯文本 */
export function 提取纯文本(content: string): string {
  return content
    .replace(RE_AT, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从官方事件取正文（content） */
export function getTextFromMessage(event: Record<string, unknown>): string {
  return 提取纯文本(String(event.content ?? ''));
}

/** 官方消息 id：event.id；取不到为 0 */
export function getMessageId(event: Record<string, unknown>): string | number {
  const s = clean(event.id);
  return s || 0;
}

/** 群 openid；取不到为 0 */
export function getGroupOpenId(event: Record<string, unknown>): string | number {
  const s = clean(event.group_openid ?? event.group_open_id);
  return s || 0;
}

/** 发言人 openid；取不到为 0 */
export function getAuthorOpenId(event: Record<string, unknown>): string | number {
  const author = (event.author && typeof event.author === 'object')
    ? (event.author as Record<string, unknown>)
    : {};
  const s = clean(
    event.user_openid
    ?? event.group_member_openid
    ?? event.member_openid
    ?? event.op_member_openid
    ?? event.openid
    ?? author.user_openid
    ?? author.member_openid
    ?? author.union_openid
    ?? author.id,
  );
  return s || 0;
}

/** 规范化群成员角色；非法 → 0 */
export function normalizeMemberRole(raw: unknown): 'member' | 'admin' | 'owner' | 0 {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'member' || s === 'admin' || s === 'owner') return s;
  return 0;
}

/** 当前消息发言人身份（事件字段）；取不到为 0 */
export function getAuthorMemberRole(event: Record<string, unknown>): 'member' | 'admin' | 'owner' | 0 {
  const author = (event.author && typeof event.author === 'object')
    ? (event.author as Record<string, unknown>)
    : {};
  return normalizeMemberRole(author.member_role ?? event.member_role);
}

type BotApiCaller = {
  callBotApi?: (apiPath: string, params?: Record<string, unknown>) => Promise<unknown>;
  logger?: { warn?: (...args: unknown[]) => void };
};

/** GET /v2/groups/{gid}/bot_state；失败返回 null（含无白名单） */
export async function fetchBotGroupState(
  ctx: BotApiCaller,
  groupOpenId: string,
): Promise<{
  member_openid: string;
  member_role: 'member' | 'admin' | 'owner' | 0;
  joined_at: string;
  allow_proactive_msg: boolean;
  recv_msg_setting: string;
} | null> {
  const gid = clean(groupOpenId);
  if (!gid || !ctx.callBotApi) return null;
  try {
    const res = await ctx.callBotApi(`/v2/groups/${gid}/bot_state`, { __method: 'GET' });
    const data = unwrapApiData(res);
    return {
      member_openid: clean(data.member_openid),
      member_role: normalizeMemberRole(data.member_role),
      joined_at: clean(data.joined_at),
      allow_proactive_msg: Boolean(data.allow_proactive_msg),
      recv_msg_setting: clean(data.recv_msg_setting),
    };
  } catch (e) {
    ctx.logger?.warn?.(
      '[mkjianyi] 获取机器人群状态失败（接口可能仅白名单）:',
      (e as Error)?.message || e,
    );
    return null;
  }
}

function unwrapApiData(res: unknown): Record<string, unknown> {
  const o = (res && typeof res === 'object') ? res as Record<string, unknown> : {};
  if (o.data && typeof o.data === 'object') return o.data as Record<string, unknown>;
  return o;
}

function failGroupResult(err: unknown): Record<string, unknown> {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return { 成功: false, 错误: msg };
}

/** [获取群信息] → 中文键回执 */
export async function fetchGroupInfoResult(
  ctx: BotApiCaller & { event: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const gid = getGroupOpenId(ctx.event || {});
  if (gid === 0 || !gid) return { 成功: false, 错误: '仅群聊可用', 群名: '', 简介: '', 分类: '', 人数: 0, 标签: '' };
  if (!ctx.callBotApi) return { 成功: false, 错误: '无 callBotApi', 群名: '', 简介: '', 分类: '', 人数: 0, 标签: '' };
  try {
    const res = await ctx.callBotApi(`/v2/groups/${gid}/info`, { __method: 'GET' });
    const data = unwrapApiData(res);
    const tags = Array.isArray(data.group_tags)
      ? (data.group_tags as unknown[]).map((t) => String(t)).join(',')
      : '';
    return {
      成功: true,
      群名: clean(data.group_name),
      简介: clean(data.group_finger_memo),
      分类: clean(data.group_class_text),
      人数: Number(data.group_member_num) || 0,
      标签: tags,
      错误: '',
    };
  } catch (e) {
    ctx.logger?.warn?.('[mkjianyi] 获取群信息失败:', (e as Error)?.message || e);
    return { ...failGroupResult(e), 群名: '', 简介: '', 分类: '', 人数: 0, 标签: '' };
  }
}

/** [获取机器人群状态] → 中文键回执 */
export async function fetchBotGroupStateResult(
  ctx: BotApiCaller & { event: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const gid = getGroupOpenId(ctx.event || {});
  if (gid === 0 || !gid) {
    return { 成功: false, 错误: '仅群聊可用', openid: '', 入群时间: '', 主动消息: '', 收消息设置: '', 身份: 0 };
  }
  const st = await fetchBotGroupState(ctx, String(gid));
  if (!st) {
    return { 成功: false, 错误: '获取失败或无白名单', openid: '', 入群时间: '', 主动消息: '', 收消息设置: '', 身份: 0 };
  }
  return {
    成功: true,
    openid: st.member_openid,
    入群时间: st.joined_at,
    主动消息: st.allow_proactive_msg ? '是' : '否',
    收消息设置: st.recv_msg_setting || '',
    身份: st.member_role === 0 ? 0 : st.member_role,
    错误: '',
  };
}

/** [查询群禁言] → 中文键回执 */
export async function fetchGroupMuteResult(
  ctx: BotApiCaller & { event: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const gid = getGroupOpenId(ctx.event || {});
  if (gid === 0 || !gid) return { 成功: false, 错误: '仅群聊可用', 全员模式: '', 禁言人数: 0, 明细: '' };
  if (!ctx.callBotApi) return { 成功: false, 错误: '无 callBotApi', 全员模式: '', 禁言人数: 0, 明细: '' };
  try {
    const res = await ctx.callBotApi(`/v2/groups/${gid}/restrict_chat_setting`, { __method: 'GET' });
    const data = unwrapApiData(res);
    const global = (data.global_rule && typeof data.global_rule === 'object')
      ? data.global_rule as Record<string, unknown>
      : {};
    const mode = clean(global.mode) || 'none';
    const members = Array.isArray(data.members) ? data.members as Record<string, unknown>[] : [];
    const lines = members.slice(0, 20).map((m) => {
      const id = clean(m.member_openid);
      const name = clean(m.username) || id;
      const exp = clean(m.mute_expire_at);
      return `${name}→${exp}`;
    });
    return {
      成功: true,
      全员模式: mode,
      禁言人数: members.length,
      明细: lines.join('; ') || '(无)',
      错误: '',
    };
  } catch (e) {
    ctx.logger?.warn?.('[mkjianyi] 查询群禁言失败:', (e as Error)?.message || e);
    return { ...failGroupResult(e), 全员模式: '', 禁言人数: 0, 明细: '' };
  }
}

const MUTE_MAX_SECONDS = 30 * 24 * 3600;

function toRfc3339Local(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

/** 从 GROUP_JOIN_REQUEST 事件解析入群申请字段（非该事件时多为空） */
export function parseJoinRequestFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  const verify = (event.verify_info && typeof event.verify_info === 'object')
    ? (event.verify_info as Record<string, unknown>)
    : {};
  const method = clean(verify.method);
  const verifyMessage = clean(verify.verify_message);
  const qaRaw = Array.isArray(verify.review_qa_list) ? verify.review_qa_list : [];
  const qaLines: string[] = [];
  const questions: string[] = [];
  const answers: string[] = [];
  for (const item of qaRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const q = clean(row.question);
    const a = clean(row.answer);
    if (q) questions.push(q);
    if (a) answers.push(a);
    if (q || a) qaLines.push(`问：${q || '(空)'}\n答：${a || '(空)'}`);
  }
  let 问题 = '';
  let 答案 = '';
  if (method === 'admin_review_qa' || qaLines.length) {
    问题 = questions.join(' / ') || '(无)';
    答案 = answers.join(' / ') || '(无)';
  } else if (method === 'verify_message' || verifyMessage) {
    问题 = '验证消息';
    答案 = verifyMessage || '(空)';
  } else {
    问题 = '(无)';
    答案 = '(无)';
  }
  const openid = clean(event.member_openid ?? event.union_openid);
  const applySource = clean(event.apply_source);
  const sourceLabel = applySource === 'invited'
    ? '被邀请'
    : applySource === 'self_apply'
      ? '主动申请'
      : (applySource || '(未知)');
  return {
    成功: !!(openid || clean(event.join_request_id)),
    申请ID: clean(event.join_request_id),
    openid: openid || '',
    昵称: clean(event.username) || '(未知)',
    申请时间: clean(event.apply_at),
    来源: sourceLabel,
    来源码: applySource,
    邀请人: clean(event.invited_by),
    是否机器人: event.bot === true,
    风险提示: clean(event.risk_tips),
    验证方式: method || '(未知)',
    验证消息: verifyMessage,
    问题,
    答案,
    问答明细: qaLines.join('\n\n') || '',
    错误: '',
  };
}

/**
 * 审批入群申请(openid, 操作, 申请ID?, 拒绝理由?)
 * 操作：同意 / 拒绝 / 拉黑（拒绝并加入群黑名单）
 */
export async function approveGroupJoinRequestResult(
  ctx: BotApiCaller & { event: Record<string, unknown> },
  memberOpenId: unknown,
  opRaw: unknown,
  joinRequestId?: unknown,
  rejectReason?: unknown,
): Promise<Record<string, unknown>> {
  const gid = getGroupOpenId(ctx.event || {});
  if (gid === 0 || !gid) return { 成功: false, 错误: '仅群聊可用', 操作: '', 成员: '' };
  if (!ctx.callBotApi) return { 成功: false, 错误: '无 callBotApi', 操作: '', 成员: '' };
  const mid = clean(memberOpenId);
  if (!mid) return { 成功: false, 错误: '缺少成员 openid', 操作: '', 成员: '' };

  const opKey = clean(opRaw).toLowerCase();
  let op: 'approve' | 'decline';
  let blacklist = false;
  let opLabel = '';
  if (opKey === '同意' || opKey === 'approve' || opKey === '通过') {
    op = 'approve';
    opLabel = '同意';
  } else if (opKey === '拉黑' || opKey === 'blacklist' || opKey === '拒绝并拉黑') {
    op = 'decline';
    blacklist = true;
    opLabel = '拉黑';
  } else if (opKey === '拒绝' || opKey === 'decline' || opKey === 'reject') {
    op = 'decline';
    opLabel = '拒绝';
  } else {
    return { 成功: false, 错误: '操作须为 同意/拒绝/拉黑', 操作: clean(opRaw), 成员: mid };
  }

  const body: Record<string, unknown> = { op };
  const rid = clean(joinRequestId);
  if (rid) body.join_request_id = rid;
  if (op === 'decline') {
    const reason = clean(rejectReason);
    if (reason) body.reject_reason = reason;
    if (blacklist) body.add_to_member_blacklist = true;
  }

  try {
    await ctx.callBotApi(`/v2/groups/${gid}/approval_join_request/${mid}`, {
      __method: 'POST',
      ...body,
    });
    return {
      成功: true,
      错误: '',
      操作: opLabel,
      成员: mid,
      申请ID: rid,
      拉黑: blacklist,
    };
  } catch (e) {
    ctx.logger?.warn?.('[mkjianyi] 审批入群申请失败:', (e as Error)?.message || e);
    return { ...failGroupResult(e), 操作: opLabel, 成员: mid, 申请ID: rid, 拉黑: blacklist };
  }
}

/** 设置群禁言(openid, 秒数)；秒数<=0 解禁 */
export async function setGroupMemberMuteResult(
  ctx: BotApiCaller & { event: Record<string, unknown> },
  memberOpenId: unknown,
  secondsRaw: unknown,
): Promise<Record<string, unknown>> {
  const gid = getGroupOpenId(ctx.event || {});
  if (gid === 0 || !gid) return { 成功: false, 错误: '仅群聊可用' };
  if (!ctx.callBotApi) return { 成功: false, 错误: '无 callBotApi' };
  const mid = clean(memberOpenId);
  if (!mid) return { 成功: false, 错误: '缺少成员 openid' };
  let sec = typeof secondsRaw === 'number' ? secondsRaw : Number(secondsRaw);
  if (!Number.isFinite(sec)) sec = 0;
  sec = Math.trunc(sec);

  const item: Record<string, unknown> = { member_openid: mid };
  if (sec <= 0) {
    item.op = 'del';
    item.mute_expire_at = '';
  } else {
    const clamped = Math.min(sec, MUTE_MAX_SECONDS);
    item.op = 'add';
    item.mute_expire_at = toRfc3339Local(new Date(Date.now() + clamped * 1000));
  }

  try {
    await ctx.callBotApi(`/v2/groups/${gid}/restrict_chat_setting`, {
      __method: 'POST',
      members: [item],
    });
    return {
      成功: true,
      错误: '',
      操作: String(item.op),
      成员: mid,
      到期: String(item.mute_expire_at ?? ''),
    };
  } catch (e) {
    ctx.logger?.warn?.('[mkjianyi] 设置群禁言失败:', (e as Error)?.message || e);
    return failGroupResult(e);
  }
}

/**
 * 解析群身份：speaker / self / 指定 openid（仅当等于发言人或机器人时可解析）。
 * 返回 member|admin|owner，否则 0。
 */
export async function resolveGroupMemberRole(
  ctx: BotApiCaller & { event: Record<string, unknown> },
  target: 'speaker' | 'self' | string,
): Promise<'member' | 'admin' | 'owner' | 0> {
  const event = ctx.event || {};
  if (target === 'speaker') return getCachedGroupMemberRole(event);

  const gid = getGroupOpenId(event);
  if (gid === 0 || !gid) return 0;

  if (target === 'self') {
    const st = await fetchBotGroupState(ctx, String(gid));
    return st?.member_role && st.member_role !== 0 ? st.member_role : 0;
  }

  const want = clean(target);
  if (!want) return 0;
  const authorId = getAuthorOpenId(event);
  if (authorId !== 0 && String(authorId) === want) return getAuthorMemberRole(event);

  const st = await fetchBotGroupState(ctx, String(gid));
  if (st?.member_openid && st.member_openid === want) {
    return st.member_role !== 0 ? st.member_role : 0;
  }
  return 0;
}

type PluginLikeCtx = {
  connectionId?: string;
  frameworkEnv?: {
    projectRoot?: string;
    connectionId?: string;
  };
};

/** 从 connections.json 取当前官方连接的 AppID（拼头像 URL 用） */
export function resolveBotAppId(ctx: PluginLikeCtx | null | undefined): string {
  const root = clean(ctx?.frameworkEnv?.projectRoot);
  if (!root) return '';
  const connId = clean(ctx?.connectionId ?? ctx?.frameworkEnv?.connectionId);
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'connections.json'), 'utf8'),
    ) as { connections?: Array<{ id?: string; type?: string; enable?: boolean; appId?: string }> };
    const list = Array.isArray(raw.connections) ? raw.connections : [];
    const picked =
      (connId ? list.find((c) => c.id === connId) : undefined)
      || list.find((c) => (c.type ?? '') === 'qq_official' && c.enable !== false)
      || list.find((c) => (c.type ?? '') === 'qq_official');
    return clean(picked?.appId);
  } catch {
    return '';
  }
}

/** 收集正文里全部 <@openid>（顺序保留） */
export function getAtList(event: Record<string, unknown>): (string | number)[] {
  const raw = String(event.content ?? '');
  const out: (string | number)[] = [];
  const re = new RegExp(RE_AT.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const id = clean(m[1]);
    if (id) out.push(id);
  }
  return out;
}

export function getAtCount(event: Record<string, unknown>): number {
  return getAtList(event).length;
}

/** 按索引取艾特 openid；越界 → 0 */
export function getAtAt(event: Record<string, unknown>, index: number): string | number {
  if (!Number.isInteger(index) || index < 0) return 0;
  const list = getAtList(event);
  if (index >= list.length) return 0;
  return list[index];
}

export function isOfficialMessageEvent(event: Record<string, unknown>): boolean {
  const t = clean(event.t);
  return t === 'GROUP_AT_MESSAGE_CREATE'
    || t === 'GROUP_MESSAGE_CREATE'
    || t === 'C2C_MESSAGE_CREATE';
}

/** 官方 t → 中文简短名（脚本 [事件] / 事件驱动时的 [文本消息]） */
const EVENT_LABEL_MAP: Record<string, string> = {
  GROUP_ADD_ROBOT: '进群',
  GROUP_DEL_ROBOT: '退群',
  FRIEND_ADD: '加好友',
  FRIEND_DEL: '删好友',
  C2C_MSG_REJECT: '关主动消息',
  C2C_MSG_RECEIVE: '开主动消息',
  GROUP_MSG_REJECT: '关群通知',
  GROUP_MSG_RECEIVE: '开群通知',
  GROUP_MEMBER_ADD: '成员进群',
  GROUP_MEMBER_REMOVE: '成员退群',
  GROUP_JOIN_REQUEST: '进群申请',
  GROUP_AT_MESSAGE_CREATE: '群消息',
  GROUP_MESSAGE_CREATE: '群消息',
  C2C_MESSAGE_CREATE: '私聊',
  INTERACTION_CREATE: '互动',
};

export function eventLabel(eventOrType: Record<string, unknown> | string): string {
  if (typeof eventOrType !== 'string') {
    const auth = getAuthorizeInteraction(eventOrType);
    if (auth) return auth.label;
  }
  const t = typeof eventOrType === 'string'
    ? clean(eventOrType)
    : clean(eventOrType.t);
  if (!t) return '';
  return EVENT_LABEL_MAP[t] || t;
}

const LIFECYCLE_EVENT_TYPES = new Set([
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
  'GROUP_MEMBER_ADD',
  'GROUP_MEMBER_REMOVE',
  'GROUP_JOIN_REQUEST',
]);

export function isLifecycleEvent(event: Record<string, unknown>): boolean {
  return LIFECYCLE_EVENT_TYPES.has(clean(event.t));
}

/**
 * 生命周期事件的回复目标；不可回复返回 null（退群/删好友/关通知等）。
 * 能回的尽量主动发（不强制 event_id，因网关常未注入外层 id）。
 */
export function 取事件回复目标(event: Record<string, unknown>): GfSendTarget | null {
  const t = clean(event.t);
  const gid = clean(event.group_openid ?? event.group_open_id);
  const uid = clean(
    event.openid
    ?? event.user_openid
    ?? event.member_openid
    ?? event.op_member_openid,
  );

  if (
    t === 'GROUP_ADD_ROBOT'
    || t === 'GROUP_MSG_RECEIVE'
    || t === 'GROUP_MEMBER_ADD'
    || t === 'GROUP_MEMBER_REMOVE'
    || t === 'GROUP_JOIN_REQUEST'
  ) {
    if (!gid) return null;
    return { scope: 'group', group_openid: gid };
  }
  if (t === 'FRIEND_ADD' || t === 'C2C_MSG_RECEIVE') {
    if (!uid) return null;
    return { scope: 'c2c', user_openid: uid };
  }
  return null;
}

export function 取发送目标(event: Record<string, unknown>): GfSendTarget {
  const t = clean(event.t);
  const msg_id = clean(event.id);
  if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
    return {
      scope: 'group',
      group_openid: clean(event.group_openid ?? event.group_open_id),
      msg_id: msg_id || undefined,
    };
  }
  if (t === 'C2C_MESSAGE_CREATE') {
    const author = (event.author && typeof event.author === 'object')
      ? (event.author as Record<string, unknown>)
      : {};
    return {
      scope: 'c2c',
      user_openid: clean(
        event.user_openid
        ?? author.user_openid
        ?? author.member_openid
        ?? author.id,
      ),
      msg_id: msg_id || undefined,
    };
  }
  throw new Error(`无法识别发送目标，事件类型: ${t || '未知'}`);
}

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

export type RichPart =
  | { kind: 'text'; text: string }
  | {
    kind: 'media';
    media: MediaKind;
    mode: 'url' | 'local';
    data: string;
    /** 上传 file_name；文件卡片显示名等 */
    fileName?: string;
  };

export type ParsedRichContent = {
  /** 已废弃：官方无引用气泡；保留字段仅为兼容，恒为 null */
  msg_id: null;
  parts: RichPart[];
};

const MEDIA_LABEL: Record<MediaKind, string> = {
  image: '图片',
  voice: '语音',
  video: '视频',
  file: '文件',
};

const MEDIA_FILE_TYPE: Record<MediaKind, 1 | 2 | 3 | 4> = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
};

const RE_REPLY = /^\[引用(?::([^\]]*))?\]/;
const RE_MEDIA_OK = /^\[(图片|语音|视频|文件)\s*,\s*(url|本地)\s*:\s*([^\]]+)\]/;
const RE_MEDIA_ANY = /^\[(图片|语音|视频|文件)[^\]]*\]/;
/** 尾部 `,显示名`：显示名不含逗号、不含路径分隔、非 http(s) */
const RE_MEDIA_NAME_TAIL = /^(.*),([^,]*)$/;

function labelToMedia(label: string): MediaKind {
  if (label === '语音') return 'voice';
  if (label === '视频') return 'video';
  if (label === '文件') return 'file';
  return 'image';
}

/** 从 url/本地 载荷尾部拆出可选「,显示名」 */
function splitMediaDataAndName(raw: string, label: string): { data: string; fileName?: string } {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error(`${label}参数为空`);
  const m = s.match(RE_MEDIA_NAME_TAIL);
  if (!m) return { data: s };
  const data = String(m[1] ?? '').trim();
  const fileName = String(m[2] ?? '').trim();
  if (!data) throw new Error(`${label}参数为空`);
  // 右段像路径/URL 续写时不拆（避免误伤带逗号的 URL）
  if (!fileName) throw new Error(`${label}显示名不能为空`);
  if (/[/\\]/.test(fileName) || /^https?:\/\//i.test(fileName)) {
    return { data: s };
  }
  return { data, fileName };
}

/**
 * 解析发消息内容标记。
 * - [引用] / [引用:id]：官方无引用气泡，仅从正文剥离
 * - [图片|语音|视频|文件,url:…] / […,本地:…]；可选尾部 ,显示名
 *   图片可与文字同条；语音/视频/文件单发不挂文
 */
export function buildMessageSegments(
  content: string,
  _defaultReplyId?: unknown,
): ParsedRichContent {
  const src = String(content ?? '');
  const parts: RichPart[] = [];
  let i = 0;
  let textBuf = '';

  const flushText = () => {
    if (textBuf) {
      parts.push({ kind: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < src.length) {
    if (src[i] === '[') {
      const slice = src.slice(i);
      const reply = slice.match(RE_REPLY);
      if (reply) {
        flushText();
        i += reply[0].length;
        continue;
      }

      const mediaOk = slice.match(RE_MEDIA_OK);
      if (mediaOk) {
        flushText();
        const media = labelToMedia(String(mediaOk[1] ?? '图片'));
        const mode: 'url' | 'local' = mediaOk[2] === '本地' ? 'local' : 'url';
        const label = MEDIA_LABEL[media];
        const { data, fileName } = splitMediaDataAndName(String(mediaOk[3] ?? ''), label);
        parts.push({
          kind: 'media',
          media,
          mode,
          data,
          ...(fileName ? { fileName } : {}),
        });
        i += mediaOk[0].length;
        continue;
      }

      const mediaBad = slice.match(RE_MEDIA_ANY);
      if (mediaBad) {
        const label = String(mediaBad[1] ?? '图片');
        throw new Error(
          `${label}格式不正确（仅支持 [${label},url:…] / [${label},本地:…]，可选 ,显示名）: ${mediaBad[0]}`,
        );
      }
    }

    textBuf += src[i];
    i++;
  }
  flushText();

  return { msg_id: null, parts };
}

async function botApi(
  ctx: ActionCtx,
  apiPath: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return ctx.actions.call(apiPath, params, ctx.adapterName);
}

/** 从发送接口回执中提取 message id（对齐 GF_mk 取发送消息Id） */
export function extractSendMessageId(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const o = result as Record<string, unknown>;
  const data = o.data && typeof o.data === 'object'
    ? (o.data as Record<string, unknown>)
    : o;
  return clean(data.id ?? data.msg_id ?? data.message_id ?? o.id ?? o.msg_id ?? '');
}

export function makeSendResult(
  partial: Partial<KaSendResult> & { 成功: boolean },
): KaSendResult {
  return {
    成功: partial.成功,
    消息id: partial.消息id ?? '',
    条数: partial.条数 ?? 0,
    错误: partial.错误 ?? '',
  };
}

function fillSession(body: Record<string, unknown>, target: GfSendTarget): void {
  if (target.scope === 'group') {
    if (!target.group_openid) throw new Error('缺少 group_openid');
    body.group_openid = target.group_openid;
    return;
  }
  if (!target.user_openid) throw new Error('缺少 user_openid');
  body.openid = target.user_openid;
}

function sendPath(target: GfSendTarget): string {
  if (target.scope === 'group') {
    if (!target.group_openid) throw new Error('缺少 group_openid');
    return `/v2/groups/${target.group_openid}/messages`;
  }
  if (!target.user_openid) throw new Error('缺少 user_openid');
  return `/v2/users/${target.user_openid}/messages`;
}

/** 同一次被动回复常见上限（官方：次数或时间超限） */
export const PASSIVE_REPLY_MAX = 5;

/** 原地改为主动：去掉 msg_id / event_id / msg_seq，同会话后续也不再被动 */
export function toActiveTarget(target: GfSendTarget): void {
  delete target.msg_id;
  delete target.event_id;
  delete target.next_msg_seq;
}

export function isPassiveLimitError(msg: string): boolean {
  return msg.includes('被动回复') && msg.includes('超过限制');
}

function shouldPreferActive(target: GfSendTarget): boolean {
  if (!target.msg_id && !target.event_id) return true;
  return (target.next_msg_seq ?? 1) > PASSIVE_REPLY_MAX;
}

function allocMsgSeq(target: GfSendTarget): number | undefined {
  if (!target.msg_id && !target.event_id) return undefined;
  const seq = target.next_msg_seq ?? 1;
  // 必须在 await 之前递增，并行发消息才不会撞同一个 msg_seq
  target.next_msg_seq = seq + 1;
  return seq;
}

function assemblePayload(
  target: GfSendTarget,
  fields: Record<string, unknown>,
  msgSeq?: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...fields };
  fillSession(base, target);
  // msg_id 与 event_id 互斥；优先消息被动
  if (target.msg_id) {
    base.msg_id = target.msg_id;
    if (msgSeq != null) base.msg_seq = msgSeq;
  } else if (target.event_id) {
    base.event_id = target.event_id;
    if (msgSeq != null) base.msg_seq = msgSeq;
  }
  return base;
}

async function uploadMedia(
  ctx: ActionCtx,
  target: GfSendTarget,
  part: Extract<RichPart, { kind: 'media' }>,
): Promise<string> {
  const fileType = MEDIA_FILE_TYPE[part.media];
  const label = MEDIA_LABEL[part.media];
  if (part.mode === 'url') {
    return uploadMediaByUrl(ctx, target, fileType, part.data, label, part.fileName);
  }
  return uploadMediaByLocal(ctx, target, fileType, part.data, label, part.fileName);
}

async function fetchUrlBuffer(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`下载${label}失败 ${res.status}: ${t.slice(0, 200) || url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`下载${label}为空: ${url}`);
  return buf;
}

async function uploadMediaByUrl(
  ctx: ActionCtx,
  target: GfSendTarget,
  fileType: 1 | 2 | 3 | 4,
  url: string,
  label: string,
  fileName?: string,
): Promise<string> {
  const name = clean(fileName);
  // 官方 URL 直传会忽略 file_name；有自定义显示名时改为本地下载再分片上传
  if (name) {
    const buf = await fetchUrlBuffer(url, label);
    return uploadMediaFromBuffer(ctx, target, fileType, buf, name, label);
  }

  const body: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: false,
    url,
  };
  if (target.scope === 'group') {
    if (!target.group_openid) throw new Error('缺少 group_openid');
    body.group_openid = target.group_openid;
    const res = await botApi(ctx, `/v2/groups/${target.group_openid}/files`, body) as {
      file_info?: string;
    };
    const info = clean(res?.file_info);
    if (!info) throw new Error('富媒体上传未返回 file_info');
    return info;
  }
  if (!target.user_openid) throw new Error('缺少 user_openid');
  body.openid = target.user_openid;
  const res = await botApi(ctx, `/v2/users/${target.user_openid}/files`, body) as {
    file_info?: string;
  };
  const info = clean(res?.file_info);
  if (!info) throw new Error('富媒体上传未返回 file_info');
  return info;
}

const MD5_10M_BYTES = 10002432;

type UploadPart = {
  index?: number;
  presigned_url?: string;
  block_size?: string | number;
};

type UploadPrepareResult = {
  upload_id?: string;
  block_size?: string | number;
  parts?: UploadPart[];
};

function hashHex(algo: 'md5' | 'sha1', buf: Buffer): string {
  return crypto.createHash(algo).update(buf).digest('hex');
}

function filesBasePath(target: GfSendTarget): string {
  if (target.scope === 'group') {
    if (!target.group_openid) throw new Error('缺少 group_openid');
    return `/v2/groups/${target.group_openid}`;
  }
  if (!target.user_openid) throw new Error('缺少 user_openid');
  return `/v2/users/${target.user_openid}`;
}

/** 官方分片：本地路径 → file_info */
async function uploadMediaByLocal(
  ctx: ActionCtx,
  target: GfSendTarget,
  fileType: 1 | 2 | 3 | 4,
  relOrAbs: string,
  label: string,
  customFileName?: string,
): Promise<string> {
  const abs = resolvePluginRelativePath(String(ctx.pluginPath ?? ''), relOrAbs);
  if (!fs.existsSync(abs)) {
    throw new Error(`本地${label}不存在: ${abs}`);
  }
  const buf = fs.readFileSync(abs);
  if (!buf.length) throw new Error(`本地${label}为空: ${abs}`);
  const fileName = clean(customFileName) || path.basename(abs);
  const info = await uploadMediaFromBuffer(ctx, target, fileType, buf, fileName, label);
  ctx.logger?.debug?.(`[mkjianyi] 本地${label}上传成功 ${abs} → file_info`);
  return info;
}

/** 官方分片：内存缓冲 → file_info（本地与「URL+自定义名」共用） */
async function uploadMediaFromBuffer(
  ctx: ActionCtx,
  target: GfSendTarget,
  fileType: 1 | 2 | 3 | 4,
  buf: Buffer,
  fileName: string,
  label: string,
): Promise<string> {
  const md5 = hashHex('md5', buf);
  const sha1 = hashHex('sha1', buf);
  const md5_10m = hashHex('md5', buf.subarray(0, Math.min(buf.length, MD5_10M_BYTES)));
  const base = filesBasePath(target);

  const prepare = await botApi(ctx, `${base}/upload_prepare`, {
    file_type: fileType,
    file_size: String(buf.length),
    file_name: fileName,
    md5,
    sha1,
    md5_10m,
  }) as UploadPrepareResult;

  const uploadId = clean(prepare?.upload_id);
  if (!uploadId) throw new Error('upload_prepare 未返回 upload_id');

  const parts = Array.isArray(prepare.parts) ? prepare.parts : [];
  if (!parts.length) {
    throw new Error('upload_prepare 未返回分片 parts');
  }

  const defaultBlock = Number(prepare.block_size) || 5 * 1024 * 1024;
  const sorted = [...parts].sort(
    (a, b) => (typeof a.index === 'number' ? a.index : 0) - (typeof b.index === 'number' ? b.index : 0),
  );
  let offset = 0;
  for (const part of sorted) {
    const idx = typeof part.index === 'number' ? part.index : 0;
    const url = clean(part.presigned_url);
    if (!url) throw new Error(`分片 ${idx} 缺少预签名 URL`);
    const partSize = Number(part.block_size) || Math.min(defaultBlock, buf.length - offset);
    const chunk = buf.subarray(offset, Math.min(offset + partSize, buf.length));
    offset += chunk.length;

    const putRes = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(chunk),
    });
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => '');
      throw new Error(`分片 PUT 失败 ${putRes.status}: ${t.slice(0, 200)}`);
    }

    await botApi(ctx, `${base}/upload_part_finish`, {
      upload_id: uploadId,
      part_index: idx,
      block_size: String(chunk.length),
      md5: hashHex('md5', chunk),
    });
  }

  const mergeBody: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: false,
    upload_id: uploadId,
    file_name: fileName,
  };
  if (target.scope === 'group') mergeBody.group_openid = target.group_openid;
  else mergeBody.openid = target.user_openid;

  const merged = await botApi(ctx, `${base}/files`, mergeBody) as { file_info?: string };
  const info = clean(merged?.file_info);
  if (!info) throw new Error(`${label}分片合并未返回 file_info`);
  return info;
}

type SendBatch =
  | { kind: 'text'; content: string }
  | { kind: 'markdown'; content: string; keyboard?: GfKeyboardContent }
  | {
    kind: 'media';
    media: Extract<RichPart, { kind: 'media' }>;
    /** 仅图片可挂说明；语音/视频/文件恒无 */
    content?: string;
  };

/** MD 图片缺 #Wpx #Hpx 时补默认尺寸（对齐 GF_mk） */
export function ensureMdImageSize(content: string): string {
  return content.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi,
    (match, alt: string, url: string) => {
      if (/#\d+px/i.test(alt)) return match;
      const text = String(alt ?? '').trim() || 'img';
      return `![${text}#640px #360px](${url})`;
    },
  );
}

/**
 * 官方 Markdown 参数指令：点击蓝字后在输入框插入 text。
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 */
export function mdCmdInput(
  fillText: unknown,
  showText?: unknown,
  withReference = false,
): string {
  const fill = String(fillText ?? '');
  const showRaw = showText == null || String(showText) === '' ? fill : String(showText);
  const text = encodeURIComponent(fill);
  const show = encodeURIComponent(showRaw);
  const reference = withReference ? 'true' : 'false';
  return `<qqbot-cmd-input text="${text}" show="${show}" reference="${reference}"/>`;
}

/**
 * 官方 Markdown 回车指令：点击蓝字后直接发送（群聊/文字子频道不支持，建议私聊测）。
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 */
export function mdCmdEnter(sendText: unknown, showText?: unknown): string {
  const cmd = String(sendText ?? '');
  const label = showText == null || String(showText) === '' ? cmd : String(showText);
  const encoded = encodeURIComponent(cmd);
  return `[${label}](mqqapi://aio/inlinecmd?command=${encoded}&reply=false&enter=true)`;
}

/** 构造回调按钮（action.type=1）；样式仅 1蓝 / 2白 / 3红，其它回退为蓝 */
export function makeCallbackButton(
  id: unknown,
  label: unknown,
  data: unknown,
  style: unknown = 1,
  visitedLabel?: unknown,
  permissionType: unknown = 2,
  specifyUserIds?: unknown,
): GfKeyboardButton {
  const text = String(label ?? '').trim() || '按钮';
  const visited = String(visitedLabel ?? '').trim() || text;
  const n = Math.trunc(Number(style));
  const st = (n === 1 || n === 2 || n === 3 ? n : 1) as 1 | 2 | 3;
  const perm = Math.trunc(Number(permissionType));
  const permType = Number.isFinite(perm) && perm >= 0 && perm <= 3 ? perm : 2;
  const users = parseIdList(specifyUserIds);
  let dataStr = String(data ?? '');
  if (permType === 1) {
    dataStr = wrapAdminOnlyButtonData(dataStr);
    adminOnlyButtonData.add(dataStr);
    adminOnlyButtonData.add(unwrapAdminOnlyButtonData(dataStr).data);
  }
  return {
    id: String(id ?? '').trim() || `btn_${Date.now()}`,
    render_data: { label: text, visited_label: visited, style: st },
    action: {
      type: 1,
      permission: {
        type: permType,
        ...(users.length ? { specify_user_ids: users } : {}),
      },
      data: dataStr,
      unsupport_tips: '当前客户端不支持此操作',
    },
  };
}

/** 跳转按钮（action.type=0）；data 填 http / 小程序 scheme */
export function makeLinkButton(
  id: unknown,
  label: unknown,
  url: unknown,
  style: unknown = 1,
  visitedLabel?: unknown,
): GfKeyboardButton {
  const text = String(label ?? '').trim() || '打开';
  const visited = String(visitedLabel ?? '').trim() || text;
  const n = Math.trunc(Number(style));
  const st = (n === 1 || n === 2 || n === 3 ? n : 1) as 1 | 2 | 3;
  return {
    id: String(id ?? '').trim() || `link_${Date.now()}`,
    render_data: { label: text, visited_label: visited, style: st },
    action: {
      type: 0,
      permission: { type: 2 },
      data: String(url ?? '').trim(),
      unsupport_tips: '当前客户端不支持此操作',
    },
  };
}

/** 指令按钮（action.type=2）；enter=true 时点击直接发送（群聊不支持） */
export function makeCommandButton(
  id: unknown,
  label: unknown,
  data: unknown,
  style: unknown = 1,
  visitedLabel?: unknown,
  enter: unknown = false,
  reply: unknown = false,
): GfKeyboardButton {
  const text = String(label ?? '').trim() || '指令';
  const visited = String(visitedLabel ?? '').trim() || text;
  const n = Math.trunc(Number(style));
  const st = (n === 1 || n === 2 || n === 3 ? n : 1) as 1 | 2 | 3;
  return {
    id: String(id ?? '').trim() || `cmd_${Date.now()}`,
    render_data: { label: text, visited_label: visited, style: st },
    action: {
      type: 2,
      permission: { type: 2 },
      data: String(data ?? ''),
      enter: isTruthyFlag(enter),
      reply: isTruthyFlag(reply),
      unsupport_tips: '当前客户端不支持此操作',
    },
  };
}

function parseIdList(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
      }
    } catch {
      /* fallthrough */
    }
  }
  return s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

function isTruthyFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === '是';
}

/** 构造一行按钮 */
export function makeButtonRow(...buttons: unknown[]): GfKeyboardRow {
  const list: GfKeyboardButton[] = [];
  for (const b of buttons) {
    if (b && typeof b === 'object' && Array.isArray((b as GfKeyboardRow).buttons)) {
      list.push(...(b as GfKeyboardRow).buttons);
      continue;
    }
    if (b && typeof b === 'object' && 'action' in (b as object)) {
      list.push(b as GfKeyboardButton);
    }
  }
  return { buttons: list };
}

/** 构造 keyboard.content */
export function makeKeyboard(...rows: unknown[]): GfKeyboardContent {
  const out: GfKeyboardRow[] = [];
  for (const r of rows) {
    if (r && typeof r === 'object' && Array.isArray((r as GfKeyboardContent).rows)) {
      out.push(...(r as GfKeyboardContent).rows);
      continue;
    }
    if (r && typeof r === 'object' && Array.isArray((r as GfKeyboardRow).buttons)) {
      out.push(r as GfKeyboardRow);
    }
  }
  return { rows: out };
}

/** 第二参：整盘键盘，或单行（自动包成 rows） */
export function normalizeKeyboard(raw: unknown): GfKeyboardContent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.rows)) {
    return { rows: o.rows as GfKeyboardRow[] };
  }
  if (Array.isArray(o.buttons)) {
    return { rows: [{ buttons: o.buttons as GfKeyboardButton[] }] };
  }
  return undefined;
}

export function isInteractionEvent(event: Record<string, unknown>): boolean {
  return clean(event.t) === 'INTERACTION_CREATE';
}

export type GfButtonData = { id: string; data: string };

function interactionResolved(event: Record<string, unknown>): Record<string, unknown> | null {
  const payload = (event.data && typeof event.data === 'object')
    ? (event.data as Record<string, unknown>)
    : {};
  if (payload.resolved && typeof payload.resolved === 'object') {
    return payload.resolved as Record<string, unknown>;
  }
  // 官方偶发拼写
  if (payload.resoloved && typeof payload.resoloved === 'object') {
    return payload.resoloved as Record<string, unknown>;
  }
  return null;
}

/**
 * 资料页开关主动消息 / 群通知：走 INTERACTION type=18/19（authorize_data），
 * 不是旧的 C2C_MSG_RECEIVE / GROUP_MSG_*。
 * switch=true → 开；switch=false 或缺省 → 关（官方示例常无 switch 字段）。
 */
export type AuthorizeInteraction = {
  label: '开主动消息' | '关主动消息' | '开群通知' | '关群通知';
  /** 关类不可发消息 */
  canReply: boolean;
  scope: 'c2c_push' | 'group_push';
};

export function getAuthorizeInteraction(
  event: Record<string, unknown>,
): AuthorizeInteraction | null {
  if (!isInteractionEvent(event)) return null;
  const outerType = Number(event.type);
  const resolved = interactionResolved(event);
  const authRaw = resolved?.authorize_data;
  if (!authRaw || typeof authRaw !== 'object') return null;
  const auth = authRaw as Record<string, unknown>;
  const scope = clean(auth.scope);
  if (scope !== 'c2c_push' && scope !== 'group_push') return null;

  // type 18 用户授权 / 19 群授权；有 authorize_data 即认
  if (outerType && outerType !== 18 && outerType !== 19) {
    // 仍以 authorize_data 为准（部分网关 type 可能缺失）
  }

  const sw = auth.switch;
  const isOn = sw === true || sw === 1 || sw === 'true' || sw === '1';

  if (scope === 'c2c_push') {
    return isOn
      ? { label: '开主动消息', canReply: true, scope }
      : { label: '关主动消息', canReply: false, scope };
  }
  return isOn
    ? { label: '开群通知', canReply: true, scope }
    : { label: '关群通知', canReply: false, scope };
}

/** 从 INTERACTION_CREATE 取按钮 id / data */
export function getButtonData(event: Record<string, unknown>): GfButtonData | null {
  if (!isInteractionEvent(event)) return null;
  const resolved = interactionResolved(event);
  if (!resolved) return null;
  const id = clean(resolved.button_id);
  const data = String(resolved.button_data ?? '').trim();
  if (!data && !id) return null;
  return { id, data };
}

/**
 * 互动事件的发送目标（主动：不带 msg_id）。
 * 对齐 GF_mk：互动回复走主动消息。
 */
export function 取互动目标(event: Record<string, unknown>): GfSendTarget {
  const scene = clean(event.scene).toLowerCase();
  const chat_type = Number(event.chat_type);
  const author = (event.author && typeof event.author === 'object')
    ? (event.author as Record<string, unknown>)
    : {};
  const group_openid = clean(event.group_openid ?? event.group_open_id);
  const user_openid = clean(
    event.user_openid
    ?? event.group_member_openid
    ?? author.user_openid
    ?? author.member_openid
    ?? author.id,
  );

  if (chat_type === 1 || scene === 'group') {
    if (!group_openid) throw new Error('互动缺少 group_openid');
    return { scope: 'group', group_openid };
  }
  if (chat_type === 2 || scene === 'c2c') {
    if (!user_openid) throw new Error('互动缺少 user_openid');
    return { scope: 'c2c', user_openid };
  }
  if (group_openid) return { scope: 'group', group_openid };
  if (user_openid) return { scope: 'c2c', user_openid };
  throw new Error(`无法识别互动场景 chat_type=${chat_type} scene=${scene || '?'}`);
}

/** PUT /interactions/{id} 应答，避免客户端一直 loading */
export async function ackInteraction(
  ctx: ActionCtx,
  interactionId: unknown,
  code = 0,
): Promise<void> {
  const id = clean(interactionId);
  if (!id) throw new Error('interaction id 为空');
  await botApi(ctx, `/interactions/${id}`, { code, __method: 'PUT' });
}

/**
 * 打包规则：
 * - 每条最多 1 个富媒体（msg_type=7）
 * - 图片：前后文字可挂到同条 content
 * - 语音/视频/文件：单发不挂文；积压文字另拆文本批
 */
export function planBatches(parts: RichPart[]): SendBatch[] {
  const batches: SendBatch[] = [];
  let pending = '';

  const flushPendingText = () => {
    if (!pending) return;
    batches.push({ kind: 'text', content: pending });
    pending = '';
  };

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.kind === 'text') {
      if (p.text) pending = pending ? `${pending}${p.text}` : p.text;
      continue;
    }

    if (p.media === 'image') {
      let caption = pending;
      pending = '';
      i += 1;
      while (i < parts.length && parts[i]!.kind === 'text') {
        const t = (parts[i] as Extract<RichPart, { kind: 'text' }>).text;
        caption = caption ? `${caption}${t}` : t;
        i += 1;
      }
      i -= 1;
      batches.push({
        kind: 'media',
        media: p,
        content: caption || undefined,
      });
      continue;
    }

    // 语音 / 视频 / 文件：先冲刷积压文字，再单发媒体（不吸收后续文字到 content）
    flushPendingText();
    batches.push({ kind: 'media', media: p });
  }
  flushPendingText();
  return batches;
}

async function sendBatchOnce(
  ctx: ActionCtx,
  target: GfSendTarget,
  batch: SendBatch,
  seq: number | undefined,
): Promise<unknown> {
  const apiPath = sendPath(target);
  if (batch.kind === 'text') {
    return botApi(ctx, apiPath, assemblePayload(target, {
      msg_type: 0,
      content: batch.content,
    }, seq));
  }
  if (batch.kind === 'markdown') {
    const body: Record<string, unknown> = {
      msg_type: 2,
      markdown: { content: batch.content },
    };
    if (batch.keyboard?.rows?.length) {
      const kb = patchKeyboardAdminPermission(batch.keyboard, ctx.event, ctx.logger);
      body.keyboard = { content: kb };
    }
    return botApi(ctx, apiPath, assemblePayload(target, body, seq));
  }
  const fileInfo = await uploadMedia(ctx, target, batch.media);
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
  };
  if (batch.media.media === 'image' && batch.content) {
    body.content = batch.content;
  }
  return botApi(ctx, apiPath, assemblePayload(target, body, seq));
}

/**
 * 发一条 batch：满被动额度则改主动；被动超限错误则清 msg_id 后重试主动。
 */
async function sendOneBatch(
  ctx: ActionCtx,
  target: GfSendTarget,
  batch: SendBatch,
): Promise<unknown> {
  if (shouldPreferActive(target) && (target.msg_id || target.event_id)) {
    toActiveTarget(target);
    ctx.logger?.info?.('[mkjianyi] 被动条数将超限，改为主动发送');
  }

  const wasPassive = Boolean(target.msg_id || target.event_id);
  const seq = allocMsgSeq(target);
  try {
    return await sendBatchOnce(ctx, target, batch, seq);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (wasPassive && isPassiveLimitError(msg)) {
      toActiveTarget(target);
      ctx.logger?.warn?.('[mkjianyi] 被动超限，改为主动重试:', msg);
      return sendBatchOnce(ctx, target, batch, undefined);
    }
    throw e;
  }
}

/** 按解析结果向官方 API 发送（可多条：文本 / 图），返回汇总回执 */
export async function sendParsedContent(
  ctx: ActionCtx,
  target: GfSendTarget,
  parsed: ParsedRichContent,
): Promise<KaSendResult> {
  // 不克隆 target：next_msg_seq / 被动→主动 必须写回共享对象
  const batches = planBatches(parsed.parts);
  if (!batches.length) {
    // 允许空文本（例如只有引用）
    batches.push({ kind: 'text', content: '' });
  }

  let lastId = '';
  let count = 0;

  try {
    for (const batch of batches) {
      const res = await sendOneBatch(ctx, target, batch);
      count += 1;
      const id = extractSendMessageId(res);
      if (id) lastId = id;
    }
    return makeSendResult({ 成功: true, 消息id: lastId, 条数: count, 错误: '' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return makeSendResult({ 成功: false, 消息id: lastId, 条数: count, 错误: msg });
  }
}

/** 回复当前会话（支持 [图片,…]；[引用] 仅剥离）。传入共享 target 以递增 msg_seq。 */
export async function replyText(
  ctx: ActionCtx,
  target: GfSendTarget,
  text: string,
): Promise<KaSendResult> {
  const parsed = buildMessageSegments(text);
  return sendParsedContent(ctx, target, parsed);
}

/** 原生 Markdown（msg_type=2）；不解析富媒体标记；可选底部 keyboard */
export async function replyMarkdown(
  ctx: ActionCtx,
  target: GfSendTarget,
  content: string,
  keyboard?: GfKeyboardContent,
): Promise<KaSendResult> {
  const md = ensureMdImageSize(String(content ?? ''));
  try {
    const kb = keyboard?.rows?.length
      ? patchKeyboardAdminPermission(keyboard, ctx.event, ctx.logger)
      : keyboard;
    const res = await sendOneBatch(ctx, target, {
      kind: 'markdown',
      content: md,
      ...(kb?.rows?.length ? { keyboard: kb } : {}),
    });
    return makeSendResult({
      成功: true,
      消息id: extractSendMessageId(res),
      条数: 1,
      错误: '',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: msg });
  }
}

/**
 * 指定目标发送。
 * targetKind：`群` → group_openid；`私` → user_openid
 * 内容支持 [图片,…]；[引用] 仅剥离
 */
export async function sendDetailedText(
  ctx: ActionCtx,
  event: Record<string, unknown>,
  targetKind: unknown,
  targetId: unknown,
  text: string,
): Promise<KaSendResult> {
  const kind = String(targetKind ?? '').trim();
  const id = clean(targetId);
  if (!id || id === '0') {
    return makeSendResult({
      成功: false,
      消息id: '',
      条数: 0,
      错误: `发详细消息：目标 openid 无效: ${String(targetId)}`,
    });
  }

  let target: GfSendTarget;
  if (kind === '群') {
    target = { scope: 'group', group_openid: id };
  } else if (kind === '私') {
    target = { scope: 'c2c', user_openid: id };
  } else {
    return makeSendResult({
      成功: false,
      消息id: '',
      条数: 0,
      错误: `发详细消息：第一参数须为 "群" 或 "私"，收到: ${kind}`,
    });
  }

  const parsed = buildMessageSegments(text);
  return sendParsedContent(ctx, target, parsed);
}

/**
 * 撤回当前会话中的消息（群 / 私聊 DELETE）。
 * - 自己发的消息约 2 分钟内可撤
 * - 群内撤他人需机器人管理员权限
 */
export async function recallMessage(
  ctx: ActionCtx,
  target: Pick<GfSendTarget, 'scope' | 'group_openid' | 'user_openid'>,
  messageId: unknown,
): Promise<KaSendResult> {
  const id = clean(messageId);
  if (!id || id === '0') {
    return makeSendResult({
      成功: false,
      消息id: '',
      条数: 0,
      错误: '撤回：消息id 为空',
    });
  }
  try {
    if (target.scope === 'group') {
      const gid = clean(target.group_openid);
      if (!gid) throw new Error('缺少 group_openid');
      await botApi(ctx, `/v2/groups/${gid}/messages/${id}`, { __method: 'DELETE' });
    } else {
      const uid = clean(target.user_openid);
      if (!uid) throw new Error('缺少 user_openid');
      await botApi(ctx, `/v2/users/${uid}/messages/${id}`, { __method: 'DELETE' });
    }
    return makeSendResult({ 成功: true, 消息id: id, 条数: 1, 错误: '' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return makeSendResult({ 成功: false, 消息id: id, 条数: 0, 错误: msg });
  }
}
