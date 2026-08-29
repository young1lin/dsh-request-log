/**
 * dsh-request-log — Client half (installed package bundle entry).
 *
 * Registers a "Requests / 请求" tab in the conversation view ring
 * (`conversation.view` slot, right of Chat/Trajectory/Context) listing every
 * recorded provider call of the open session; each row drills into the exact
 * request and response, viewable in the neutral capture or rendered into the
 * Anthropic Messages / OpenAI ChatCompletion / OpenAI Responses wire shapes.
 *
 * Data comes from the Host half's same-origin read API — no RPC, no
 * projections: plain fetch against `/dsh-request-log/*`.
 */

import './styles.css'

import { h } from './react'
import type { ClientCtx } from './services'
import type { ViewDict } from './dict'
import { makeRequestLogView } from './view'


const NS = 'dsh-request-log'

const DICT_EN: ViewDict = {
  tab: 'Requests',
  empty: 'No provider calls recorded yet',
  emptyHint: 'Send a message in this session — every model call (retries included) will be listed here.',
  error: 'Failed to load',
  retry: 'Retry',
  stepHint: 'Step of this session\'s conversation loop — attempt 1 opens a step, retries share it; auxiliary calls (compaction / title) take none',
  stale: 'Last refresh failed — showing previously loaded data',
  refresh: 'Refresh',
  auto: 'Auto',
  calls: 'Provider calls',
  time: 'Time',
  model: 'Model',
  ttft: 'TTFT',
  totalTime: 'Total',
  colSpeed: 'Speed',
  speedHint: 'Output tokens per second over the response stream (TTFT excluded)',
  colBilledInput: 'Total in',
  colIn: 'In',
  colCacheRead: 'Cache hit',
  hitRateHint: 'Cache hit rate',
  colHitRate: 'Hit %',
  colCacheWrite: 'Cache write',
  colOut: 'Out',
  size: 'Msg/Calls',
  sizeHint: 'Messages in the request / tool calls made by the response — a run_code program counts its inner dispatch sites',
  retryOf: 'Retry attempt of the same logical call',
  sumCalls: 'Calls',
  sumBilledInput: 'Total in',
  sumBilledInputHint: 'Billed input over the loaded calls: uncached input + cache hits + cache writes',
  sumInput: 'Input',
  sumCacheRead: 'Cache hit',
  sumHitRate: 'Hit rate',
  sumCacheWrite: 'Cache write',
  sumOutput: 'Output',
  loadMore: 'Load older ({count} more)',
  charts: {
    toggle: 'Charts',
    toggleHint: 'Per-call line charts over the loaded window',
    groupHitRate: 'Hit rate',
    groupTokens: 'Tokens',
    groupLatency: 'Latency',
    groupSpeed: 'Speed',
    stacks: 'Stacked',
    stacksHint: 'Stack the token series on top of each other, per step',
    cumulative: 'Cumulative',
    cumulativeHint: 'Stacked bar running totals: each column tops at the cumulative usage up to that step (like the Cursor usage dashboard); color segments break it down by token kind',
    emptyTitle: 'Nothing to plot yet',
    emptyHint: 'Statistics appear once calls settle with usage in this session.',
    allNull: 'This metric was never reported for the loaded calls.',
    speedApproxHint: '≈ value = output ÷ total duration — this response flushed at once (no measurable stream phase), so TTFT is included.',
    excludedShort: '{count} aux',
    excludedHint: '{count} auxiliary calls (compaction / session-title) are not on the numbered step axis.',
  },
  detail: {
    back: 'Back',
    step: 'Step',
    timingCard: 'Timing',
    startedAt: 'Started',
    waitPhase: 'Request wait',
    waitHint: 'From call start to the first chunk from the provider (time to first token)',
    streamPhase: 'Response stream',
    streamHint: 'From the first chunk to the last chunk of the stream',
    totalPhase: 'Total',
    usageCard: 'Token usage',
    usageNone: 'No usage reported for this call',
    input: 'Input (uncached)',
    cacheRead: 'Cache hit',
    cacheWrite: 'Cache write',
    output: 'Output',
    reasoning: 'Reasoning',
    hitRate: 'Hit rate',
    billedInput: 'Total in',
    outSpeed: 'Output speed',
    outSpeedHint: 'Output tokens ÷ response stream duration (TTFT excluded)',
    callCard: 'Call',
    provider: 'Provider',
    model: 'Model',
    effort: 'Effort',
    attempt: 'Attempt · hash',
    retryOf: 'Retry attempt of the same logical call',
    finish: 'Finish',
    size: 'Size',
    msgs: 'msgs',
    callsLabel: 'tool calls',
    callsHint: 'Tool calls made by this response; a run_code program counts its inner tools.x(...) dispatch sites',
    request: 'Request',
    response: 'Response',
    neutral: 'Neutral',
    reconstructed: 'Reconstructed view: rendered from the exact neutral capture, mirroring the adapter mapping',
    expandAll: 'Expand',
    expandHint: 'Expand every node and string',
    collapseAll: 'Collapse',
    collapseHint: 'Collapse every node and clamp long strings',
    chainOn: 'Chain view: {sent} new items · a chaining client could reuse previous_response_id ({skipped} items held server-side)',
    chainOff: 'Full input: the whole history travels in this request ({items} items)',
    copy: 'Copy JSON',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    loadError: 'Failed to load call',
    jsonCollapse: 'collapse',
    jsonExpand: 'expand',
    jsonChars: '{count} chars',
    jsonViewAsJson: 'view as JSON',
    jsonViewAsText: 'view text',
    jsonViewAsJsonTitle: 'Parse this string and show it as JSON',
    jsonViewAsTextTitle: 'Show this string as plain text',
    jsonCollapseStringTitle: 'Collapse this string back to its preview',
    jsonOpenString: '… +{count} chars',
    jsonOpenStringTitle: 'Open this string in full',
    jsonChip: '{ } JSON',
    jsonTruncated: '… truncated at {count} chars — use Copy JSON for the full body',
    jsonItems: '{count} items',
    jsonKeys: '{count} keys',
    jsonNodeBudget: '… node budget exceeded, collapse other nodes or use Copy JSON ',
    jsonDepthBudget: '… depth limit ({count} levels) reached — use Copy JSON for the full body',
    renderError: 'Rendering failed',
    renderRetry: 'Retry',
  },
}

