import {
  collapseExtraBlankLines,
  DEFAULT_SETTINGS,
  detectLanguage,
  getMissingConfiguration,
  historyKeyMatches,
  parseHistoryEntries,
  parseProviderList,
  parseProviderTableRows,
  parseTranslationQuery,
  parseWoxAiModel,
  resolveLanguageDirection,
  searchHistoryEntries,
  translateText,
  translationConfigurationKey,
  translateWithCaiyun,
  translateWithDeepL,
  translateWithMicrosoft,
  translateWithYoudao,
  upsertHistoryEntry,
  WoxAiStreamer
} from "../translate"

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response
}

function firstFetchCall(fetchMock: jest.Mock): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit]
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

function caiyunEncrypt(plainText: string): string {
  const normalKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=.+-_/"
  const cipherKey = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm0123456789=.+-_/"
  const map: Record<string, string> = {}
  for (let i = 0; i < normalKey.length; i++) {
    map[normalKey[i]] = cipherKey[i]
  }
  return Buffer.from(plainText, "utf8")
    .toString("base64")
    .split("")
    .map(char => map[char] ?? char)
    .join("")
}

describe("collapseExtraBlankLines", () => {
  test("collapses 3+ consecutive newlines to one", () => {
    expect(collapseExtraBlankLines("a\n\n\n\nb")).toBe("a\nb")
    expect(collapseExtraBlankLines("line1\n\n\n\n\nline2")).toBe("line1\nline2")
  })

  test("preserves single and double newlines", () => {
    expect(collapseExtraBlankLines("a\nb")).toBe("a\nb")
    expect(collapseExtraBlankLines("a\n\nb")).toBe("a\n\nb")
  })

  test("returns text without newlines unchanged", () => {
    expect(collapseExtraBlankLines("hello world")).toBe("hello world")
  })

  test("returns empty string unchanged", () => {
    expect(collapseExtraBlankLines("")).toBe("")
  })
})

describe("language detection (8 languages)", () => {
  test("detects Chinese via CJK", () => {
    expect(detectLanguage("你好世界")).toBe("zh")
    expect(detectLanguage("今天天气不错")).toBe("zh")
  })

  test("detects Japanese via Kana", () => {
    expect(detectLanguage("こんにちは")).toBe("ja")
    expect(detectLanguage("今日はいい天気ですね")).toBe("ja")
    expect(detectLanguage("私は中国人です")).toBe("ja")
  })

  test("detects Korean via Hangul", () => {
    expect(detectLanguage("안녕하세요")).toBe("ko")
    expect(detectLanguage("감사합니다")).toBe("ko")
  })

  test("detects Russian via Cyrillic", () => {
    expect(detectLanguage("Привет")).toBe("ru")
    expect(detectLanguage("Здравствуйте как дела")).toBe("ru")
  })

  test("detects Arabic via Arabic script", () => {
    expect(detectLanguage("مرحبا")).toBe("ar")
    expect(detectLanguage("كيف حالك")).toBe("ar")
  })

  test("detects German via specific chars", () => {
    expect(detectLanguage("schön und großartig")).toBe("de")
    expect(detectLanguage("für die Prüfung")).toBe("de")
  })

  test("detects French via specific chars", () => {
    expect(detectLanguage("Bonjour ça va")).toBe("fr")
    expect(detectLanguage("très bien merci")).toBe("fr")
  })

  test("detects English as default for Latin text", () => {
    expect(detectLanguage("hello world")).toBe("en")
    expect(detectLanguage("this is a test")).toBe("en")
  })

  test("returns English for empty/symbol text", () => {
    expect(detectLanguage("123")).toBe("en")
    expect(detectLanguage("")).toBe("en")
  })
})

