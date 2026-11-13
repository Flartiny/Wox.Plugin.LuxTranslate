import { ActionContext, Context, ExecuteResultAction, Query, Result } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { DEFAULT_SETTINGS, parseTranslationQuery, resolveLanguageDirection, translateWithMicrosoft } from "../translate"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ctx = {} as Context
const originalFetch = global.fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function ms(text = "你好"): Response {
  return json([{ translations: [{ text }] }])
}

async function setup(overrides: Record<string, string> = {}) {
  const settings: Record<string, string> = { request_timeout_ms: "300", ...overrides }
  const pushed: Result[] = []
  const updates: Result[] = []
  const api = {
    GetSetting: jest.fn(async (_ctx, key: string) => settings[key] ?? ""),
    SaveSetting: jest.fn(async (_ctx, key: string, value: string) => {
      await new Promise(resolve => setTimeout(resolve, 1))
      settings[key] = value
    }),
    GetTranslation: jest.fn(async (_ctx, key: string) => (key === "language_probe" ? "zh" : key)),
    Copy: jest.fn(async () => undefined),
    ChangeQuery: jest.fn(async () => undefined),
    Log: jest.fn(async () => undefined),
    UpdateResult: jest.fn(async (_ctx, update: Result) => {
      updates.push(update)
      return true
    }),
    PushResults: jest.fn(async (_ctx, _query: Query, results: Result[]) => {
      pushed.push(...results)
      return true
    }),
    // Wox 本体 AI 通道：默认按 Wox 的语义推送累积正文，最后再推 finished。
    AIChatStream: jest.fn(async (_ctx, _model, _conversations, _options, callback: (data: { Status: string; Data: string; Reasoning?: string }) => void) => {
      callback({ Status: "streaming", Data: "你" })
      callback({ Status: "streaming", Data: "你好" })
      callback({ Status: "finished", Data: "你好" })
    })
  }
  await plugin.init(ctx, { API: api } as never)
  async function response(text: string, selection = false, refinements?: Record<string, string>) {
    pushed.length = 0
    const raw = await plugin.query(ctx, {
      Id: "probe-query",
      Type: selection ? "selection" : "input",
      Search: text,
      RawQuery: `tr ${text}`,
      Env: {} as Query["Env"],
      IsGlobalQuery: () => false,
      Selection: { Type: "text", Text: text, FilePaths: [] },
      Refinements: refinements
    } as Query & { Refinements?: Record<string, string> })
    const result = raw as unknown as Result[] | { Results: Result[]; Refinements?: Array<{ Id: string; Type: string; DefaultValue: string[]; Options: Array<{ Value: string }> }> }
    return Array.isArray(result) ? { Results: [...pushed, ...result], Refinements: [] } : { ...result, Results: [...pushed, ...result.Results], Refinements: result.Refinements || [] }
  }
  return {
    api,
    settings,
    response,
    restart: () => plugin.init(ctx, { API: api } as never),
    updates,
    history: () => JSON.parse(settings.translation_history || "[]") as Array<{ sourceText: string; provider: string; translatedText: string }>,
    async query(text: string, selection = false, refinements?: Record<string, string>): Promise<Result[]> {
      return (await response(text, selection, refinements)).Results
    },
    async finish(initial: Result): Promise<Result> {
      if (!initial.Id) return initial
      const started = Date.now()
      while (Date.now() - started < 1500) {
        const last = updates.filter(update => update.Id === initial.Id).slice(-1)[0]
        if (last && (last.Actions?.length || /failed|incomplete/i.test(last.Title || ""))) return { ...initial, ...last }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error("Stream did not finish")
    }
  }
}

function action(result: Result, predicate: (item: ExecuteResultAction) => boolean): ExecuteResultAction {
  const found = (result.Actions as ExecuteResultAction[] | undefined)?.find(predicate)
  expect(found).toBeDefined()
  return found!
}

afterEach(() => {
  global.fetch = originalFetch
  jest.clearAllMocks()
})

describe("LuxTranslate 翻译与配置回归场景", () => {
  test("空查询提供一个原生多选筛选入口并恢复当前来源", async () => {
    // Given 用户此前选择了 DeepSeek
    const h = await setup({ visible_provider_deepseek: "true" }) // legacy switch -> wox_ai
    global.fetch = jest.fn() as typeof fetch
    // When 打开翻译插件但尚未输入原文
    const response = await h.response("")
    // Then 只提供一个多选筛选入口且不发出翻译请求
    expect(response.Refinements).toHaveLength(1)
    expect(response.Refinements[0]).toMatchObject({ Id: "translation_providers", Type: "multiSelect", DefaultValue: ["wox_ai"] })
    expect(response.Refinements[0].Options.map(option => option.Value)).toEqual(["microsoft", "youdao", "caiyun", "wox_ai"])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test("集中选择多个来源后保存并在插件重载后恢复", async () => {
    // Given 用户在无原文的翻译窗口中配置来源
    const h = await setup({ visible_provider_deepseek: "true" }) // legacy switch -> wox_ai
    // When 在多选筛选中选中 Microsoft 和有道再重新加载插件
    await h.response("", false, { translation_providers: "microsoft,youdao" })
    await h.restart()
    const response = await h.response("")
    // Then 新选择保留而旧的 DeepSeek 不再启用
    expect(response.Refinements[0].DefaultValue).toEqual(["microsoft", "youdao"])
    expect(h.settings.visible_providers).toBe("microsoft,youdao")
  })

  test("取消部分来源后实际翻译只请求仍然选中的来源", async () => {
    // Given 原来同时启用了 Microsoft 和有道
    const h = await setup({ visible_providers: "microsoft,youdao" })
    global.fetch = jest.fn(async () => json({ translateResult: [[{ tgt: "您好" }]] })) as typeof fetch
    // When 在多选入口取消 Microsoft 后翻译
    const results = await h.query("hello", false, { translation_providers: "youdao" })
    // Then 只请求有道且 Microsoft 偏好已关闭
    expect(results).toHaveLength(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("youdao")
    expect(h.settings.visible_providers).toBe("youdao")
  })

  test("恢复默认操作清除多源选择且重开时不复活旧偏好", async () => {
    // Given 旧版本保存了 DeepSeek 而全局默认来源是 Microsoft
    const h = await setup({ visible_providers: "wox_ai" })
    const response = await h.response("")
    // When 使用恢复默认操作并重新加载插件
    expect(response.Results[0].Actions?.some(item => item.Name === "action_use_default_provider")).toBeFalsy()
    const reset = action(response.Results[1], item => item.Name === "action_use_default_provider")
    await reset.Action(ctx, { ContextData: {} } as ActionContext)
    await h.restart()
    const reopened = await h.response("")
    // Then 仅使用默认来源且旧偏好保持关闭
    expect(reopened.Refinements[0].DefaultValue).toEqual([])
    expect(h.settings.visible_providers).toBe("")
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "tr " })
  })

  test("显式指定翻译源时不改写集中选择的偏好", async () => {
    // Given 用户集中选择了 DeepSeek
    const h = await setup({ visible_provider_deepseek: "true" }) // legacy switch -> wox_ai
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 用命令明确指定 Microsoft 且收到同一窗口遗留的筛选值
    const response = await h.response("ms hello", false, { translation_providers: "microsoft,youdao" })
    // Then 只请求 Microsoft 且不修改已迁移的 Wox AI 选择
    expect(response.Refinements).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(h.settings.visible_providers).toBe("wox_ai")
  })

  test("连续快速选择时保存最后一次完整选择", async () => {
    // Given 用户连续修改同一个来源筛选
    const h = await setup()
    // When 两次修改的保存过程发生交错
    await Promise.all([h.response("", false, { translation_providers: "microsoft,youdao" }), h.response("", false, { translation_providers: "youdao" })])
    // Then 最后一次选择完整保存
    const response = await h.response("")
    expect(response.Refinements[0].DefaultValue).toEqual(["youdao"])
    expect(h.settings.visible_providers).toBe("youdao")
  })

  test("在当前 Wox 中配置多个翻译源后实际按所选来源翻译", async () => {
    // Given 用户原有的两个翻译源选择已保存
    const h = await setup({ visible_provider_microsoft: "true", visible_provider_youdao: "true" })
    global.fetch = jest.fn(async (url: string | URL | Request) => (String(url).includes("youdao") ? json({ translateResult: [[{ tgt: "您好" }]] }) : ms())) as typeof fetch
    // When 保存的选择用于一次普通翻译
    const results = await h.query("hello")
    // Then 两个翻译源都被请求且设置页不再堆叠独立开关
    expect(results).toHaveLength(2)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"))
    const fields = manifest.SettingDefinitions as Array<{ Type: string; Value: { Key?: string } }>
    expect(fields.some(item => item.Type === "select" && item.Value.Key === "visible_providers")).toBe(true)
    expect(fields.filter(item => item.Type === "checkbox" && item.Value.Key?.startsWith("visible_provider_"))).toHaveLength(0)
  })

  test("设置页每条说明只出现一次，不会重复渲染", () => {
    // Given 设置项的说明写在 Tooltip 上
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"))
    const fields = manifest.SettingDefinitions as Array<{ Type: string; Value: { Key?: string; Tooltip?: string; Content?: string } }>
    const tooltips = new Set(fields.filter(item => item.Value.Tooltip).map(item => item.Value.Tooltip))
    // Then 没有再额外插入一条内容相同的 label（Wox 会把 Tooltip 渲染在控件下方，
    // 额外的 label 会显示成第二份说明，而且在窄窗口里被截断）
    const duplicated = fields.filter(item => item.Type === "label" && item.Value.Content && tooltips.has(item.Value.Content))
    expect(duplicated).toEqual([])
  })

  test("选择 Wox 本体 AI 模型后无需填 Key 即可翻译且只显示译文", async () => {
    // Given 用户只在 Wox 设置里配置过 AI，插件没有自己的 key
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", ProviderAlias: "mynewapi", Name: "gpt-4o-mini" }) })
    // And 模型会先推思考内容再推正文
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "思考中…", Reasoning: "先判断语种" })
      callback({ Status: "streaming", Data: "你好", Reasoning: "先判断语种" })
      callback({ Status: "finished", Data: "你好", Reasoning: "先判断语种" })
    })
    global.fetch = jest.fn() as typeof fetch
    // When 用 wox_ai 翻译
    const [initial] = await h.query("wox hello")
    const final = await h.finish(initial)
    // Then 直接用 Wox 的模型通道，插件不发 HTTP 请求
    expect(h.api.AIChatStream).toHaveBeenCalledWith(ctx, { Provider: "openai", ProviderAlias: "mynewapi", Name: "gpt-4o-mini" }, expect.any(Array), {}, expect.any(Function))
    expect(global.fetch).not.toHaveBeenCalled()
    // And 结果只有译文，思考内容既不进标题也不进预览
    expect(final.Title).toBe("你好")
    expect(JSON.stringify(final)).not.toContain("思考")
  })

  test("未选择 Wox 模型时提示去插件设置选择而不是发起请求", async () => {
    // Given 用户选了 wox_ai 但还没选模型
    const h = await setup({ visible_providers: "wox_ai" })
    global.fetch = jest.fn() as typeof fetch
    // When 翻译
    const [result] = await h.query("wox hello")
    // Then 给出配置提示且不触发任何请求
    expect(result.Title).toContain("needs configuration")
    expect(result.SubTitle).toContain("Wox AI model")
    expect(h.api.AIChatStream).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test("Wox AI 通过宿主实例调用，不丢失 llmStreamCallbacks", async () => {
    // Given 宿主把流回调挂在实例上（真实 Wox node host 就是这种形状）
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    class HostApi {
      declare llmStreamCallbacks: Map<string, (data: { Status: string; Data: string }) => void>
      async AIChatStream(_ctx: unknown, _model: unknown, _conversations: unknown, _options: unknown, callback: (data: { Status: string; Data: string }) => void) {
        // 摘掉 this 再调用会在这一行抛
        // "Cannot read properties of undefined (reading 'llmStreamCallbacks')"
        this.llmStreamCallbacks.set("cb", callback)
        const emit = this.llmStreamCallbacks.get("cb")!
        emit({ Status: "streaming", Data: "你好" })
        emit({ Status: "finished", Data: "你好" })
      }
    }
    // Mirror the real host: AIChatStream is a prototype method and the stream
    // callback map is an instance field, so detaching the method breaks `this`.
    const proto = HostApi.prototype as unknown as Record<string, unknown>
    Object.setPrototypeOf(h.api, proto)
    Object.assign(h.api, { llmStreamCallbacks: new Map() })
    // setup() installs AIChatStream as an own jest.fn; an own property shadows the
    // prototype, so drop it and let the lookup reach HostApi.prototype.
    delete (h.api as Record<string, unknown>).AIChatStream
    await h.restart()
    global.fetch = jest.fn() as typeof fetch
    // When 用 wox_ai 翻译
    const [initial] = await h.query("hello")
    const final = await h.finish(initial)
    // Then 正常拿到译文，而不是报 llmStreamCallbacks 错误
    expect(final.Title).toBe("你好")
    expect(JSON.stringify(final)).not.toContain("llmStreamCallbacks")
  })

  test("旧的大模型来源选择会迁移到 Wox AI 而不是变成死路", async () => {
    // Given 旧设置里选了 custom 并保留了 LLM 表，升级后表已不再使用
    const h = await setup({ visible_providers: "llm_custom", llm_provider_table: "[]", wox_ai_model: JSON.stringify({ Provider: "openai", ProviderAlias: "Mercury", Name: "mercury-3" }) })
    // When 普通翻译
    const [placeholder] = await h.query("hello")
    expect(placeholder.Title).toBe("translating_title")
    // Await the stream so it cannot outlive this test and touch the next one's API.
    expect((await h.finish(placeholder)).Title).toBe("你好")
    // Then 直接走 Wox AI，用旧设置里选中的模型，不再出现需要填 Key 的提示
    expect(h.api.AIChatStream).toHaveBeenCalledWith(ctx, { Provider: "openai", ProviderAlias: "Mercury", Name: "mercury-3" }, expect.any(Array), {}, expect.any(Function))
  })

  test("没有配置 Wox AI 模型时提示去插件设置选择", async () => {
    // Given 用户选了 Wox AI 但还没选模型
    const h = await setup({ visible_providers: "wox_ai" })
    global.fetch = jest.fn() as typeof fetch
    // When 普通翻译
    const results = await h.query("hello")
    // Then 只有配置提示，且不发起任何请求
    expect(results).toHaveLength(1)
    expect(results[0].Title).toContain("needs configuration")
    expect(h.api.AIChatStream).not.toHaveBeenCalled()
  })

  test("翻译成功后不额外追加建议行", async () => {
    // Given Wox AI 模型已配置，但用户当前用 Microsoft 且能正常工作
    const h = await setup({ visible_providers: "microsoft", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 翻译成功
    const results = await h.query("hello")
    // Then 结果里没有多余的建议行
    expect(results).toHaveLength(1)
    expect(results[0].Title).toBe("你好")
  })

  test("免配置翻译源仍然可以逐行配置而不影响大模型", async () => {
    // Given 用户在免配置表格里保留了自定义名称
    const h = await setup({ no_setup_provider_table: JSON.stringify([{ provider: "microsoft", name: "MS custom" }]) })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 使用该来源翻译
    const [result] = await h.query("ms hello")
    // Then 走免配置接口，不需要任何 Key
    expect(result.Title).toBe("你好")
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test.each(["history", "en", "ms is an abbreviation"])("选中的文本始终作为原文而不是插件命令：%s", async text => {
    // Given 用户选中一个可能与命令重名的原文
    const h = await setup()
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 通过选中文本入口查询
    await h.query(text, true)
    // Then 完整原文进入翻译
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const init = (global.fetch as jest.Mock).mock.calls[0][1]
    expect(JSON.parse(init.body)[0].Text).toBe(text)
  })

  test("切换翻译源保留已指定的源语言和目标语言", async () => {
    // Given 原文明确指定英文翻译为日文
    const h = await setup()
    global.fetch = jest.fn(async () => ms("こんにちは")) as typeof fetch
    const [result] = await h.query("ms en:ja hello")
    // When 点击另一个翻译源
    const change = action(result, item => item.ContextData?.provider === "youdao")
    await change.Action(ctx, { ResultId: "", ResultActionId: "", ContextData: { provider: "youdao" } } as ActionContext)
    // Then 新命令保留语言方向
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, expect.objectContaining({ QueryText: expect.stringContaining("en:ja hello") }))
  })

  test("多个翻译源同时完成时每份历史记录都能保留", async () => {
    // Given 两个来源同时翻译且先后完成
    const h = await setup({ visible_providers: "microsoft,youdao" })
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      await new Promise(resolve => setTimeout(resolve, String(url).includes("youdao") ? 10 : 2))
      return String(url).includes("youdao") ? json({ translateResult: [[{ tgt: "您好" }]] }) : ms()
    }) as typeof fetch
    // When 两者保存各自成功结果
    await h.query("hello")
    // Then 每份历史均被保留
    expect(
      h
        .history()
        .map(entry => entry.provider)
        .sort()
    ).toEqual(["microsoft", "youdao"])
  })

  test("更换 Wox AI 模型后不复用原模型的译文缓存", async () => {
    // Given 模型 A 已经翻译过并写入历史
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "model-A" }) })
    await h.finish((await h.query("hello"))[0])
    // When 换成模型 B 再查同一句
    h.settings.wox_ai_model = JSON.stringify({ Provider: "openai", Name: "model-B" })
    await h.finish((await h.query("hello"))[0])
    // Then 两次都真正请求了宿主模型，没有命中旧缓存
    expect(h.api.AIChatStream).toHaveBeenCalledTimes(2)
    expect(h.api.AIChatStream.mock.calls.map(call => call[1].Name)).toEqual(["model-A", "model-B"])
  })

  test("保留原文换行、空行和代码缩进", () => {
    // Given 命令中的正文包含分段与缩进
    const text = "First line\n\n    code  block\nLast line"
    // When 解析正文
    const parsed = parseTranslationQuery(`ms en:zh ${text}`, "microsoft")
    // Then 正文保持不变
    expect(parsed.text).toBe(text)
  })

  test("Wox AI 流式输出逐步更新并保留可复制的完整译文", async () => {
    // Given 宿主模型依次推送多个片段
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "完" })
      callback({ Status: "streaming", Data: "完整" })
      callback({ Status: "finished", Data: "完整译文" })
    })
    // When 查询时先展示占位结果再接收片段
    const [initial] = await h.query("hello")
    expect(initial.Id).toBeTruthy()
    const final = await h.finish(initial)
    // Then 有逐步更新且完整译文可复制
    expect(h.updates.length).toBeGreaterThan(1)
    const copy = action(final, item => item.Name === "action_copy_translation")
    await copy.Action(ctx, { ContextData: {} } as ActionContext)
    expect(h.api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: "完整译文" })
  })

  test.each(["length", "error"])("宿主模型异常结束时不会冒充完整结果：%s", async reason => {
    // Given 宿主在结束前报告了错误（长度截断或上游报错）
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "只有前半段" })
      callback({ Status: "error", Data: `model stopped: ${reason}` })
    })
    // When 处理结束原因
    const result = await h.finish((await h.query("hello"))[0])
    // Then 提示失败且不保存成功缓存
    expect(`${result.Title} ${result.SubTitle}`).toMatch(/failed|incomplete|失败|不完整/i)
    expect(h.history()).toHaveLength(0)
  })

  test("宿主流没有结束事件时不会保存为完整译文", async () => {
    // Given 流推送了正文，但始终没有 finished
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "只有前半段" })
    })
    // When 流悄悄停住，直到空闲超时
    jest.useFakeTimers()
    try {
      const pending = h.query("hello")
      await jest.advanceTimersByTimeAsync(30000)
      const [initial] = await pending
      const result = await h.finish(initial)
      // Then 不将半份译文存入成功历史
      expect(`${result.Title} ${result.SubTitle}`).toMatch(/failed|incomplete|失败|不完整/i)
      expect(h.history()).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test("请求超时也覆盖响应正文的读取", async () => {
    // Given 响应头及时到达而正文超出期限
    global.fetch = jest.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify([{ translations: [{ text: "迟到译文" }] }])))
                controller.close()
              }, 80)
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(timer)
                controller.error(new Error("aborted"))
              })
            }
          })
        )
    ) as typeof fetch
    // When 超过配置的 15 毫秒
    const request = translateWithMicrosoft({ text: "hello", direction: resolveLanguageDirection("hello", "auto", "zh"), settings: { ...DEFAULT_SETTINGS, requestTimeoutMs: 15 } })
    // Then 正文读取随请求超时结束
    await expect(request).rejects.toThrow(/timeout|timed out|abort|超时/i)
  })

  test("翻译失败后可以直接重试或切换翻译源", async () => {
    // Given 一个翻译源失败
    const h = await setup()
    global.fetch = jest.fn(async () => json({ error: "unavailable" }, 503)) as typeof fetch
    // When 显示失败结果
    const [result] = await h.query("ms en:ja hello")
    // Then 失败页面仍可重试与换源
    expect(action(result, item => item.Name === "action_retranslate")).toBeDefined()
    const change = action(result, item => item.ContextData?.provider === "youdao")
    await change.Action(ctx, { ResultId: "", ResultActionId: "", ContextData: { provider: "youdao" } } as ActionContext)
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, expect.objectContaining({ QueryText: expect.stringContaining("en:ja hello") }))
  })

  test("用户可以主动重新翻译而不继续命中旧缓存", async () => {
    // Given 原文已有成功缓存
    const h = await setup()
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    const [result] = await h.query("hello")
    // When 选择重新翻译后执行生成的命令
    const retry = action(result, item => item.Name === "action_retranslate")
    await retry.Action(ctx, { ContextData: {} } as ActionContext)
    const next = h.api.ChangeQuery.mock.calls[0] as unknown as [Context, { QueryText: string }]
    await h.query(next[1].QueryText.replace(/^tr\s+/, ""))
    // Then 再次请求且不重复增加相同历史
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(h.history()).toHaveLength(1)
  })

  test("手动朗读等现有功能继续可用且不自动播放", async () => {
    // Given 用户启用手动朗读
    const h = await setup({ enable_speech_playback: "true" })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 成功翻译但尚未点击播放
    const [result] = await h.query("hello")
    // Then 手动朗读和复制操作仍可用
    expect(action(result, item => item.Name === "action_play_translation")).toBeDefined()
    expect(action(result, item => item.Name === "action_copy_translation")).toBeDefined()
    expect(h.api.Copy).not.toHaveBeenCalled()
  })

  test("保留旧版本的多源选择且取消所有勾选后使用默认来源", async () => {
    // Given 旧版本保存了两个翻译源
    const h = await setup({ visible_providers: '["microsoft","youdao"]' })
    expect(h.settings.visible_providers).toBe("microsoft,youdao")
    // When 用户在设置页清空选择
    h.settings.visible_providers = ""
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    await h.query("hello")
    // Then 不重新启用旧选择且只使用默认翻译源
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test("显式自动检测源语言覆盖全局固定源语言", async () => {
    // Given 用户全局设置源语言为英文
    const h = await setup({ default_source_language: "en" })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 命令明确要求自动检测源语言
    await h.query("ms auto:ja hello")
    // Then 请求不再带全局固定的源语言
    const url = new URL((global.fetch as jest.Mock).mock.calls[0][0])
    expect(url.searchParams.has("from")).toBe(false)
  })

  test("不同查询同时完成时也不丢失历史", async () => {
    // Given 两次查询同时等待翻译
    const h = await setup()
    global.fetch = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return ms()
    }) as typeof fetch
    // When 两次查询接近同时完成
    await Promise.all([h.query("hello"), h.query("world")])
    // Then 两份历史均被保留
    expect(
      h
        .history()
        .map(entry => entry.sourceText)
        .sort()
    ).toEqual(["hello", "world"])
  })

  test.each(["end_turn", "max_tokens"])("宿主模型结束状态被如实处理：%s", async reason => {
    // Given 宿主以 stopped 收尾但没有 finished
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "部分译文" })
      callback({ Status: reason === "end_turn" ? "finished" : "error", Data: reason === "end_turn" ? "部分译文" : "truncated" })
    })
    // When 处理结束
    const result = await h.finish((await h.query("hello"))[0])
    // Then end_turn 视为完成，其他原因视为失败
    if (reason === "end_turn") {
      expect(result.Title).toBe("部分译文")
      expect(h.history()).toHaveLength(1)
    } else {
      expect(`${result.Title} ${result.SubTitle}`).toMatch(/failed|incomplete|失败|不完整/i)
      expect(h.history()).toHaveLength(0)
    }
  })

  test("Wox AI 占位行随查询返回，不依赖 PushResults", async () => {
    // Given 使用 Wox 本体 AI
    const h = await setup({ visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })
    h.api.AIChatStream.mockImplementation(async (_ctx, _model, _conversations, _options, callback) => {
      callback({ Status: "streaming", Data: "译文" })
      callback({ Status: "finished", Data: "译文" })
    })
    // When 发起查询
    const [placeholder] = await h.query("hello")
    // Then 占位行直接出现在响应里，而不是通过 PushResults 追加
    expect(placeholder.Id).toMatch(/^lux-tr-/)
    expect(h.api.PushResults).not.toHaveBeenCalled()
    const final = await h.finish(placeholder)
    expect(final.Title).toBe("译文")
    expect(h.history()).toHaveLength(1)
  })

  test("服务识别出的实际源语言纠正纯汉字日文的自动方向", async () => {
    // Given 本地字符规则将纯汉字日文误判为中文而服务识别为日文
    const h = await setup()
    global.fetch = jest.fn(async () => json([{ detectedLanguage: { language: "ja" }, translations: [{ text: "东京大学" }] }])) as typeof fetch
    // When 自动翻译后再次查询相同原文
    await h.query("東京大学", true)
    await h.query("東京大学", true)
    // Then 方向纠正为中文且第二次使用正确方向的历史
    const urls = (global.fetch as jest.Mock).mock.calls.map(call => new URL(call[0]))
    expect(urls).toHaveLength(2)
    expect(urls[1].searchParams.get("to")).toBe("zh-Hans")
    expect(h.history()).toHaveLength(1)
  })
})