const DICT_ZH: ViewDict = {
  tab: '请求',
  empty: '尚未记录到任何模型调用',
  emptyHint: '在本会话发送一条消息 —— 每次模型调用（含重试）都会列在这里。',
  error: '加载失败',
  retry: '重试',
  stepHint: '本会话对话循环的步骤序号 —— 每次新调用开启一步，重试沿用其所属步骤；辅助调用（压缩 / 标题）不占步骤',
  stale: '上次刷新失败 —— 当前展示的是已加载的数据',
  refresh: '刷新',
  auto: '自动',
  calls: '模型调用',
  time: '时间',
  model: '模型',
  ttft: '首字延迟',
  totalTime: '总时长',
  colSpeed: '速度',
  speedHint: '响应流式阶段的输出 token 速度（不含首字延迟）',
  colBilledInput: '总输入',
  colIn: '输入',
  colCacheRead: '缓存命中',
  hitRateHint: '缓存命中率',
  colHitRate: '命中率',
  colCacheWrite: '缓存写入',
  colOut: '输出',
  size: '消息/调用',
  sizeHint: '请求消息数 / 响应发起的工具调用次数 —— run_code 程序按其内部调用点计数',
  retryOf: '同一逻辑调用的重试尝试',
  sumCalls: '调用数',
  sumBilledInput: '总输入',
  sumBilledInputHint: '已加载调用的计费输入合计：未缓存输入 + 缓存命中 + 缓存写入',
  sumInput: '输入',
  sumCacheRead: '缓存命中',
  sumHitRate: '命中率',
  sumCacheWrite: '缓存写入',
  sumOutput: '输出',
  loadMore: '加载更早的调用（还有 {count} 条）',
  charts: {
    toggle: '图表',
    toggleHint: '按已加载调用的逐次折线统计图',
    groupHitRate: '命中率',
    groupTokens: 'Token',
    groupLatency: '延迟',
    groupSpeed: '速度',
    stacks: '堆叠',
    stacksHint: '将 Token 各序列在同一步骤上依次堆叠显示',
    cumulative: '累计',
    cumulativeHint: '按步骤累加的堆叠柱状图：每根柱子的高度是截至该步骤的累计用量（类似 Cursor 用量看板），各色段为各类 token 的累计构成',
    emptyTitle: '暂无可绘制的数据',
    emptyHint: '本会话的调用完成并报告用量后，这里会出现统计折线。',
    allNull: '已加载的调用从未报告该指标。',
    speedApproxHint: '≈ 数值 = 输出 ÷ 总时长 —— 该响应一次性返回（无可测流式阶段），已计入首字等待。',
    excludedShort: '{count} 辅助',
    excludedHint: '{count} 个辅助调用（压缩 / 标题）不在编号步骤轴上，未计入折线。',
  },
  detail: {
    back: '返回',
    step: '步骤',
    timingCard: '耗时',
    startedAt: '开始时间',
    waitPhase: '请求等待',
    waitHint: '从调用开始到 Provider 返回第一个数据块（首 token 延迟）',
    streamPhase: '响应流式',
    streamHint: '从第一个数据块到最后一个数据块的流式传输时长',
    totalPhase: '总时长',
    usageCard: 'Token 用量',
    usageNone: '本次调用未报告用量',
    input: '输入（未缓存）',
    cacheRead: '缓存命中',
    cacheWrite: '缓存写入',
    output: '输出',
    reasoning: '思考',
    hitRate: '命中率',
    billedInput: '总输入',
    outSpeed: '输出速度',
    outSpeedHint: '输出 token ÷ 响应流式时长（不含首字延迟）',
    callCard: '调用信息',
    provider: '提供方',
    model: '模型',
    effort: '思考强度',
    attempt: '尝试 · 哈希',
    retryOf: '同一逻辑调用的重试尝试',
    finish: '结束原因',
    size: '规模',
    msgs: '条消息',
    callsLabel: '次工具调用',
    callsHint: '本次响应发起的工具调用次数；run_code 程序按其内部 tools.x(...) 调用点计数',
    request: '请求',
    response: '响应',
    neutral: '中立格式',
    reconstructed: '重建视图：基于精确的中立格式记录渲染，映射规则与适配器一致',
    expandAll: '展开',
    expandHint: '展开全部节点和字符串',
    collapseAll: '折叠',
    collapseHint: '折叠全部节点并收起长字符串',
    chainOn: '链式视图：{sent} 条新增内容 · 链式客户端可复用 previous_response_id（{skipped} 条由服务端状态保留）',
    chainOff: '全量输入：完整历史随本次请求发送（{items} 条）',
    copy: '复制 JSON',
    copied: '已复制',
    copyFailed: '复制失败',
    loadError: '加载调用记录失败',
    jsonCollapse: '收起',
    jsonExpand: '展开',
    jsonChars: '{count} 字符',
    jsonViewAsJson: '按 JSON 查看',
    jsonViewAsText: '查看文本',
    jsonViewAsJsonTitle: '解析该字符串并按 JSON 显示',
    jsonViewAsTextTitle: '将该字符串按纯文本显示',
    jsonCollapseStringTitle: '收起该字符串，回到预览',
    jsonOpenString: '… +{count} 字符',
    jsonOpenStringTitle: '完整展开该字符串',
    jsonChip: '{ } JSON',
    jsonTruncated: '… 已在 {count} 字符处截断 — 完整内容请使用“复制 JSON”',
    jsonItems: '{count} 项',
    jsonKeys: '{count} 个键',
    jsonNodeBudget: '… 渲染节点数超限，请折叠其他节点或使用“复制 JSON”',
    jsonDepthBudget: '… 嵌套深度已达上限（{count} 层）— 完整内容请使用“复制 JSON”',
    renderError: '渲染失败',
    renderRetry: '重试',
  },
}

function apply(ctx: ClientCtx): void {
  const dicts: Record<string, ViewDict> = { en: DICT_EN, zh: DICT_ZH }

  ctx.effect(() => {
    return ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH })
  }, 'dsh-request-log: dictionaries')
  const t = ctx.locale.bind(NS)

  const source = {
    dictOf: (): ViewDict => {
      const active = ctx.locale.getLocale?.().active ?? 'en'
      return dicts[active] ?? DICT_EN
    },
    subscribe: (fn: () => void): (() => void) => ctx.locale.subscribe(fn),
  }
  const RequestLogView = makeRequestLogView(source)

  ctx.slots.inject('conversation.view', () => {
    return ctx.slots.register(
      // order 30 renders right of Chat (0), Trajectory (10), and dsh-context (20).
      { name: 'conversation.view', id: 'request-log', order: 30, locale: NS, label: () => t('tab') },
      props => h(RequestLogView, props),
    )
  })
}

// Named exports (the CJS bundle delivers them as module.exports members —
// the shape the harness's client module loader consumes).
export const name = 'dsh-request-log'
export const inject = ['slots', 'locale']
export { apply }