describe("resolveLanguageDirection (8 languages)", () => {
  test("translates non-Wox language to Wox language", () => {
    const dir = resolveLanguageDirection("привет мир", "auto", "zh")
    expect(dir.sourceLanguage).toBe("auto")
    expect(dir.targetLanguage).toBe("zh")
    expect(dir.targetLabel).toBe("Chinese")
  })

  test("translates Wox language to paired language", () => {
    const dir = resolveLanguageDirection("你好世界", "auto", "zh")
    expect(dir.sourceLanguage).toBe("auto")
    expect(dir.targetLanguage).toBe("en")
    expect(dir.targetLabel).toBe("English")
  })

  test("can honor a fixed target through the pair language", () => {
    const dir = resolveLanguageDirection("hello", "zh", "zh", "zh")
    expect(dir.targetLanguage).toBe("zh")
    expect(dir.targetLabel).toBe("Chinese")
  })

  test("uses explicit source language", () => {
    const dir = resolveLanguageDirection("hello", "zh", "en")
    expect(dir.sourceLanguage).toBe("zh")
    expect(dir.targetLanguage).toBe("en")
  })

  test("returns correct Microsoft target codes", () => {
    expect(resolveLanguageDirection("你好", "auto", "zh").microsoftTarget).toBe("en")
    expect(resolveLanguageDirection("hello", "auto", "zh").microsoftTarget).toBe("zh-Hans")
    expect(resolveLanguageDirection("こんにちは", "auto", "zh").microsoftTarget).toBe("zh-Hans")
  })

  test("returns correct DeepL target codes", () => {
    expect(resolveLanguageDirection("안녕", "auto", "zh").deeplTarget).toBe("ZH")
    expect(resolveLanguageDirection("hello", "auto", "ko").deeplTarget).toBe("KO")
  })
})

