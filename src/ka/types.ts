export type KaMeta = {
  style?: string;
};

export type KaBinaryOp = '+' | '-' | '*' | '/';

export type KaTemplatePart =
  | { kind: 'text'; value: string }
  | { kind: 'slot'; name: string }
  /** 字符串内 {取括号:1} / {取艾特:i} 等 */
  | { kind: 'slot_expr'; expr: KaExpr };

/** 发消息 / 发详细消息 回执（赋值或 [等待] 后可读） */
export type KaSendResult = {
  成功: boolean;
  /** 多 batch 时取最后一条成功回执的 id */
  消息id: string;
  条数: number;
  错误: string;
};

export type KaExpr =
  | { kind: 'literal'; value: string }
  /** "…{名字}…" / `${名字}` 插值字符串 */
  | { kind: 'template'; parts: KaTemplatePart[] }
  | { kind: 'number'; value: number }
  /** true / false / 真 / 假 */
  | { kind: 'boolean'; value: boolean }
  | { kind: 'ident'; name: string }
  | { kind: 'builtin'; name: string }
  /** [插件定义:变量名] — 读取用户定义的变量（必须在引号外） */
  | { kind: 'plugin_var'; name: string }
  /** [取艾特] / [取艾特:0] / [取艾特:变量]（兼容旧 ;） */
  | { kind: 'at_get'; index: KaExpr }
  /** [取括号] / [取括号:N] — 取最近一次 .match；默认索引 0（全文）；没有则为 "" */
  | { kind: 'capture_get'; index: KaExpr }
  /** [时间] / [时间:年|月|日|…] / [时间:YYYY-MM-DD] 自定义模板；mode 空=默认格式化 */
  | { kind: 'time_get'; mode: string }
  /** [转时间:时间戳毫秒|时间戳秒,值] / [转时间:…,值,"模板"] */
  | { kind: 'time_from'; unit: 'ms' | 's'; value: KaExpr; pattern: string }
  /** [获取群身份] / [获取群身份:自己|发言人|变量|openid] */
  | { kind: 'group_role_get'; target: 'speaker' | 'self' | KaExpr }
  /** [获取群信息] */
  | { kind: 'group_info_get' }
  /** [获取机器人群状态] */
  | { kind: 'group_bot_state_get' }
  /** [查询群禁言] */
  | { kind: 'group_mute_query' }
  /** 目标.match(/正则/flags) — 类 JS，成功返回匹配数组，失败 null */
  | { kind: 'match'; target: KaExpr; pattern: string; flags: string }
  /** 下标：m[0] 全文 / m[1] 第1个括号…；对象可用 ["消息id"]；越界为 "" */
  | { kind: 'index'; target: KaExpr; index: KaExpr }
  /** 表达式内函数调用，如 发消息(出) */
  | { kind: 'call_expr'; name: string; args: KaExpr[] }
  /** 表达式前缀 [等待]，如 [临时定义] x = [等待] 发消息(出) */
  | { kind: 'await_expr'; expr: KaExpr }
  | { kind: 'unary'; op: '-'; expr: KaExpr }
  | { kind: 'binary'; op: KaBinaryOp; left: KaExpr; right: KaExpr };

export type KaCondOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export type KaCond =
  | { kind: KaCondOp; left: KaExpr; right: KaExpr }
  /** 单表达式真值（如 .match(...) 有结果即为真） */
  | { kind: 'truthy'; expr: KaExpr };

export type KaStmt =
  | { kind: 'temp_def'; name: string; expr: KaExpr }
  | { kind: 'global_def'; name: string; expr: KaExpr }
  /** 已有变量再赋值：`名字 = 值`（不写临时/全局定义） */
  | { kind: 'assign'; name: string; expr: KaExpr }
  | { kind: 'assign_add'; name: string; expr: KaExpr }
  | { kind: 'inc'; name: string }
  | { kind: 'call'; name: string; args: KaExpr[] }
  /** [等待] / [等待] 表达式 / [等待:毫秒] — 类 await 或延时 */
  | { kind: 'await'; expr?: KaExpr; delayMs?: KaExpr }
  | { kind: 'end' }
  | { kind: 'continue' }
  | { kind: 'break' }
  | { kind: 'if'; cond: KaCond; body: KaStmt[]; elseBody?: KaStmt[] }
  | { kind: 'for'; cond: KaCond; body: KaStmt[] };

export type KaScriptAst = {
  meta: KaMeta;
  stmts: KaStmt[];
};

export type KaLoadedScript = {
  /** 相对 文本类插件/ 的路径，用于日志 */
  relPath: string;
  absPath: string;
  mtimeMs: number;
  source: string;
  ast: KaScriptAst | null;
  parseError?: string;
};

export type KaMessageContext = {
  text: string;
  event: Record<string, unknown>;
  /** 当前官方连接 AppID；取不到为空串 */
  appId?: string;
  /** 账号级可写数据目录（kakake/data/<账号>/<插件>/） */
  dataPath?: string;
  /** 插件安装/运行副本根（plugins_two/...） */
  pluginPath?: string;
  /** 回复当前会话，返回发送回执 */
  sendText: (text: string) => Promise<KaSendResult>;
  /** 指定 群/私 + 号码 发送，返回发送回执 */
  sendDetailed: (targetKind: string, targetId: unknown, text: string) => Promise<KaSendResult>;
  /** 原生 Markdown（msg_type=2），可选底部 keyboard；返回发送回执 */
  sendMarkdown: (content: string, keyboard?: unknown) => Promise<KaSendResult>;
  /** 撤回当前会话中的消息，返回与发送同形回执 */
  recall: (messageId: unknown) => Promise<KaSendResult>;
  /** 调官方 HTTP API（如 bot_state）；测试可 mock */
  callBotApi?: (apiPath: string, params?: Record<string, unknown>) => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
};

export type StatementHandler = (
  args: KaExpr[],
  env: KaExecEnv,
) => void | Promise<void>;

export type BuiltinValueResolver = (env: KaExecEnv) => unknown;

export type KaLoopSignal = 'none' | 'continue' | 'break';

export type KaExecEnv = {
  ctx: KaMessageContext;
  globals: Map<string, unknown>;
  locals: Map<string, unknown>;
  /** 当前脚本相对路径 */
  scriptRel: string;
  ended: boolean;
  /** 最内层 For 循环控制信号 */
  loopSignal: KaLoopSignal;
  /** 最近一次 .match 成功结果，供 [取括号] / [取括号:N] 使用 */
  lastMatch: RegExpMatchArray | null;
  /** 语句版 发消息 未 await 的 Promise，供 [等待] / 脚本结束 flush */
  pendingSends: Promise<unknown>[];
  resolveExpr: (expr: KaExpr) => Promise<unknown>;
  setVar: (name: string, value: unknown, scope: 'temp' | 'global' | 'auto') => void;
  getVar: (name: string) => unknown;
};
