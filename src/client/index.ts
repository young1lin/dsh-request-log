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
  refresh: 'Refresh',
  auto: 'Auto',
  calls: 'Provider calls',
  time: 'Time',
  model: 'Model',
  ttft: 'TTFT',
  totalTime: 'Total',
  colSpeed: 'Speed',
  speedHint: 'Output tokens per second over the response stream (TTFT excluded)',
  colIn: 'In',
  colCacheRead: 'Cache hit',
  hitRateHint: 'Cache hit rate',
  colCacheWrite: 'Cache write',
  colOut: 'Out',
  size: 'Msg/Tools',
  sizeHint: 'Messages / tools in the request',
  retryOf: 'Retry attempt of the same logical call',
  sumCalls: 'Calls',
  sumInput: 'Input',
  sumCacheRead: 'Cache hit',
  sumHitRate: 'Hit rate',
  sumCacheWrite: 'Cache write',
  sumOutput: 'Output',
  loadMore: 'Load older ({count} more)',
  detail: {
    back: 'Back',
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
    billedInput: 'Billed input',
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
    toolsLabel: 'tools',
    request: 'Request',
    response: 'Response',
    neutral: 'Neutral',
    reconstructed: 'Reconstructed view: rendered from the exact neutral capture, mirroring the adapter mapping',
    expandAll: 'Expand',
    expandHint: 'Expand every node and string',
    collapseAll: 'Collapse',
    collapseHint: 'Collapse every node and clamp long strings',
    chainOn: 'Chained: only {sent} new items sent · previous_response_id reused ({skipped} items held server-side)',
    chainOff: 'Full input: the whole history travels in this request ({items} items)',
    copy: 'Copy JSON',
    copied: 'Copied',
    loadError: 'Failed to load call',
  },
}

const DICT_ZH: ViewDict = {
  tab: '请求',
  empty: '尚未记录到任何模型调用',
  emptyHint: '在本会话发送一条消息 —— 每次模型调用（含重试）都会列在这里。',
  error: '加载失败',
  retry: '重试',
  refresh: '刷新',
  auto: '自动',
  calls: '模型调用',
  time: '时间',
  model: '模型',
  ttft: '首字延迟',
  totalTime: '总时长',
  colSpeed: '速度',
  speedHint: '响应流式阶段的输出 token 速度（不含首字延迟）',
  colIn: '输入',
  colCacheRead: '缓存命中',
  hitRateHint: '缓存命中率',
  colCacheWrite: '缓存写入',
  colOut: '输出',
  size: '消息/工具',
  sizeHint: '请求中的消息数 / 工具数',
  retryOf: '同一逻辑调用的重试尝试',
  sumCalls: '调用数',
  sumInput: '输入',
  sumCacheRead: '缓存命中',
  sumHitRate: '命中率',
  sumCacheWrite: '缓存写入',
  sumOutput: '输出',
  loadMore: '加载更早的调用（还有 {count} 条）',
  detail: {
    back: '返回',
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
    billedInput: '计费输入',
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
    toolsLabel: '个工具',
    request: '请求',
    response: '响应',
    neutral: '中立格式',
    reconstructed: '重建视图：基于精确的中立格式记录渲染，映射规则与适配器一致',
    expandAll: '展开',
    expandHint: '展开全部节点和字符串',
    collapseAll: '折叠',
    collapseHint: '折叠全部节点并收起长字符串',
    chainOn: '链式增量：本次仅发送 {sent} 条新增内容 · 复用 previous_response_id（{skipped} 条由服务端状态保留）',
    chainOff: '全量输入：完整历史随本次请求发送（{items} 条）',
    copy: '复制 JSON',
    copied: '已复制',
    loadError: '加载调用记录失败',
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

module.exports = {
  name: 'dsh-request-log',
  inject: ['slots', 'locale'],
  apply,
}