describe("query parsing", () => {
  test("uses default provider when no provider command is present", () => {
    expect(parseTranslationQuery("hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      forcedProvider: false
    })
  })

  test("parses provider commands", () => {
    expect(parseTranslationQuery("ms hello", "deepl")).toMatchObject({ provider: "microsoft", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("deepl hello", "microsoft")).toMatchObject({ provider: "deepl", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("wox hello", "microsoft")).toMatchObject({ provider: "wox_ai", text: "hello", forcedProvider: true })
    // The old per-vendor commands stay valid so existing habits keep working.
    expect(parseTranslationQuery("openai hello", "microsoft")).toMatchObject({ provider: "wox_ai", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("claude hello", "microsoft")).toMatchObject({ provider: "wox_ai", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("deepseek hello", "microsoft")).toMatchObject({ provider: "wox_ai", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("custom hello", "microsoft")).toMatchObject({ provider: "wox_ai", text: "hello", forcedProvider: true })
  })

  test("parses target language from bare code", () => {
    expect(parseTranslationQuery("zh hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      targetLanguage: "zh",
      forcedProvider: false
    })
    expect(parseTranslationQuery("en hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "en"
    })
    expect(parseTranslationQuery("ja hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "ja"
    })
  })

  test("parses source:target language spec", () => {
    expect(parseTranslationQuery("en:zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      sourceLanguage: "en",
      targetLanguage: "zh"
    })
    expect(parseTranslationQuery("ja:en こんにちは", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "こんにちは",
      sourceLanguage: "ja",
      targetLanguage: "en"
    })
  })

  test("parses auto:zh and :zh syntax", () => {
    expect(parseTranslationQuery("auto:zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh",
      sourceLanguage: "auto"
    })
    expect(parseTranslationQuery(":zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh"
    })
  })

  test("parses provider + target language combo", () => {
    expect(parseTranslationQuery("ms zh hello", "deepl")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh",
      forcedProvider: true
    })
    expect(parseTranslationQuery("deepl en:ja hello world", "microsoft")).toMatchObject({
      provider: "deepl",
      text: "hello world",
      sourceLanguage: "en",
      targetLanguage: "ja",
      forcedProvider: true
    })
  })

  test("ignores non-language words as target spec", () => {
    expect(parseTranslationQuery("hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      targetLanguage: undefined
    })
    expect(parseTranslationQuery("xx hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "xx hello",
      targetLanguage: undefined
    })
  })

  test("preserves newlines in text portion", () => {
    expect(parseTranslationQuery("hello\nworld\n\ntest", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello\nworld\n\ntest",
      forcedProvider: false
    })
    expect(parseTranslationQuery("ms zh line1\nline2\n\nline3", "deepl")).toMatchObject({
      provider: "microsoft",
      text: "line1\nline2\n\nline3",
      targetLanguage: "zh",
      forcedProvider: true
    })
  })

  test("parses visible provider lists", () => {
    expect(parseProviderList("microsoft,wox_ai,deepl,wox_ai")).toEqual(["microsoft", "wox_ai", "deepl"])
    expect(parseProviderList(JSON.stringify(["deepl", "unknown"]))).toEqual(["deepl"])
    // Legacy selections are migrated instead of dropped, so upgrading keeps the
    // user's active provider rather than silently falling back to the default.
    expect(parseProviderList("openai_compatible,llm_custom")).toEqual(["wox_ai"])
    expect(parseProviderList("openai,claude,deepseek,custom")).toEqual(["wox_ai"])
    expect(parseProviderList("")).toEqual([])
  })

  test("parses provider configuration rows", () => {
    const rows = [{ provider: "microsoft" }, { provider: "openai", apiKey: "openai-key", baseUrl: "https://example.com/v1", model: "model-a" }, { provider: "unknown" }]
    // Only no-setup providers are configured per row now; LLM rows are dropped.
    expect(parseProviderTableRows(JSON.stringify(rows))).toEqual([{ provider: "microsoft" }])
    expect(parseProviderTableRows(JSON.stringify([{ provider: "openai_compatible", apiKey: "custom-key" }]))).toEqual([])
  })
})

describe("configuration checks", () => {
  test("reports missing provider settings", () => {
    expect(getMissingConfiguration("microsoft", DEFAULT_SETTINGS)).toBeNull()
    expect(getMissingConfiguration("deepl", DEFAULT_SETTINGS)).toContain("DeepL API key")
    expect(getMissingConfiguration("wox_ai", DEFAULT_SETTINGS)).toContain("Wox AI model")
  })

  test("wox_ai needs only a Wox model selection, never an API key", () => {
    // Given 插件没有任何自己的凭据
    const settings = { ...DEFAULT_SETTINGS }
    // Then 未选择 Wox 模型时要求选择模型
    expect(getMissingConfiguration("wox_ai", settings)).toContain("Wox AI model")
    // And 选中模型后不需要插件侧的 API Key
    expect(getMissingConfiguration("wox_ai", { ...settings, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) })).toBeNull()
    expect(getMissingConfiguration("wox_ai", { ...settings, woxAiModel: "{not json" })).toContain("Wox AI model")
  })
})

describe("Wox AI model selection", () => {
  test("parses the JSON stored by selectAIModel", () => {
    expect(parseWoxAiModel("")).toBeNull()
    expect(parseWoxAiModel("not json")).toBeNull()
    expect(parseWoxAiModel(JSON.stringify({ Name: "gpt-4o-mini" }))).toBeNull()
    expect(parseWoxAiModel(JSON.stringify({ Provider: "openai" }))).toBeNull()
    expect(parseWoxAiModel(JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }))).toEqual({ Provider: "openai", ProviderAlias: "", Name: "gpt-4o-mini" })
    expect(parseWoxAiModel(JSON.stringify({ Provider: "openai", ProviderAlias: "mynewapi", Name: "gpt-4o-mini" }))).toEqual({
      Provider: "openai",
      ProviderAlias: "mynewapi",
      Name: "gpt-4o-mini"
    })
  })

  test("streams through Wox and never leaks reasoning into the translation", async () => {
    // Given Wox 本体流会先推思考内容再推正文
    const fetchSpy = jest.fn()
    const originalFetch = global.fetch
    global.fetch = fetchSpy as unknown as typeof fetch
    const calls: Array<{ model: unknown; conversations: Array<{ Role: string; Text: string }> }> = []
    const woxAiStream: WoxAiStreamer = async (model, conversations, onUpdate) => {
      calls.push({ model, conversations })
      onUpdate({ status: "streaming", text: "你好" })
      onUpdate({ status: "streaming", text: "你好世界" })
      onUpdate({ status: "finished", text: "你好世界" })
    }
    const progress: string[] = []
    // When 使用 wox_ai 翻译
    try {
      const response = await translateText(
        "wox_ai",
        {
          text: "hello world",
          direction: resolveLanguageDirection("hello world", "en", "zh"),
          settings: { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", ProviderAlias: "mynewapi", Name: "gpt-4o-mini" }) },
          woxAiStream
        },
        async text => {
          progress.push(text)
        }
      )
      // Then 结果只有译文，模型和会话按 Wox 的约定传递
      expect(response).toEqual({ translatedText: "你好世界", providerName: "Wox AI" })
      expect(progress).toEqual(["你好", "你好世界", "你好世界"])
      expect(calls).toHaveLength(1)
      expect(calls[0].model).toEqual({ Provider: "openai", ProviderAlias: "mynewapi", Name: "gpt-4o-mini" })
      expect(calls[0].conversations.map(message => message.Role)).toEqual(["system", "user"])
      expect(calls[0].conversations[1].Text).toBe("hello world")
      // And 插件自己不发任何 HTTP 请求
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
    }
  })

  test("reports a host stream error instead of returning empty text", async () => {
    const woxAiStream: WoxAiStreamer = async (_model, _conversations, onUpdate) => {
      onUpdate({ status: "error", text: "provider quota exceeded" })
    }
    await expect(
      translateText("wox_ai", {
        text: "hello",
        direction: resolveLanguageDirection("hello", "en", "zh"),
        settings: { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) },
        woxAiStream
      })
    ).rejects.toThrow("provider quota exceeded")
  })

  test("waits for the stream to finish instead of the RPC returning", async () => {
    // Given AIChatStream 的调用在流开始前就 resolve（真实 Wox 的时序）
    let emit!: (update: { status: "streaming" | "finished"; text: string }) => void
    const woxAiStream: WoxAiStreamer = async (_model, _conversations, onUpdate) => {
      emit = onUpdate
      // RPC 立即返回，数据稍后才到
    }
    const progress: string[] = []
    const pending = translateText(
      "wox_ai",
      {
        text: "hello",
        direction: resolveLanguageDirection("hello", "en", "zh"),
        settings: { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) },
        woxAiStream
      },
      async text => {
        progress.push(text)
      }
    )
    // When RPC 已经返回，但流还没结束
    await new Promise(resolve => setTimeout(resolve, 20))
    // Then 翻译仍在等待，不会因为 RPC 返回就判定「没有完成事件」
    let settled = false
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    // When 数据陆续到达并结束
    emit({ status: "streaming", text: "你好" })
    emit({ status: "finished", text: "你好世界" })
    // Then 拿到完整译文
    await expect(pending).resolves.toEqual({ translatedText: "你好世界", providerName: "Wox AI" })
    expect(progress).toEqual(["你好", "你好世界", "你好世界"])
  })

  test("times out instead of hanging when the stream goes silent", async () => {
    // Given 流一直没有完成事件
    const woxAiStream: WoxAiStreamer = async (_model, _conversations, onUpdate) => {
      onUpdate({ status: "streaming", text: "你好" })
    }
    jest.useFakeTimers()
    try {
      const pending = translateText("wox_ai", {
        text: "hello",
        direction: resolveLanguageDirection("hello", "en", "zh"),
        settings: { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) },
        woxAiStream
      })
      // Attach the rejection handler before the timer fires so the assertion
      // catches it instead of surfacing an unhandled rejection.
      const expectation = expect(pending).rejects.toThrow("stopped responding")
      // When 空闲超时被触发（下限 30s）
      await jest.advanceTimersByTimeAsync(30000)
      // Then 报超时，而不是永久挂住
      await expectation
    } finally {
      jest.useRealTimers()
    }
  })

  test("fails clearly when Wox is too old to expose the AI channel", async () => {
    await expect(
      translateText("wox_ai", {
        text: "hello",
        direction: resolveLanguageDirection("hello", "en", "zh"),
        settings: { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) }
      })
    ).rejects.toThrow("Wox 2.4.8")
  })

  test("keeps history for different Wox AI models apart", () => {
    const settings = { ...DEFAULT_SETTINGS, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) }
    const other = { ...settings, woxAiModel: JSON.stringify({ Provider: "openai", Name: "gpt-4o" }) }
    expect(translationConfigurationKey("wox_ai", settings)).not.toBe(translationConfigurationKey("wox_ai", other))
    expect(translationConfigurationKey("wox_ai", settings)).toBe(translationConfigurationKey("wox_ai", settings))
  })
})

