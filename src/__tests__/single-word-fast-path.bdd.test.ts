import { Context, PluginInitParams, Query } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import * as translate from "../translate"

const ctx = {} as Context

async function setup(initial: Record<string, string> = {}) {
  const settings = { ...initial }
  const api = {
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] ?? ""),
    SaveSetting: jest.fn(async (_ctx: Context, key: string, value: string) => {
      await Promise.resolve()
      settings[key] = value
    }),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    Log: jest.fn(async () => undefined),
    ChangeQuery: jest.fn(async () => undefined),
    UpdateResult: undefined
  }
  await plugin.init(ctx, { API: api } as unknown as PluginInitParams)
  const query = (text = "", refinements?: Record<string, string>) => plugin.query(ctx, { Type: "input", Search: text, Refinements: refinements } as unknown as Query)
  return { settings, api, query }
}

const calledProviders = () => jest.mocked(translate.translateText).mock.calls.map(call => call[0])

beforeEach(() => {
  jest.spyOn(translate, "translateText").mockImplementation(async provider => ({
    translatedText: "translated",
    providerName: provider,
    ...(provider === "youdao_word" ? { dictionary: { senses: ["n. test"], wordForms: [] } } : {})
  }))
})

afterEach(() => jest.restoreAllMocks())

test("disabled by default: wox_ai stays wox_ai even for single words", async () => {
  // SN-FP-001
  // Scenario: 默认关闭时单词查询不走快速路径
  // Given 用户没有开启单词快速路径
  // And 翻译源包含 Wox AI
  // When 用户用 tr 查询单个单词
  // Then 该查询仍调用 Wox AI
  const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  await h.query("hello")
  expect(calledProviders()).toEqual(["wox_ai"])
})

test("enabled: single word with wox_ai selected is replaced by the dictionary lookup", async () => {
  // SN-FP-002
  // Scenario: 开启后单词查询替换为词典快速路径
  // Given 单词快速路径已开启
  // And 翻译源包含 Wox AI
  // When 用户用 tr 查询单个单词
  // Then 该 Wox AI 行被替换为有道词典查询
  // And 不再调用 Wox AI
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true" })
  await h.query("hello")
  expect(calledProviders()).toEqual(["youdao_word"])
})

test("enabled: phrases and sentences still go to Wox AI", async () => {
  // SN-FP-003
  // Scenario: 多词查询不触发快速路径
  // Given 单词快速路径已开启
  // And 翻译源包含 Wox AI
  // When 用户用 tr 查询多个单词组成的短语
  // Then 查询仍走 Wox AI
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  await h.query("hello world")
  expect(calledProviders()).toEqual(["wox_ai"])
})

