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
  // When 用户用 tr 查询单个单词
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
  // When 先后翻译同一个单词两次
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