describe("translation history", () => {
  test("parses, searches, upserts, and matches history entries", () => {
    const direction = resolveLanguageDirection("hello", "auto", "zh")
    const firstEntry = {
      sourceText: "hello",
      translatedText: "你好",
      provider: "microsoft" as const,
      providerName: "Microsoft",
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      timestamp: 1
    }
    const secondEntry = {
      ...firstEntry,
      sourceText: "world",
      translatedText: "世界",
      timestamp: 2
    }

    const entries = upsertHistoryEntry(upsertHistoryEntry([], firstEntry, 10), secondEntry, 1)
    expect(entries).toEqual([secondEntry])
    expect(searchHistoryEntries([firstEntry, secondEntry], "hell")).toEqual([firstEntry])
    expect(parseHistoryEntries(JSON.stringify([firstEntry]))).toEqual([firstEntry])
    expect(historyKeyMatches(firstEntry, "microsoft", "hello", direction)).toBe(true)
  })
})

describe("provider requests", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  test("calls Microsoft no-setup endpoint and parses response", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse([
        {
          detectedLanguage: { language: "en" },
          translations: [{ text: "你好" }]
        }
      ])
    )
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithMicrosoft({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toContain("api.cognitive.microsofttranslator.com/translate")
    expect(headersOf(init)["X-MT-Signature"]).toContain("MSTranslatorAndroidApp::")
    expect(headersOf(init).Authorization).toBeUndefined()
    expect(init.body).toBe(JSON.stringify([{ Text: "hello" }]))
    expect(result.translatedText).toBe("你好")
    expect(result.detectedSourceLanguage).toBe("en")
  })

  test("passes explicit source language to Microsoft endpoint", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse([
        {
          translations: [{ text: "world-translated" }]
        }
      ])
    )
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithMicrosoft({
      text: "world",
      direction: resolveLanguageDirection("world", "en", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url] = firstFetchCall(fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(url).toContain("from=en")
    expect(result.translatedText).toBe("world-translated")
  })

  test("calls DeepL free endpoint with auth header and target language", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ translations: [{ detected_source_language: "EN", text: "你好" }] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithDeepL({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: { ...DEFAULT_SETTINGS, deeplApiKey: "secret" }
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toBe("https://api-free.deepl.com/v2/translate")
    expect(headersOf(init).Authorization).toBe("DeepL-Auth-Key secret")
    expect(JSON.parse(init.body as string).target_lang).toBe("ZH")
    expect(result.translatedText).toBe("你好")
  })

  test("calls Youdao no-setup endpoint", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ translateResult: [[{ tgt: "你好" }]] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithYoudao({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toContain("dict.youdao.com/dicttranslate")
    expect(init.method).toBe("POST")
    expect(init.body).toBe("i=hello")
    expect(result.translatedText).toBe("你好")
  })

  test("calls Caiyun no-setup translator endpoint", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({ jwt: "jwt-token" }))
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({ target: caiyunEncrypt("你好"), rc: 0 }))
    global.fetch = fetchMock as typeof fetch

    const direction = resolveLanguageDirection("hello", "auto", "zh")
    const result = await translateWithCaiyun({
      text: "hello",
      direction,
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(url).toBe("https://api.interpreter.caiyunai.com/v1/translator")
    expect(headersOf(init)["X-Authorization"]).toContain("token:")
    expect(headersOf(init)["T-Authorization"]).toBe("jwt-token")
    const body = JSON.parse(init.body as string)
    expect(body.source).toBe("hello")
    expect(body.trans_type).toBe("auto2zh")
    expect(body.detect).toBe(true)
    expect(result.translatedText).toBe("你好")
    expect(result.providerName).toBe("Caiyun")
  })

  test("rejects unsupported Caiyun target languages", async () => {
    global.fetch = jest.fn() as typeof fetch

    await expect(
      translateWithCaiyun({
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "ja"),
        settings: DEFAULT_SETTINGS
      })
    ).rejects.toThrow("Caiyun only supports Chinese and English target languages.")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test("surfaces provider failures", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ error: "bad key" }, 403)) as typeof fetch

    await expect(
      translateWithDeepL({
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, deeplApiKey: "bad" }
      })
    ).rejects.toThrow("403")
  })
})