test("explicit tr wox bypasses the fast path", async () => {
  // SN-FP-004
  // Scenario: 显式指定 Wox AI 时尊重用户意图
  // Given 单词快速路径已开启
  // When 用户显式输入 tr wox 查询单词
  // Then 查询走 Wox AI 而不是词典
  const h = await setup({ visible_providers: "", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  await h.query("wox hello")
  expect(calledProviders()).toEqual(["wox_ai"])
})

test("multi-provider selection replaces only the wox_ai row", async () => {
  // SN-FP-005
  // Scenario: 多翻译源场景只替换 Wox AI 行
  // Given 单词快速路径已开启
  // And 已选翻译源为 microsoft、wox_ai
  // When 用户用 tr 查询单个英文单词
  // Then Microsoft 行保留
  // And Wox AI 行变成有道词典
  // And 词典行排在 Wox AI 原来的位置之后且不重复
  const h = await setup({ visible_providers: "microsoft,wox_ai", single_word_fast_path: "true" })
  await h.query("hello")
  expect(calledProviders()).toEqual(["microsoft", "youdao_word"])
})

test("dictionary results and fast-path results use isolated history entries", async () => {
  // SN-FP-006
  // Scenario: 快速路径与 AI 结果的历史缓存互不污染
  // Given 单词快速路径已开启且翻译源为 Wox AI
  // When 先后翻译同一个英文单词两次
  // Then 第二次命中快速路径自己的历史缓存，不再发起任何翻译请求
  // And 缓存条目记录的是有道词典来源并附带词典元数据
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true" })
  await h.query("hello")
  await h.query("hello")
  expect(calledProviders()).toEqual(["youdao_word"])
  const saved = h.settings.translation_history
  expect(saved).toContain('"provider":"youdao_word"')
  expect(saved).toContain('"dictionary"')
})

test("non-English single words do not trigger the fast path", async () => {
  // SN-FP-008
  // Scenario: 非英文单词不触发快速路径
  // Given 单词快速路径已开启
  // And 翻译源包含 Wox AI
  // When 用户用 tr 查询中文单词“你好”
  // Then 查询仍走 Wox AI，词典不参与
  // And 无论词典是否有词条，都不会出现硬失败
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  await h.query("你好")
  expect(calledProviders()).toEqual(["wox_ai"])
  await h.query("こんにちは")
  expect(calledProviders()).toEqual(["wox_ai", "wox_ai"])
})

test("explicit source language bypasses the fast path", async () => {
  // SN-FP-009
  // Scenario: 显式指定源语言时尊重用户意图
  // Given 单词快速路径已开启
  // When 用户用 tr en:ja hello 指定方向
  // Then 查询仍走 Wox AI
  const h = await setup({ visible_providers: "", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }), default_provider: "wox_ai" })
  await h.query("en:ja hello")
  expect(calledProviders()).toEqual(["wox_ai"])
})

test("dictionary failure falls back to Wox AI instead of surfacing an error", async () => {
  // SN-FP-010
  // Scenario: 词典查无此词时自动回退
  // Given 单词快速路径已开启且翻译源为 Wox AI
  // And 词典查询对英文单词返回失败
  // When 用户查询单词
  // Then 结果来自回退后的 Wox AI 而不是失败提示
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  const spy = jest.spyOn(translate, "translateText").mockImplementation(async provider => {
    if (provider === "youdao_word") throw new Error("Youdao Dict found no entry for this word.")
    return { translatedText: "你好", providerName: "Wox AI" }
  })
  const response = await h.query("hello")
  expect(spy.mock.calls.map(call => call[0])).toEqual(["youdao_word", "wox_ai"])
  expect(response.Results[0].Title).toBe("你好")
  expect(JSON.stringify(response.Results[0])).not.toContain("no entry")
})

test("explicit tr dict keeps direct dictionary lookup with error surface", async () => {
  // SN-FP-011
  // Scenario: 显式 dict 命令不走回退
  // Given 单词快速路径开关状态不限
  // When 用户显式输入 tr dict 查询
  // Then 直接走词典来源，失败时如实展示错误（便于用户感知）
  const h = await setup({ visible_providers: "", single_word_fast_path: "true", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
  jest.spyOn(translate, "translateText").mockImplementation(async provider => {
    if (provider === "youdao_word") throw new Error("Youdao Dict found no entry for this word.")
    return { translatedText: "x", providerName: provider }
  })
  const response = await h.query("dict wzxvqk")
  expect(calledProviders()).toEqual(["youdao_word"])
  expect(response.Results[0].SubTitle).toContain("no entry")
})

test("retry actions offer switching back to Wox AI", async () => {
  // SN-FP-007
  // Scenario: 快速路径结果保留切换回 AI 的动作
  // Given 单词快速路径已开启并返回词典结果
  // When 构建结果动作
  // Then 动作列表包含“用 Wox AI 重试”
  const h = await setup({ visible_providers: "wox_ai", single_word_fast_path: "true" })
  const response = await h.query("hello")
  const actions = JSON.stringify(response.Results[0].Actions)
  expect(actions).toContain("Wox AI")
})
