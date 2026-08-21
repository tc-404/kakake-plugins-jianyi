/**
 * 开发自检：只验证转接器语句能力，不绑定任何官方/示例 .ka 文件。
 * 成品插件运行时会动态扫描「文本类插件」下全部 .ka，用户自写即可。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDefaultBuiltins } from '../src/ka/builtins.js';
import {
  buildMessageSegments,
  ensureMdImageSize,
  eventLabel,
  getAuthorizeInteraction,
  getButtonData,
  isLifecycleEvent,
  isPassiveLimitError,
  makeButtonRow,
  makeCallbackButton,
  makeLinkButton,
  makeCommandButton,
  makeKeyboard,
  makeSendResult,
  mdCmdEnter,
  mdCmdInput,
  normalizeKeyboard,
  planBatches,
  PASSIVE_REPLY_MAX,
  replyText,
  toActiveTarget,
  取事件回复目标,
  type GfSendTarget,
} from '../src/ka/message.js';
import { resolvePluginRelativePath } from '../src/lib/paths.js';
import { formatDateByPattern, formatKaTime, parseTimestampToDate } from '../src/lib/time.js';
import { coerceToFiniteNumber, runKaScript } from '../src/ka/runtime.js';
import { parseExpr, parseKaSource } from '../src/ka/parser.js';
import type { KaSendResult } from '../src/ka/types.js';

const smokeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

registerDefaultBuiltins();

let sendSeq = 0;

function mockReply(text: string): KaSendResult {
  sendSeq += 1;
  return makeSendResult({
    成功: true,
    消息id: `MID_${sendSeq}`,
    条数: 1,
    错误: '',
  });
}

async function runSnippet(source: string, text: string): Promise<string[]> {
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(source),
    {
      text,
      event: {},
      logger: console,
      sendText: async (t) => {
        outs.push(`reply:${t}`);
        return mockReply(t);
      },
      sendDetailed: async (kind, id, t) => {
        outs.push(`detail:${kind}|${id}|${t}`);
        return mockReply(String(t));
      },
      sendMarkdown: async (t, kb) => {
        outs.push(kb ? `mdkb:${t}` : `md:${t}`);
        return mockReply(String(t));
      },
      recall: async (messageId) => {
        outs.push(`recall:${messageId}`);
        return makeSendResult({ 成功: true, 消息id: String(messageId ?? ''), 条数: 1, 错误: '' });
      },
    },
    'inline.ka',
    new Map(),
  );
  return outs;
}

function mockCtx(outs: string[], event: Record<string, unknown> = {}) {
  return {
    text: '',
    event,
    logger: console,
    sendText: async (t: string) => {
      outs.push(String(t));
      return mockReply(t);
    },
    sendDetailed: async () => makeSendResult({ 成功: true, 消息id: 'D', 条数: 1, 错误: '' }),
    sendMarkdown: async (t: string, kb?: unknown) => {
      outs.push(kb ? `mdkb:${t}` : `md:${t}`);
      if (kb) outs.push(`kb:${JSON.stringify(normalizeKeyboard(kb) ?? kb)}`);
      return mockReply(t);
    },
    recall: async (messageId: unknown) => {
      outs.push(`recall:${messageId}`);
      return makeSendResult({ 成功: true, 消息id: String(messageId ?? ''), 条数: 1, 错误: '' });
    },
    callBotApi: async (apiPath: string, params?: Record<string, unknown>) => {
      const method = String(params?.__method || 'POST');
      outs.push(`api:${method}:${apiPath}`);
      const path = String(apiPath);
      if (path.endsWith('/bot_state')) {
        return {
          member_openid: 'BOT_OPEN_1',
          member_role: 'admin',
          joined_at: '2025-06-15T14:30:00+08:00',
          allow_proactive_msg: false,
          recv_msg_setting: 'only_mention',
        };
      }
      if (path.endsWith('/info')) {
        return {
          group_openid: 'G_OPEN_1',
          group_name: '测试群',
          group_finger_memo: '简介',
          group_class_text: '兴趣',
          group_tags: ['a', 'b'],
          group_member_num: 42,
        };
      }
      if (path.endsWith('/restrict_chat_setting') && method === 'GET') {
        return {
          global_rule: { mode: 'none' },
          members: [
            { member_openid: 'M1', username: '小明', mute_expire_at: '2026-08-15T12:00:00+08:00' },
          ],
        };
      }
      if (path.endsWith('/restrict_chat_setting') && method === 'POST') {
        return {};
      }
      throw new Error(`mock missing api ${apiPath}`);
    },
  };
}

let ok = true;

function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('OK', name);
  else {
    console.error('FAIL', name, detail);
    ok = false;
  }
}

{
  const outs = await runSnippet(
    `
[如果]([文本消息] == "ping"){
    临时定义 a = "p"
    a += "ong"
    发消息(a)
    [结束]
}
`,
    'ping',
  );
  assert('发消息 + 临时变量', outs[0] === 'reply:pong', outs);
}

{
  const outs = await runSnippet(
    `
全局定义 g = "ok"
[如果]([文本消息] == "g"){
    发消息(g)
    [结束]
}
`,
    'g',
  );
  assert('全局定义', outs[0] === 'reply:ok', outs);
}

{
  const outs = await runSnippet(
    `
[如果]([文本消息] == "d"){
    发详细消息("群", 123456, "hi")
    [结束]
}
`,
    'd',
  );
  assert('发详细消息', outs[0] === 'detail:群|123456|hi', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "m"){
    发消息([群号])
    发消息([发言人])
    [结束]
}
`),
    {
      ...mockCtx(outs, {
        group_openid: 'G_OPEN_998877',
        author: { member_openid: 'U_OPEN_112233' },
      }),
      text: 'm',
    },
    'ids.ka',
    new Map(),
  );
  assert('群号/发言人', outs[0] === 'G_OPEN_998877' && outs[1] === 'U_OPEN_112233', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "z"){
    发消息([群号])
    发消息([发言人])
    [结束]
}
`),
    { ...mockCtx(outs), text: 'z' },
    'zero.ka',
    new Map(),
  );
  assert('群号/发言人为空→0', outs[0] === '0' && outs[1] === '0', outs);
}

{
  const outs = await runSnippet(
    `
[如果]([文本消息] == "测试4"){
    [临时定义] a = 111
    [临时定义] b = 222
    [如果](a > b){
        发消息("成功")
    }[反之]{
        发消息("失败")
    }
}
`,
    '测试4',
  );
  assert('嵌套如果+反之', outs[0] === 'reply:失败', outs);
}

{
  // 字符串参与比大小 → 条件不成立 → 走反之
  const outs = await runSnippet(
    `
[如果]([文本消息] == "cmp"){
    [临时定义] a = "999"
    [临时定义] b = 1
    [如果](a > b){
        发消息("成功")
    }[反之]{
        发消息("失败")
    }
}
`,
    'cmp',
  );
  assert('字符串比大小→不成立', outs[0] === 'reply:失败', outs);
}

{
  const outs = await runSnippet(
    `
[如果]([文本消息] == "测试4-1"){
    [临时定义] 加 = 1 + 2
    [临时定义] 连算 = 1 + 2 * 3
    [临时定义] 括号 = (1 + 2) * 3
    [临时定义] 综合 = (10 - 4) / 2 + 3 * 2
    [临时定义] 出 = "{加},{连算},{括号},{综合}"
    发消息(出)
    [结束]
}
`,
    '测试4-1',
  );
  assert('算式+插值拼接', outs[0] === 'reply:3,7,9,9', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "mid"){
    发消息([消息ID])
    [结束]
}
`),
    { ...mockCtx(outs, { id: 'MSG_99887766' }), text: 'mid' },
    'mid.ka',
    new Map(),
  );
  assert('消息ID', outs[0] === 'MSG_99887766', outs);
}

{
  const segs = buildMessageSegments(
    '[引用]前[图片,url:https://a.com/x.png]中[引用:999]后[图片,本地:数据文件/cover.png]',
  );
  // [引用] 仅剥离；msg_id 恒 null；图片仍按出现解析
  const texts = segs.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('');
  assert(
    '引用剥离+图片段序',
    segs.msg_id === null
    && !texts.includes('[引用')
    && segs.parts.some((p) => p.kind === 'media' && p.media === 'image' && p.mode === 'url' && p.data === 'https://a.com/x.png')
    && segs.parts.some((p) => p.kind === 'media' && p.media === 'image' && p.mode === 'local' && p.data === '数据文件/cover.png')
    && segs.parts.filter((p) => p.kind === 'text').length >= 1,
    segs,
  );
}

{
  let threw = false;
  let err = '';
  try {
    buildMessageSegments('[图片,base64:abc]');
  } catch (e) {
    threw = true;
    err = e instanceof Error ? e.message : String(e);
  }
  assert('base64图片拒绝', threw && err.includes('url') && err.includes('本地'), err);
}

{
  const abs = resolvePluginRelativePath(smokeRoot, '数据文件/cover.png');
  assert(
    '插件相对路径解析',
    abs === path.resolve(smokeRoot, '数据文件', 'cover.png'),
    abs,
  );
  let emptyThrew = false;
  try {
    resolvePluginRelativePath('', '数据文件/cover.png');
  } catch {
    emptyThrew = true;
  }
  assert('缺少pluginPath报错', emptyThrew);
}

{
  // 图+图+文 → 两张图各一条；后置文字挂到第2张（官方允许图带文，每条最多1图）
  const segs = buildMessageSegments(
    '[图片,url:https://a.com/1.png][图片,url:https://a.com/2.png]\n说明文字',
  );
  const batches = planBatches(segs.parts);
  assert(
    '多图拆批',
    batches.length === 2
    && batches[0]?.kind === 'media'
    && batches[0].media.media === 'image'
    && !batches[0].content
    && batches[1]?.kind === 'media'
    && batches[1].media.media === 'image'
    && String(batches[1].content || '').includes('说明文字'),
    batches,
  );
}

{
  // 文+语音+文 → 文本 / 语音(无content) / 文本
  const segs = buildMessageSegments('前[语音,url:https://a.com/a.mp3]后');
  const batches = planBatches(segs.parts);
  assert(
    '语音单发不挂文',
    batches.length === 3
    && batches[0]?.kind === 'text'
    && String(batches[0].content).includes('前')
    && batches[1]?.kind === 'media'
    && batches[1].media.media === 'voice'
    && !batches[1].content
    && batches[2]?.kind === 'text'
    && String(batches[2].content).includes('后'),
    batches,
  );
}

{
  const segs = buildMessageSegments(
    '[语音,本地:数据文件/将军.mp3][视频,本地:数据文件/70.mp4][文件,url:https://a.com/a.json]',
  );
  assert(
    '语音视频文件解析',
    segs.parts.length === 3
    && segs.parts[0]?.kind === 'media' && segs.parts[0].media === 'voice'
    && segs.parts[1]?.kind === 'media' && segs.parts[1].media === 'video'
    && segs.parts[2]?.kind === 'media' && segs.parts[2].media === 'file',
    segs.parts,
  );
}

{
  const segs = buildMessageSegments(
    '[文件,本地:数据文件/404.html,自定义说明.html]',
  );
  const p = segs.parts[0];
  assert(
    '文件自定义显示名',
    p?.kind === 'media'
    && p.media === 'file'
    && p.mode === 'local'
    && p.data === '数据文件/404.html'
    && p.fileName === '自定义说明.html',
    p,
  );
}

{
  const segs = buildMessageSegments(
    '[文件,url:https://a.com/a.json,赞助说明.json]',
  );
  const p = segs.parts[0];
  assert(
    'URL文件自定义显示名',
    p?.kind === 'media'
    && p.media === 'file'
    && p.mode === 'url'
    && p.data === 'https://a.com/a.json'
    && p.fileName === '赞助说明.json',
    p,
  );
}

{
  let threw = false;
  try {
    buildMessageSegments('[文件,本地:数据文件/404.html,]');
  } catch {
    threw = true;
  }
  assert('文件空名拒绝', threw);
}

{
  let threw = false;
  try {
    buildMessageSegments('[图片,file:x]', 1);
  } catch {
    threw = true;
  }
  assert('非法图片格式拒绝', threw);
}

{
  let threw = false;
  try {
    buildMessageSegments('[语音,base64:x]');
  } catch {
    threw = true;
  }
  assert('非法语音格式拒绝', threw);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "at"){
    发消息([取艾特数])
    发消息([取艾特])
    发消息([取艾特:1])
    发消息([取艾特;9])
    [结束]
}
`),
    {
      ...mockCtx(outs, {
        content: '<@OPEN111> hi <@OPEN222>',
      }),
      text: 'at',
    },
    'at.ka',
    new Map(),
  );
  assert(
    '取艾特',
    outs[0] === '2' && outs[1] === 'OPEN111' && outs[2] === 'OPEN222' && outs[3] === '0',
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "for"){
    [临时定义] i = 0
    [临时定义] n = [取艾特数]
    [临时定义] 出 = ""
    [For循环](i ＜ n){
        [如果](i == 1){
            i++
            [跳过]
        }
        出 += [取艾特:i]
        出 += ","
        i++
        [如果](i == 3){
            [中断]
        }
    }
    发消息(出)
    [结束]
}
`),
    {
      ...mockCtx(outs, {
        content: '<@10><@20><@30><@40>',
      }),
      text: 'for',
    },
    'for.ka',
    new Map(),
  );
  // i=0 → 10,; i=1 跳过; i=2 → 30,; i=3 中断
  assert('For循环+跳过+中断', outs[0] === '10,30,', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息].match(/测试6/)){
    发消息("hit")
    [结束]
}
`),
    {
      ...mockCtx(outs, {
        message: [
          { type: 'text', data: { text: '测试6 ' } },
          { type: 'at', data: { qq: 123 } },
        ],
      }),
      text: '测试6 @张三',
    },
    'match.ka',
    new Map(),
  );
  assert('文本消息.match', outs[0] === 'hit', outs);
}

{
  const outs: string[] = [];
  const ka = [
    '[如果]([文本消息].match(/测试7(.*)/)){',
    '    发消息("{取括号}|{取括号:0}|{取括号:1}")',
    '    [结束]',
    '}',
  ].join('\n');
  await runKaScript(
    parseKaSource(ka),
    { ...mockCtx(outs), text: '测试7你好呀' },
    'cap.ka',
    new Map(),
  );
  // {取括号}={取括号:0}=全文；{取括号:1}=第1个捕获组
  assert('取括号', outs[0] === '测试7你好呀|测试7你好呀|你好呀', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource([
      '[如果]([文本消息] == "tpl"){',
      '    [临时定义] 名 = "小明"',
      '    发消息(`你好{名} id={消息ID}`)',
      '    [结束]',
      '}',
    ].join('\n')),
    { ...mockCtx(outs, { id: 'MID1' }), text: 'tpl' },
    'tpl.ka',
    new Map(),
  );
  assert('字符串插值', outs[0] === '你好小明 id=MID1', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "inc"){
    [临时定义] a = 5
    a++
    发消息(a)
    [结束]
}
`),
    { ...mockCtx(outs), text: 'inc' },
    'inc.ka',
    new Map(),
  );
  assert('a++', outs[0] === '6', outs);
}

{
  sendSeq = 0;
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试8"){
    [临时定义] 出 = "回执测试"
    [临时定义] 七七 = [等待] 发消息(出)
    [等待] 发消息("成功={七七[成功]} id={七七[消息id]} 条数={七七[条数]}")
    发消息("并行A")
    发消息("并行B")
    [等待]
    [等待] 发消息("pending已结束")
    [等待] 发消息("直接等待发送")
    [结束]
}
`),
    { ...mockCtx(outs), text: '测试8' },
    'wait.ka',
    new Map(),
  );
  assert(
    '发送回执+等待',
    outs[0] === '回执测试'
    && outs[1] === '成功=true id=MID_1 条数=1'
    && outs.includes('并行A')
    && outs.includes('并行B')
    && outs[outs.length - 2] === 'pending已结束'
    && outs[outs.length - 1] === '直接等待发送'
    && outs.indexOf('pending已结束') > outs.indexOf('并行A')
    && outs.indexOf('pending已结束') > outs.indexOf('并行B'),
    outs,
  );
}

{
  const outs: string[] = [];
  const t0 = Date.now();
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "delay"){
    发消息("前")
    [等待:80]
    发消息("后")
    [结束]
}
`),
    { ...mockCtx(outs), text: 'delay' },
    'delay.ka',
    new Map(),
  );
  const elapsed = Date.now() - t0;
  assert(
    '等待毫秒延时',
    outs[0] === '前' && outs[1] === '后' && elapsed >= 70,
    { outs, elapsed },
  );
}

{
  const astDelay = parseKaSource('[等待:2000]');
  assert(
    '解析等待毫秒',
    astDelay.stmts[0]?.kind === 'await'
    && astDelay.stmts[0].kind === 'await'
    && astDelay.stmts[0].delayMs?.kind === 'number'
    && astDelay.stmts[0].delayMs.value === 2000,
    astDelay.stmts,
  );
}

{
  const outs: string[] = [];
  sendSeq = 0;
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "tpl2"){
    [临时定义] 七七 = [等待] 发消息("x")
    发消息(\`ok={七七["成功"]} id={七七["消息id"]}\`)
    [结束]
}
`),
    { ...mockCtx(outs), text: 'tpl2' },
    'tpl2.ka',
    new Map(),
  );
  assert('插值对象下标', outs[1] === 'ok=true id=MID_1', outs);
}

{
  const ast = parseKaSource(
    '[等待]\n[等待] 发消息("x")\n[临时定义] a = 发消息("y")\n[临时定义] b = [等待] 发消息("z")',
  );
  const s0 = ast.stmts[0];
  const s1 = ast.stmts[1];
  const s2 = ast.stmts[2];
  const s3 = ast.stmts[3];
  assert(
    '解析等待与赋值发消息',
    s0?.kind === 'await'
    && s0.expr === undefined
    && s1?.kind === 'await'
    && s1.expr?.kind === 'call_expr'
    && s2?.kind === 'temp_def'
    && s2.expr.kind === 'call_expr'
    && s3?.kind === 'temp_def'
    && s3.expr.kind === 'await_expr'
    && s3.expr.expr.kind === 'call_expr',
    ast.stmts,
  );
}

{
  assert(
    '被动超限文案识别',
    isPassiveLimitError('回复消息失败，被动回复时间或者次数超过限制')
    && !isPassiveLimitError('消息被去重，请检查请求msgseq'),
  );
  const t: GfSendTarget = {
    scope: 'group',
    group_openid: 'G',
    msg_id: 'MID',
    next_msg_seq: PASSIVE_REPLY_MAX + 1,
  };
  toActiveTarget(t);
  assert('toActiveTarget清除msg_id', !t.msg_id && t.next_msg_seq == null, t);
}

{
  // 第 6 条被动应改主动：请求体不再带 msg_id
  const payloads: Record<string, unknown>[] = [];
  const target: GfSendTarget = {
    scope: 'group',
    group_openid: 'G1',
    msg_id: 'PASSIVE_MID',
  };
  const ctx = {
    actions: {
      call: async (_path: string, params?: Record<string, unknown>) => {
        payloads.push({ ...(params || {}) });
        return { id: `ID_${payloads.length}` };
      },
    },
    logger: console,
  };
  for (let i = 0; i < PASSIVE_REPLY_MAX + 1; i++) {
    await replyText(ctx, target, `m${i}`);
  }
  const last = payloads[payloads.length - 1] || {};
  const first = payloads[0] || {};
  assert(
    '满5条后改主动',
    Boolean(first.msg_id)
    && !last.msg_id
    && payloads.length === PASSIVE_REPLY_MAX + 1,
    { first, last, n: payloads.length },
  );
}

{
  // 被动超限错误 → 同条主动重试
  let calls = 0;
  const payloads: Record<string, unknown>[] = [];
  const target: GfSendTarget = {
    scope: 'group',
    group_openid: 'G2',
    msg_id: 'MID2',
  };
  const ctx = {
    actions: {
      call: async (_path: string, params?: Record<string, unknown>) => {
        calls += 1;
        payloads.push({ ...(params || {}) });
        if (calls === 1) {
          throw new Error('回复消息失败，被动回复时间或者次数超过限制');
        }
        return { id: 'ACTIVE_OK' };
      },
    },
    logger: console,
  };
  const r = await replyText(ctx, target, 'retry');
  assert(
    '被动超限重试主动',
    r.成功 === true
    && calls === 2
    && Boolean(payloads[0]?.msg_id)
    && !payloads[1]?.msg_id
    && !target.msg_id,
    { r, calls, payloads, target },
  );
}

{
  const fixed = new Date(2026, 7, 15, 10, 3, 8, 123); // 本地 2026-08-15 10:03:08
  assert('时间默认格式', formatKaTime('', fixed) === '2026-08-15 10:03:08');
  assert('时间年', formatKaTime('年', fixed) === '2026');
  assert('时间月', formatKaTime('月', fixed) === '08');
  assert('时间日', formatKaTime('日', fixed) === '15');
  assert('时间时', formatKaTime('时', fixed) === '10');
  assert('时间分', formatKaTime('分', fixed) === '03');
  assert('时间秒', formatKaTime('秒', fixed) === '08');
  assert('时间戳毫秒', formatKaTime('时间戳毫秒', fixed) === String(fixed.getTime()));
  assert('时间戳秒', formatKaTime('时间戳秒', fixed) === String(Math.floor(fixed.getTime() / 1000)));
  assert('时间自定义日', formatKaTime('YYYY-MM-DD', fixed) === '2026-08-15');
  assert('时间自定义时分', formatKaTime('HH:mm', fixed) === '10:03');
  let bad = false;
  try {
    formatKaTime('xxx', fixed);
  } catch (e) {
    bad = e instanceof Error && e.message.includes('未知时间格式');
  }
  assert('时间非法后缀', bad);

  const tExpr = parseExpr('[时间:年]');
  assert('解析时间冒号', tExpr.kind === 'time_get' && (tExpr as { mode: string }).mode === '年', tExpr);

  const ms = fixed.getTime();
  assert(
    '转时间默认',
    formatDateByPattern(parseTimestampToDate('ms', ms)!, undefined) === '2026-08-15 10:03:08',
  );
  assert(
    '转时间自定义模板',
    formatDateByPattern(
      parseTimestampToDate('ms', ms)!,
      'YYYY年MM月DD日，HH时mm分ss秒',
    ) === '2026年08月15日，10时03分08秒',
  );
  assert('转时间秒单位', formatDateByPattern(parseTimestampToDate('s', Math.floor(ms / 1000))!) === '2026-08-15 10:03:08');
  assert('转时间非法', parseTimestampToDate('ms', 'abc') === null);

  const tf = parseExpr('[转时间:时间戳毫秒,123,"YYYY"]');
  assert(
    '解析转时间',
    tf.kind === 'time_from'
    && (tf as { unit: string; pattern: string }).unit === 'ms'
    && (tf as { pattern: string }).pattern === 'YYYY',
    tf,
  );

  const outsTf: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "t"){
    [临时定义] 毫秒 = ${ms}
    发消息([转时间:时间戳毫秒,毫秒])
    发消息([转时间:时间戳毫秒,毫秒,"YYYY年MM月DD日，HH时mm分ss秒"])
    发消息([转时间:时间戳毫秒,"abc"])
    [结束]
}
`),
    {
      text: 't',
      event: {},
      appId: '0',
      logger: console,
      sendText: async (body) => {
        outsTf.push(body);
        return mockReply(body);
      },
      sendDetailed: async () => mockReply(''),
      recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
      sendMarkdown: async () => mockReply(''),
    },
    'timefrom.ka',
    new Map(),
  );
  assert(
    '转时间脚本',
    outsTf[0] === '2026-08-15 10:03:08'
    && outsTf[1] === '2026年08月15日，10时03分08秒'
    && outsTf[2] === '',
    outsTf,
  );
}

{
  assert('coerce去空格', coerceToFiniteNumber(' 1 2 ') === 12);
  assert('coerce小数', coerceToFiniteNumber('-3.5') === -3.5);
  assert('coerce失败', coerceToFiniteNumber('abc') === null);
  assert('coerce1+2整串', coerceToFiniteNumber('1+2') === null);

  const outs: string[] = [];
  const globals = new Map<string, unknown>();
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "t"){
    [临时定义] a = 转数字(1 + 2 * 3)
    [临时定义] b = 转数字(" 08 ")
    [临时定义] c = 转数字("10" * "2")
    [临时定义] d = 转数字("abc")
    [临时定义] e = 转数字("1+2")
    发消息("{a}|{b}|{c}|{d}|{e}|{转数字(1+2)}")
    [如果](a > 6){
        发消息("gt")
    }
    [结束]
}
`),
    {
      text: 't',
      event: {},
      appId: '0',
      logger: console,
      sendText: async (body) => {
        outs.push(body);
        return mockReply(body);
      },
      sendDetailed: async () => mockReply(''),
      recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
      sendMarkdown: async () => mockReply(''),
    },
    'tonum.ka',
    globals,
  );
  assert(
    '转数字综合',
    outs[0] === '7|8|20|abc|1+2|3' && outs[1] === 'gt',
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "r"){
    [临时定义] 回执 = [等待] 发消息("待撤")
    [临时定义] 撤 = [等待] 撤回(回执[消息id])
    发消息("成功={撤[成功]} id={撤[消息id]} 错误={撤[错误]}")
    [结束]
}
`),
    { ...mockCtx(outs), text: 'r' },
    'recall.ka',
    new Map(),
  );
  assert(
    '撤回自己消息回执',
    outs.some((x) => x.startsWith('recall:MID_'))
    && outs.some((x) => x.startsWith('成功=true id=MID_') && x.includes('错误=')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试11-1"){
    [如果]([群号] == 0){
        发消息("测试11-1 仅群聊可用")
        [结束]
    }
    [临时定义] 撤 = [等待] 撤回([消息ID])
    发消息("撤回发言人消息：成功={撤[成功]} 错误={撤[错误]}")
    [结束]
}
`),
    { ...mockCtx(outs), text: '测试11-1' },
    'recall-c2c.ka',
    new Map(),
  );
  assert('撤回11-1私聊拦截', outs[0] === '测试11-1 仅群聊可用', outs);
}

{
  const outs: string[] = [];
  const recalls: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试11-1"){
    [如果]([群号] == 0){
        发消息("测试11-1 仅群聊可用")
        [结束]
    }
    [临时定义] 撤 = [等待] 撤回([消息ID])
    发消息("撤回发言人消息：成功={撤[成功]} 错误={撤[错误]}")
    [结束]
}
`),
    {
      ...mockCtx(outs, { id: 'USER_MSG_1', group_openid: 'G_OPEN_1' }),
      text: '测试11-1',
      recall: async (messageId) => {
        recalls.push(String(messageId));
        return makeSendResult({ 成功: true, 消息id: String(messageId), 条数: 1, 错误: '' });
      },
    },
    'recall-group.ka',
    new Map(),
  );
  assert(
    '撤回11-1群聊发言人',
    recalls[0] === 'USER_MSG_1'
    && outs.some((x) => x.includes('成功=true')),
    { outs, recalls },
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "r"){
    [临时定义] 撤 = [等待] 撤回("")
    发消息("成功={撤[成功]} 错误={撤[错误]}")
    [结束]
}
`),
    {
      ...mockCtx(outs),
      text: 'r',
      recall: async (messageId) => {
        const id = String(messageId ?? '').trim();
        if (!id) {
          return makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '撤回：消息id 为空' });
        }
        return makeSendResult({ 成功: true, 消息id: id, 条数: 1, 错误: '' });
      },
    },
    'recall-empty.ka',
    new Map(),
  );
  assert(
    '撤回空id失败',
    outs[0] === '成功=false 错误=撤回：消息id 为空',
    outs,
  );
}

{
  const ast = parseKaSource(`
[临时定义] md = "# 一号标题
## 二号标题
正文"
`);
  const def = ast.stmts.find((s) => s.kind === 'temp_def' && (s as { name: string }).name === 'md');
  assert(
    '多行双引号字符串',
    def?.kind === 'temp_def'
    && (def as { expr: { kind: string; value?: string } }).expr.kind === 'literal'
    && (def as { expr: { value: string } }).expr.value === '# 一号标题\n## 二号标题\n正文',
    def,
  );
}

{
  const ast = parseKaSource('[临时定义] x = "a\\u200Bb"');
  const def = ast.stmts[0];
  assert(
    '\\\\u200B转义',
    def?.kind === 'temp_def'
    && (def as { expr: { value: string } }).expr.value === `a\u200Bb`,
    def,
  );
}

{
  const ast = parseKaSource(`
[临时定义] 行1 = 按钮行(
    回调钮("r1a", "蓝", "data-蓝", 1),
    回调钮("r1b", "白", "data-白", 2)
)
`);
  const def = ast.stmts[0] as {
    kind: string;
    expr?: { kind: string; name?: string; args?: unknown[] };
  };
  assert(
    '括号跨行按钮行',
    def?.kind === 'temp_def'
    && def.expr?.kind === 'call_expr'
    && def.expr.name === '按钮行'
    && def.expr.args?.length === 2,
    def,
  );
}

{
  assert(
    'MD图片补尺寸',
    ensureMdImageSize('![图](https://a.com/x.png)') === '![图#640px #360px](https://a.com/x.png)'
    && ensureMdImageSize('![text #208px #320px](https://a.com/x.png)')
      === '![text #208px #320px](https://a.com/x.png)',
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "m"){
    [临时定义] md = "# 标题
**加粗** 和 \`code\`"
    发Markdown(md)
    [结束]
}
`),
    { ...mockCtx(outs), text: 'm' },
    'md.ka',
    new Map(),
  );
  assert(
    '发Markdown多行含反引号',
    outs[0] === 'md:# 标题\n**加粗** 和 `code`',
    outs,
  );
}

{
  assert(
    '指令输入标签',
    mdCmdInput('测试1', '填入测试1').includes('qqbot-cmd-input')
    && mdCmdInput('测试1', '填入测试1').includes(encodeURIComponent('测试1')),
  );
  assert(
    '回车指令链接',
    mdCmdEnter('测试1', '点我').includes('mqqapi://aio/inlinecmd')
    && mdCmdEnter('测试1', '点我').includes('enter=true')
    && mdCmdEnter('测试1', '点我').startsWith('[点我]('),
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "c"){
    [临时定义] md = "点：" + 指令输入("测试1", "填入")
    md += "\\n发：" + 回车指令("测试1", "直发")
    发Markdown(md)
    [结束]
}
`),
    { ...mockCtx(outs), text: 'c' },
    'mdcmd.ka',
    new Map(),
  );
  assert(
    '指令输入回车指令拼进MD',
    outs[0]?.startsWith('md:点：<qqbot-cmd-input')
    && outs[0]?.includes('inlinecmd')
    && outs[0]?.includes('enter=true'),
    outs,
  );
}

{
  const btn = makeCallbackButton('cb14', '点我有反应', '测试12-14回执');
  assert(
    '回调钮结构',
    btn.id === 'cb14'
    && btn.action.type === 1
    && btn.action.data === '测试12-14回执'
    && btn.render_data.label === '点我有反应',
    btn,
  );
  assert(
    '回调钮样式蓝白红',
    makeCallbackButton('b', '蓝', 'd', 1).render_data.style === 1
    && makeCallbackButton('w', '白', 'd', 2).render_data.style === 2
    && makeCallbackButton('r', '红', 'd', 3).render_data.style === 3
    && makeCallbackButton('x0', 'x', 'd', 0).render_data.style === 1
    && makeCallbackButton('x4', 'x', 'd', 4).render_data.style === 1,
  );
  const visited = makeCallbackButton('v', '点我', 'd', 1, '已点✓');
  assert(
    '回调钮点后文案',
    visited.render_data.label === '点我'
    && visited.render_data.visited_label === '已点✓',
    visited,
  );
  const onlyMe = makeCallbackButton('p', '仅我', 'd', 1, '已点', 0, 'openid_abc');
  assert(
    '回调钮指定用户权限',
    onlyMe.action.permission.type === 0
    && onlyMe.action.permission.specify_user_ids?.[0] === 'openid_abc',
    onlyMe,
  );
  const link = makeLinkButton('l', '文档', 'https://bot.q.qq.com/wiki/', 1, '已开');
  assert('跳转钮', link.action.type === 0 && link.action.data.startsWith('https://'), link);
  const cmd = makeCommandButton('c', '发测试1', '测试1', 3, '已发', 1, 0);
  assert('指令钮回车', cmd.action.type === 2 && cmd.action.enter === true, cmd);
  const kb = makeKeyboard(makeButtonRow(btn));
  assert('键盘结构', kb.rows.length === 1 && kb.rows[0]!.buttons.length === 1, kb);
  assert(
    '行可当键盘',
    normalizeKeyboard(makeButtonRow(btn))?.rows.length === 1,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试12-14"){
    发Markdown("# 回调", 键盘(按钮行(回调钮("cb14", "点我", "测试12-14回执"))))
    [结束]
}
`),
    { ...mockCtx(outs), text: '测试12-14' },
    'mdkb.ka',
    new Map(),
  );
  assert(
    '发Markdown带键盘',
    outs[0] === 'mdkb:# 回调'
    && outs.some((x) => x.startsWith('kb:') && x.includes('测试12-14回执')),
    outs,
  );
}

{
  const btn = getButtonData({
    t: 'INTERACTION_CREATE',
    id: 'INT1',
    data: { resolved: { button_id: 'cb14', button_data: '测试12-14回执' } },
  });
  assert(
    '解析按钮数据',
    btn?.id === 'cb14' && btn?.data === '测试12-14回执',
    btn,
  );

  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试12-14回执"){
    发消息("已收到回调")
    [结束]
}
`),
    { ...mockCtx(outs), text: '测试12-14回执' },
    'mdkb-ack.ka',
    new Map(),
  );
  assert('按钮data当文本消息', outs[0] === '已收到回调', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试12-15"){
    [临时定义] 行1 = 按钮行(回调钮("r1a", "蓝", "测试12-15:蓝", 1), 回调钮("r1b", "白", "测试12-15:白", 2), 回调钮("r1c", "红", "测试12-15:红", 3))
    [临时定义] 行2 = 按钮行(回调钮("r2a", "蓝", "测试12-15:蓝2", 1), 回调钮("r2b", "白", "测试12-15:白2", 2), 回调钮("r2c", "红", "测试12-15:红2", 3))
    [临时定义] 行3 = 按钮行(回调钮("r3a", "蓝", "测试12-15:蓝3", 1), 回调钮("r3b", "白", "测试12-15:白3", 2), 回调钮("r3c", "红", "测试12-15:红3", 3))
    发Markdown("# 多按钮", 键盘(行1, 行2, 行3))
    [结束]
}
`),
    { ...mockCtx(outs), text: '测试12-15' },
    'mdkb-multi.ka',
    new Map(),
  );
  const kbLine = outs.find((x) => x.startsWith('kb:'));
  const parsed = kbLine ? JSON.parse(kbLine.slice(3)) as { rows: Array<{ buttons: unknown[] }> } : null;
  assert(
    '多行键盘等宽3/3/3',
    outs.some((x) => x.startsWith('mdkb:'))
    && parsed?.rows.length === 3
    && parsed.rows.every((r) => r.buttons.length === 3),
    { outs, parsed },
  );
}

{
  const ast = parseKaSource(`
发消息("发言人=" + [获取群身份] + " 自己=" + [获取群身份:自己] + " 他=" + [获取群身份:OTHER])
`);
  const outs: string[] = [];
  await runKaScript(
    ast,
    {
      ...mockCtx(outs, {
        group_openid: 'G_OPEN_1',
        author: { member_openid: 'U_OPEN_1', member_role: 'admin' },
      }),
      text: 'x',
    },
    'role.ka',
    new Map(),
  );
  assert(
    '获取群身份发言人+自己+他人',
    outs.some((x) => x === '发言人=admin 自己=admin 他=0')
    && outs.some((x) => x.includes('/bot_state')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`发消息([获取群身份])`),
    {
      ...mockCtx(outs, { group_openid: 'G', author: { member_openid: 'U' } }),
      text: 'x',
    },
    'role-miss.ka',
    new Map(),
  );
  assert('获取群身份缺字段→0', outs[0] === '0', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[临时定义] uid = [发言人]
发消息([获取群身份:uid])
`),
    {
      ...mockCtx(outs, {
        group_openid: 'G',
        author: { member_openid: 'U_VAR', member_role: 'owner' },
      }),
      text: 'x',
    },
    'role-var.ka',
    new Map(),
  );
  assert('获取群身份:变量等于发言人', outs[0] === 'owner', outs);
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[临时定义] 信息 = [获取群信息]
发消息("名=" + 信息[群名] + " 人=" + 信息[人数] + " ok=" + 信息[成功])
`),
    {
      ...mockCtx(outs, { group_openid: 'G_OPEN_1' }),
      text: 'x',
    },
    'ginfo.ka',
    new Map(),
  );
  assert(
    '获取群信息',
    outs.some((x) => x === '名=测试群 人=42 ok=true')
    && outs.some((x) => x.includes('/info')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[临时定义] 态 = [获取机器人群状态]
发消息("身=" + 态[身份] + " 收=" + 态[收消息设置])
`),
    {
      ...mockCtx(outs, { group_openid: 'G_OPEN_1' }),
      text: 'x',
    },
    'gbot.ka',
    new Map(),
  );
  assert(
    '获取机器人群状态',
    outs.some((x) => x === '身=admin 收=only_mention')
    && outs.some((x) => x.includes('/bot_state')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[临时定义] 禁 = [查询群禁言]
发消息("模式=" + 禁[全员模式] + " 数=" + 禁[禁言人数])
`),
    {
      ...mockCtx(outs, { group_openid: 'G_OPEN_1' }),
      text: 'x',
    },
    'gmute-q.ka',
    new Map(),
  );
  assert(
    '查询群禁言',
    outs.some((x) => x === '模式=none 数=1')
    && outs.some((x) => x.startsWith('api:GET:') && x.includes('restrict_chat_setting')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[临时定义] 回 = 设置群禁言("U_MUTE", 60)
发消息("ok=" + 回[成功] + " op=" + 回[操作])
`),
    {
      ...mockCtx(outs, { group_openid: 'G_OPEN_1' }),
      text: 'x',
    },
    'gmute-set.ka',
    new Map(),
  );
  assert(
    '设置群禁言',
    outs.some((x) => x === 'ok=true op=add')
    && outs.some((x) => x.startsWith('api:POST:') && x.includes('restrict_chat_setting')),
    outs,
  );
}

{
  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([文本消息] == "测试17"){
    [临时定义] 身 = [获取群身份]
    [如果](身 != "admin"){
        [如果](身 != "owner"){
            发消息("无权")
            [结束]
        }
    }
    [临时定义] 回 = 设置群禁言("X", 60)
    发消息("不应到这")
    [结束]
}
`),
    {
      ...mockCtx(outs, {
        group_openid: 'G',
        author: { member_openid: 'U', member_role: 'member' },
        content: '测试17',
      }),
      text: '测试17',
    },
    'gmute-deny.ka',
    new Map(),
  );
  assert(
    '测试17非管理员不调POST',
    outs[0] === '无权'
    && !outs.some((x) => x.startsWith('api:POST:')),
    outs,
  );
}

{
  assert('eventLabel进群', eventLabel({ t: 'GROUP_ADD_ROBOT' }) === '进群');
  assert('eventLabel退群', eventLabel('GROUP_DEL_ROBOT') === '退群');
  assert('eventLabel群消息', eventLabel({ t: 'GROUP_AT_MESSAGE_CREATE' }) === '群消息');
  assert('isLifecycle进群', isLifecycleEvent({ t: 'GROUP_ADD_ROBOT' }));
  assert('isLifecycle消息否', !isLifecycleEvent({ t: 'GROUP_AT_MESSAGE_CREATE' }));

  const addT = 取事件回复目标({ t: 'GROUP_ADD_ROBOT', group_openid: 'G1' });
  assert('进群可回复', !!addT && addT.scope === 'group' && addT.group_openid === 'G1', addT);
  assert('退群不可回复', 取事件回复目标({ t: 'GROUP_DEL_ROBOT', group_openid: 'G1' }) === null);
  assert('删好友不可回复', 取事件回复目标({ t: 'FRIEND_DEL', openid: 'U1' }) === null);
  const friendT = 取事件回复目标({ t: 'FRIEND_ADD', openid: 'U1' });
  assert('加好友可回复', !!friendT && friendT.scope === 'c2c' && friendT.user_openid === 'U1', friendT);

  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([事件] == "进群"){
  发消息("进群了|" + [文本消息] + "|" + [事件])
  [结束]
}
`),
    {
      text: '进群',
      event: { t: 'GROUP_ADD_ROBOT', group_openid: 'G1' },
      logger: console,
      sendText: async (t) => {
        outs.push(String(t));
        return mockReply(t);
      },
      sendDetailed: async () => mockReply(''),
      sendMarkdown: async () => mockReply(''),
      recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
    },
    'event-add.ka',
    new Map(),
  );
  assert('事件进群匹配+文本同名', outs[0] === '进群了|进群|进群', outs);

  // 解析基础例子3（保证语法可用）
  const demo3 = path.join(smokeRoot, '文本类插件', '基础例子3.ka');
  const { readFileSync } = await import('node:fs');
  parseKaSource(readFileSync(demo3, 'utf-8'));
  assert('基础例子3可解析', true);

  {
    const boolOuts: string[] = [];
    await runKaScript(
      parseKaSource(`[风格标准]:text
[临时定义] 回 = 发消息("x")
[如果](回[成功] == true){
    发消息("ok")
}
[如果](回[成功] == false){
    发消息("bad")
}
[如果](假 == false){
    发消息("假ok")
}
`),
      {
        text: 't',
        event: { t: 'GROUP_MESSAGE_CREATE', group_openid: 'G', author: { member_openid: 'U' } },
        pluginPath: smokeRoot,
        dataPath: path.join(smokeRoot, '_data_bool'),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        sendText: async (t) => {
          boolOuts.push(t);
          return makeSendResult({ 成功: true, 消息id: 'M1', 条数: 1, 错误: '' });
        },
        sendDetailed: async () => mockReply(''),
        sendMarkdown: async () => mockReply(''),
        recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
      },
      'bool.ka',
      new Map(),
    );
    assert(
      '布尔字面量 true/false/假',
      boolOuts.includes('ok') && boolOuts.includes('假ok') && !boolOuts.includes('bad'),
      boolOuts,
    );
  }

  const openEv = {
    t: 'INTERACTION_CREATE',
    type: 18,
    scene: 'c2c',
    user_openid: 'U_AUTH',
    data: {
      resolved: {
        authorize_data: { opt_scene: 'setting', scope: 'c2c_push', switch: true },
      },
    },
  };
  const openAuth = getAuthorizeInteraction(openEv);
  assert(
    '授权开主动消息',
    !!openAuth && openAuth.label === '开主动消息' && openAuth.canReply,
    openAuth,
  );
  assert('eventLabel授权开', eventLabel(openEv) === '开主动消息');

  const closeEv = {
    t: 'INTERACTION_CREATE',
    type: 18,
    scene: 'c2c',
    user_openid: 'U_AUTH',
    data: {
      resolved: {
        authorize_data: { opt_scene: 'setting', scope: 'c2c_push' },
      },
    },
  };
  const closeAuth = getAuthorizeInteraction(closeEv);
  assert(
    '授权关主动消息',
    !!closeAuth && closeAuth.label === '关主动消息' && !closeAuth.canReply,
    closeAuth,
  );

  const outsAuth: string[] = [];
  await runKaScript(
    parseKaSource(`
[如果]([事件] == "开主动消息"){
  发消息("开了|" + [文本消息])
  [结束]
}
`),
    {
      text: '开主动消息',
      event: openEv,
      logger: console,
      sendText: async (t) => {
        outsAuth.push(String(t));
        return mockReply(t);
      },
      sendDetailed: async () => mockReply(''),
      sendMarkdown: async () => mockReply(''),
      recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
    },
    'auth-open.ka',
    new Map(),
  );
  assert('授权开匹配发消息', outsAuth[0] === '开了|开主动消息', outsAuth);
}

{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const {
    resolveDataFsPath,
    readA,
    writeA,
    readB,
    writeB,
  } = await import('../src/lib/data-fs.js');

  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mkjianyi-data-'));
  const pluginPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mkjianyi-plugin-'));
  const bundled = path.join(pluginPath, '数据文件');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(path.join(bundled, 'hello.txt'), 'bundled-hi', 'utf-8');
  const roots = { dataPath, pluginPath, logger: console };

  assert('路径落在data', resolveDataFsPath(roots, '存档/a.json').startsWith(path.resolve(dataPath)));
  assert(
    '捆绑路径',
    resolveDataFsPath(roots, '数据文件/hello.txt') === path.resolve(bundled, 'hello.txt'),
  );
  let escapeOk = false;
  try {
    resolveDataFsPath(roots, '../outside.txt');
  } catch {
    escapeOk = true;
  }
  assert('禁止逃逸', escapeOk);

  assert('写B', writeB(roots, '存档/积分.json', 'u1', 7) === true);
  assert('读B', readB(roots, '存档/积分.json', 'u1', 0) === 7);
  assert('读B默认', readB(roots, '存档/积分.json', 'missing', 99) === 99);
  writeB(roots, '存档/积分.json', 'u2', 'x');
  assert('写B合并', readB(roots, '存档/积分.json', 'u1', 0) === 7);

  assert('写A', writeA(roots, '日志/今日.txt', 'hello\nworld') === true);
  assert('读A', readA(roots, '日志/今日.txt') === 'hello\nworld');
  assert('读A缺文件', readA(roots, '日志/无.txt') === '');
  assert('读捆绑', readA(roots, '数据文件/hello.txt') === 'bundled-hi');

  const outs: string[] = [];
  await runKaScript(
    parseKaSource(`
写("演示/积分.json", "k", 3)
[临时定义] v = 读("演示/积分.json", "k", 0)
写文件("演示/a.txt", "V=" + v)
[临时定义] t = 读文件("演示/a.txt")
发消息(t)
`),
    {
      text: '',
      event: {},
      dataPath,
      pluginPath,
      logger: console,
      sendText: async (body) => {
        outs.push(String(body));
        return mockReply(body);
      },
      sendDetailed: async () => mockReply(''),
      sendMarkdown: async () => mockReply(''),
      recall: async () => makeSendResult({ 成功: false, 消息id: '', 条数: 0, 错误: '' }),
    },
    'rw.ka',
    new Map(),
  );
  assert('脚本读写', outs[0] === 'V=3', outs);

  try {
    fs.rmSync(dataPath, { recursive: true, force: true });
    fs.rmSync(pluginPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.exit(ok ? 0 : 1);
