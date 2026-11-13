import { createHash, createHmac, randomUUID } from "node:crypto"

export type TranslationProvider = "microsoft" | "youdao" | "caiyun" | "deepl" | "wox_ai" | "youdao_word"

export type LanguageCode = "auto" | "zh" | "en" | "ja" | "ko" | "ru" | "ar" | "fr" | "de"

/** 语言显示名称（用于 LLM prompt 和 UI） */
export const LANGUAGE_LABEL: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  ar: "Arabic",
  fr: "French",
  de: "German"
}

/** Microsoft Translator API 语言代码 */
export const LANGUAGE_MICROSOFT: Record<string, string> = {
  zh: "zh-Hans",
  en: "en",
  ja: "ja",
  ko: "ko",
  ru: "ru",
  ar: "ar",
  fr: "fr",
  de: "de"
}

/** DeepL API 语言代码 */
export const LANGUAGE_DEEPL: Record<string, string> = {
  zh: "ZH",
  en: "EN-US",
  ja: "JA",
  ko: "KO",
  ru: "RU",
  ar: "AR",
  fr: "FR",
  de: "DE"
}

export interface PluginSettings {
  defaultProvider: TranslationProvider
  visibleProviders: TranslationProvider[]
  /** 只有免配置翻译源的行；大模型统一走 Wox 本体 AI，不再单独配置 */
  providerRows: ProviderTableRow[]
  defaultSourceLanguage: LanguageCode
  defaultTargetLanguage: LanguageCode
  /** 配对语言：当源语言等于 Wox 界面语言时翻译成此语言 */
  pairLanguage: LanguageCode
  /** Wox 界面语言（由插件 init 时通过 i18n 探针检测，不需要持久化） */
  woxLanguage?: LanguageCode
  deeplApiKey: string
  /** Wox 本体 AI 模型选择：selectAIModel 保存的 {"Name","Provider","ProviderAlias"} JSON */
  woxAiModel: string
  requestTimeoutMs: number
  showPreviewDetails: boolean
  enableSpeechPlayback: boolean
  historyLimit: number
  /** 单词快速路径：翻译源是 Wox AI 时，单个单词改走词典机翻，避免等待大模型 */
  singleWordFastPath: boolean
}

export interface ParsedQuery {
  provider: TranslationProvider
  text: string
  forcedProvider: boolean
  /** 用户通过 tr 指令指定的目标语言，覆盖设置中的目标语言 */
  targetLanguage?: LanguageCode
  /** 用户通过 tr 指令指定的源语言，覆盖设置中的源语言 */
  sourceLanguage?: LanguageCode
  forceRefresh?: boolean
}

export interface LanguageDirection {
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  targetLabel: string
  microsoftTarget: string
  deeplTarget: string
}

export interface TranslationRequest {
  text: string
  direction: LanguageDirection
  settings: PluginSettings
  /** 使用 wox_ai 时必须提供：宿主转发的 Wox 本体 AI 流式调用 */
  woxAiStream?: WoxAiStreamer
}
export interface TranslationResponse {
  translatedText: string
  providerName: string
  detectedSourceLanguage?: string
  /** 词典元数据：仅单词查询走词典接口时存在 */
  dictionary?: WordDictionaryInfo
}

/** 有道词典返回的单词条目：音标、词性释义、词形变化 */
export interface WordDictionaryInfo {
  /** 英式音标，如 ˈlʌvli */
  ukPhonetic?: string
  /** 美式音标，如 ˈlʌvli */
  usPhonetic?: string
  /** 中文拼音，如 kě’ài */
  pinyin?: string
  /** 分词条目：词性 + 释义，如 "adj. 可爱的；美好的" */
  senses: string[]
  /** 词形变化，如 复数 lovelies / 比较级 lovelier */
  wordForms: Array<{ name: string; value: string }>
  /** 词典对整个查询的中文释义（查无词条时由机翻兜底） */
  fallbackTranslation?: string
}

/** Wox 本体 AI 模型，字段与 Wox selectAIModel 设置保存的 JSON 一致 */
export interface WoxAiModel {
  Provider: string
  ProviderAlias?: string
  Name: string
}

export interface WoxAiConversation {
  Role: "system" | "user"
  Text: string
  Timestamp: number
}

/** Wox 本体 AI 流式回调的单次更新：只有正文，没有思考内容 */
export interface WoxAiStreamUpdate {
  /** streaming = 正在输出；finished = 全部完成；error = 宿主报告失败 */
  status: "streaming" | "streamed" | "running_tool_call" | "finished" | "error"
  /** 累积正文（不是增量） */
  text: string
}

/**
 * 宿主注入的 Wox 本体 AI 流式调用。
 *
 * onUpdate 收到的 `text` 是累积正文。思考内容（Reasoning）不会进入这个契约：
 * 翻译只需要译文，思考过程既不显示也不参与结果字符串。
 */
export type WoxAiStreamer = (model: WoxAiModel, conversations: WoxAiConversation[], onUpdate: (update: WoxAiStreamUpdate) => void) => Promise<void>

/** 解析 selectAIModel 保存的模型 JSON；空值或残缺值视为未配置 */
export function parseWoxAiModel(value: string): WoxAiModel | null {
  if (value.trim() === "") return null
  try {
    const parsed = JSON.parse(value) as Partial<WoxAiModel> | null
    if (typeof parsed !== "object" || parsed === null) return null
    if (typeof parsed.Provider !== "string" || parsed.Provider.trim() === "") return null
    if (typeof parsed.Name !== "string" || parsed.Name.trim() === "") return null
    return {
      Provider: parsed.Provider.trim(),
      ProviderAlias: typeof parsed.ProviderAlias === "string" ? parsed.ProviderAlias.trim() : "",
      Name: parsed.Name.trim()
    }
  } catch {
    return null
  }
}

export interface TranslationHistoryEntry {
  sourceText: string
  translatedText: string
  provider: TranslationProvider
  providerName: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  detectedSourceLanguage?: string
  timestamp: number
  configurationKey?: string
  /** 词典元数据：来自单词快速路径（youdao_word），随历史一起缓存 */
  dictionary?: WordDictionaryInfo
}

export interface ProviderTableRow {
  provider?: string
  name?: string
  note?: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

const PROVIDER_ALIASES: Record<string, TranslationProvider> = {
  ms: "microsoft",
  microsoft: "microsoft",
  youdao: "youdao",
  yd: "youdao",
  caiyun: "caiyun",
  cy: "caiyun",
  deepl: "deepl",
  // 旧版本把大模型拆成 openai / claude / deepseek / custom 四个来源。
  // 现在统一走 Wox 本体 AI，旧命令保留并映射过来，避免历史习惯失效。
  openai: "wox_ai",
  claude: "wox_ai",
  anthropic: "wox_ai",
  deepseek: "wox_ai",
  custom: "wox_ai",
  llm: "wox_ai",
  llm_custom: "wox_ai",
  openai_compatible: "wox_ai",
  wox: "wox_ai",
  wox_ai: "wox_ai",
  woxai: "wox_ai",
  ai: "wox_ai",
  llm_ai: "wox_ai",
  // 单词快速路径的显式命令：把用户指到词典来源，且不会被快速路径反向替换。
  dict: "youdao_word",
  word: "youdao_word",
  youdao_word: "youdao_word"
}

const MICROSOFT_TRANSLATOR_PRIVATE_KEY = Buffer.from([
  0xa2, 0x29, 0x3a, 0x3d, 0xd0, 0xdd, 0x32, 0x73, 0x97, 0x7a, 0x64, 0xdb, 0xc2, 0xf3, 0x27, 0xf5, 0xd7, 0xbf, 0x87, 0xd9, 0x45, 0x9d, 0xf0, 0x5a, 0x09, 0x66, 0xc6, 0x30, 0xc6, 0x6a, 0xaa, 0x84, 0x9a,
  0x41, 0xaa, 0x94, 0x3a, 0xa8, 0xd5, 0x1a, 0x6e, 0x4d, 0xaa, 0xc9, 0xa3, 0x70, 0x12, 0x35, 0xc7, 0xeb, 0x12, 0xf6, 0xe8, 0x23, 0x07, 0x9e, 0x47, 0x10, 0x95, 0x91, 0x88, 0x55, 0xd8, 0x17
])
const CAIYUN_DEFAULT_TOKEN = "token:qgemv4jr1y38jyq6vhvi"
const CAIYUN_BROWSER_ID = "beba19f9d7f10c74c98334c9e8afcd34"

export const DEFAULT_SETTINGS: PluginSettings = {
  defaultProvider: "microsoft",
  visibleProviders: [],
  providerRows: [],
  defaultSourceLanguage: "auto",
  defaultTargetLanguage: "auto",
  pairLanguage: "auto",
  deeplApiKey: "",
  woxAiModel: "",
  requestTimeoutMs: 10000,
  showPreviewDetails: true,
  enableSpeechPlayback: false,
  historyLimit: 10,
  singleWordFastPath: false
}

export function normalizeProvider(value: string): TranslationProvider {
  if (isTranslationProvider(value)) {
    return value
  }
  // 旧设置里存的是 openai / claude / deepseek / llm_custom 这类大模型来源。
  return PROVIDER_ALIASES[value.trim().toLowerCase()] ?? DEFAULT_SETTINGS.defaultProvider
}

function isTranslationProvider(value: string): value is TranslationProvider {
  return value === "microsoft" || value === "youdao" || value === "caiyun" || value === "deepl" || value === "wox_ai" || value === "youdao_word"
}

export const LANGUAGE_CODES: LanguageCode[] = ["auto", "zh", "en", "ja", "ko", "ru", "ar", "fr", "de"]

export function isValidLanguageCode(value: string): value is LanguageCode {
  return LANGUAGE_CODES.includes(value as LanguageCode)
}

export function parseProviderList(value: string): TranslationProvider[] {
  const providers: TranslationProvider[] = []

  let rawValues = value.split(",")
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      rawValues = parsed.filter(item => typeof item === "string")
    }
  } catch {
    // Wox commonly stores multi-select values as a comma separated string.
  }

  for (const rawValue of rawValues) {
    const trimmed = rawValue.trim().toLowerCase()
    if (trimmed === "") {
      continue
    }
    // 归一化而不是丢弃：旧设置里的 openai / claude / deepseek / custom
    // 统一映射到 wox_ai，用户升级后不会突然失去已选来源。
    const provider = PROVIDER_ALIASES[trimmed]
    if (!provider) {
      continue
    }
    if (!providers.includes(provider)) {
      providers.push(provider)
    }
  }
  return providers
}

export function parseProviderTableRows(value: string): ProviderTableRow[] {
  if (value.trim() === "") {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    // 只有免配置来源需要逐行配置。大模型行已由 Wox 本体 AI 取代，
    // 残留的行在这里被过滤掉，不会凭空制造一个不存在的来源。
    const rows: ProviderTableRow[] = []
    for (const row of parsed as ProviderTableRow[]) {
      if (typeof row !== "object" || row === null || typeof row.provider !== "string") continue
      const provider = PROVIDER_ALIASES[row.provider.trim().toLowerCase()]
      if (!provider || provider === "wox_ai" || provider === "youdao_word") continue
      rows.push({ ...row, provider })
    }
    return rows
  } catch {
    return []
  }
}

export function parseHistoryEntries(value: string): TranslationHistoryEntry[] {
  if (value.trim() === "") {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is TranslationHistoryEntry => {
      if (typeof item !== "object" || item === null) {
        return false
      }
      const candidate = item as Partial<TranslationHistoryEntry>
      return (
        typeof candidate.sourceText === "string" &&
        typeof candidate.translatedText === "string" &&
        typeof candidate.provider === "string" &&
        typeof candidate.providerName === "string" &&
        typeof candidate.sourceLanguage === "string" &&
        typeof candidate.targetLanguage === "string" &&
        typeof candidate.timestamp === "number"
      )
    })
  } catch {
    return []
  }
}

export function historyKeyMatches(entry: TranslationHistoryEntry, provider: TranslationProvider, sourceText: string, direction: LanguageDirection, configurationKey?: string): boolean {
  return (
    entry.provider === provider &&
    entry.sourceText === sourceText &&
    entry.sourceLanguage === direction.sourceLanguage &&
    entry.targetLanguage === direction.targetLanguage &&
    entry.configurationKey === configurationKey
  )
}

function sameHistoryEntry(left: TranslationHistoryEntry, right: TranslationHistoryEntry): boolean {
  return (
    left.provider === right.provider &&
    left.sourceText === right.sourceText &&
    left.sourceLanguage === right.sourceLanguage &&
    left.targetLanguage === right.targetLanguage &&
    left.configurationKey === right.configurationKey
  )
}

export function isLanguageModelProvider(provider: TranslationProvider): boolean {
  return provider === "wox_ai"
}
export function translationConfigurationKey(provider: TranslationProvider, settings: PluginSettings): string | undefined {
  if (!isLanguageModelProvider(provider)) return undefined
  // 凭据归 Wox 管理，插件只存模型标识；模型换了就必须重译。
  return createHash("sha256")
    .update(JSON.stringify([provider, settings.woxAiModel]))
    .digest("hex")
}

export function trimHistoryEntries(entries: TranslationHistoryEntry[], historyLimit: number): TranslationHistoryEntry[] {
  return entries.slice(0, Math.max(0, historyLimit))
}

export function upsertHistoryEntry(entries: TranslationHistoryEntry[], entry: TranslationHistoryEntry, historyLimit: number): TranslationHistoryEntry[] {
  const withoutDuplicate = entries.filter(existing => !sameHistoryEntry(existing, entry))
  return trimHistoryEntries(
    [entry, ...withoutDuplicate].sort((left, right) => right.timestamp - left.timestamp),
    historyLimit
  )
}

function normalizeHistorySearchText(text: string): string {
  return text.trim().toLowerCase()
}

export function searchHistoryEntries(entries: TranslationHistoryEntry[], query: string): TranslationHistoryEntry[] {
  const normalizedQuery = normalizeHistorySearchText(query)
  if (normalizedQuery === "") {
    return entries
  }

  return entries.filter(entry => {
    const source = normalizeHistorySearchText(entry.sourceText)
    const translated = normalizeHistorySearchText(entry.translatedText)
    return source.includes(normalizedQuery) || translated.includes(normalizedQuery)
  })
}

/**
 * 判断查询文本是否是「单个单词」，用于单词快速路径。
 *
 * 规则：不含空白字符，且长度不超过分词习惯的上限 —— 空格分词的语言
 * （拉丁、西里尔、阿拉伯等）最多 30 个字符；纯汉语词汇最多 4 字，
 * 含假名/谚文的词汇放宽到 6 字（如 こんにちは）。
 * 混合文本按全部非空白字符计入，只要超限就拒绝。
 */
export function isSingleWord(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === "" || /\s/.test(trimmed)) return false

  let codePoints = 0
  let han = 0
  let kanaHangul = 0
  let hasLetterOrDigit = false
  for (const char of trimmed) {
    codePoints++
    const code = char.codePointAt(0)!
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      han++
      hasLetterOrDigit = true
    } else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
      kanaHangul++
      hasLetterOrDigit = true
    } else if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a) ||
      (code >= 0x00c0 && code <= 0x024f) ||
      (code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0030 && code <= 0x0039)
    ) {
      hasLetterOrDigit = true
    }
  }

  // 全部是标点等无字母内容时不是可查词典的“词”
  if (!hasLetterOrDigit) return false
  // 汉语词汇一般不超过四字；日语假名和韩语谚文的单词更长，放宽到六字。
  if (kanaHangul === 0 && han > 0) return codePoints <= 4
  if (kanaHangul > 0) return codePoints <= 6
  return codePoints <= 30
}

export function parseTranslationQuery(search: string, defaultProvider: TranslationProvider): ParsedQuery {
  const trimmed = search.trim()
  if (trimmed === "") {
    return { provider: defaultProvider, text: "", forcedProvider: false }
  }

  const words = trimmed.split(/\s+/)
  let idx = 0
  let provider = defaultProvider
  let forcedProvider = false
  let targetLanguage: LanguageCode | undefined
  let sourceLanguage: LanguageCode | undefined
  let forceRefresh = false

  // 1. 检查第一个单词是否是翻译源别名
  const first = words[0].toLowerCase()
  const providerAlias = PROVIDER_ALIASES[first]
  if (providerAlias) {
    provider = providerAlias
    forcedProvider = true
    idx++
  }

  if (words[idx] === "--refresh") {
    forceRefresh = true
    idx++
  }

  // 2. 检查下一个单词是否是语言规格（en:zh / :zh / zh）
  if (idx < words.length) {
    const spec = parseLanguageSpec(words[idx].toLowerCase())
    if (spec) {
      targetLanguage = spec.targetLanguage
      sourceLanguage = spec.sourceLanguage
      idx++
    }
  }

  // Only consume command tokens; splitting and joining the body destroys paragraphs and indentation.
  let textStart = 0
  for (let token = 0; token < idx; token++) {
    const match = /^[^\s]+\s*/.exec(trimmed.slice(textStart))
    textStart += match?.[0].length || 0
  }
  const text = trimmed.slice(textStart)

  return { provider, text, forcedProvider, targetLanguage, sourceLanguage, forceRefresh }
}

/** 解析语言规格指令，支持格式：zh / :zh / en:zh / auto:zh */
export function parseLanguageSpec(word: string): { targetLanguage?: LanguageCode; sourceLanguage?: LanguageCode } | null {
  // ":zh" — 仅目标语言（冒号开头）
  if (word.startsWith(":") && word.length >= 3 && word.length <= 5) {
    const lang = word.slice(1)
    if (isValidLanguageCode(lang) && lang !== "auto") {
      return { targetLanguage: lang as LanguageCode }
    }
    return null
  }

  // "en:zh" 或 "auto:zh" — 显式 source:target
  const colonParts = word.split(":")
  if (colonParts.length === 2) {
    const left = colonParts[0]
    const right = colonParts[1]
    if (left === "auto" && isValidLanguageCode(right)) {
      return { sourceLanguage: "auto", targetLanguage: right as LanguageCode }
    }
    if (isValidLanguageCode(left) && isValidLanguageCode(right)) {
      return {
        sourceLanguage: left === "auto" ? undefined : (left as LanguageCode),
        targetLanguage: right === "auto" ? undefined : (right as LanguageCode)
      }
    }
    return null
  }

  // "zh" — 裸语言代码（仅 2 字母，排除 "auto"）
  if (/^[a-z]{2}$/.test(word) && isValidLanguageCode(word) && word !== "auto") {
    return { targetLanguage: word as LanguageCode }
  }

  return null
}

type ScriptFamily = "cjk" | "kana" | "hangul" | "cyrillic" | "arabic" | "latin" | null

/** 法语特征字符 */
const FRENCH_SPECIFIC = /[çèêëàâîïôùûœÇÈÊËÀÂÎÏÔÙÛŒ]/

/** 德语特征字符 */
const GERMAN_SPECIFIC = /[ßüöäÜÖÄ]/

function detectScriptFamily(text: string): ScriptFamily {
  let cjk = 0,
    latin = 0,
    cyrillic = 0,
    hangul = 0,
    kana = 0,
    arabic = 0,
    total = 0

  for (const char of text) {
    if (/\s/.test(char)) continue
    const code = char.codePointAt(0)!
    total++
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk++
    } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      kana++
    } else if (code >= 0xac00 && code <= 0xd7af) {
      hangul++
    } else if (code >= 0x0400 && code <= 0x04ff) {
      cyrillic++
    } else if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) {
      arabic++
    } else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) {
      latin++
    }
  }

  if (total === 0) return null
  if (kana > 0 && (kana + cjk) / total > 0.3) return "kana"
  if (hangul / total > 0.3) return "hangul"
  if (cjk / total > 0.3) return "cjk"
  if (arabic / total > 0.3) return "arabic"
  if (cyrillic / total > 0.3) return "cyrillic"
  if (latin / total > 0.5) return "latin"
  return null
}

/** 检测文本的 8 大语言 */
export function detectLanguage(text: string): LanguageCode {
  const script = detectScriptFamily(text)

  if (script === "kana") return "ja"
  if (script === "hangul") return "ko"
  if (script === "cjk") return "zh"
  if (script === "arabic") return "ar"
  if (script === "cyrillic") return "ru"

  if (script === "latin") {
    if (GERMAN_SPECIFIC.test(text)) return "de"
    if (FRENCH_SPECIFIC.test(text)) return "fr"
    return "en"
  }

  return "en"
}

function resolvePairLanguage(woxLanguage: LanguageCode, pairLanguage: LanguageCode): LanguageCode {
  if (pairLanguage !== "auto") {
    return pairLanguage
  }
  return woxLanguage === "zh" ? "en" : "zh"
}

export function resolveLanguageDirection(text: string, sourceLanguage: LanguageCode = "auto", woxLanguage: LanguageCode = "en", pairLanguage: LanguageCode = "auto"): LanguageDirection {
  const detected = detectLanguage(text)
  const source = sourceLanguage === "auto" ? detected : sourceLanguage

  // 智能目标：源 != Wox 界面语言 -> Wox 界面语言；源 == Wox 界面语言 -> 配对语言。
  const target = source === woxLanguage ? resolvePairLanguage(woxLanguage, pairLanguage) : woxLanguage

  return {
    sourceLanguage: sourceLanguage === "auto" ? "auto" : source,
    targetLanguage: target,
    targetLabel: LANGUAGE_LABEL[target] || "English",
    microsoftTarget: LANGUAGE_MICROSOFT[target] || target,
    deeplTarget: LANGUAGE_DEEPL[target] || target.toUpperCase()
  }
}

export function getMissingConfiguration(provider: TranslationProvider, settings: PluginSettings): string | null {
  if (provider === "deepl" && settings.deeplApiKey.trim() === "") {
    return "DeepL API key is required for DeepL translation."
  }
  if (provider === "wox_ai" && parseWoxAiModel(settings.woxAiModel) === null) {
    return "Select a Wox AI model in the plugin settings. Wox already holds the provider credentials."
  }
  return null
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`)
  let timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.body) {
      clearTimeout(timeout)
      return response
    }

    // fetch resolves at the response headers. Keep the deadline until the body finishes,
    // and reset it on each chunk so an active LLM stream can take longer than one interval.
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller.signal.addEventListener(
          "abort",
          () => {
            stream.error(timeoutError)
            void reader.cancel(timeoutError).catch(() => undefined)
          },
          { once: true }
        )
      },
      async pull(stream) {
        try {
          const chunk = await reader.read()
          clearTimeout(timeout)
          if (chunk.done) {
            reader.releaseLock()
            stream.close()
          } else {
            stream.enqueue(chunk.value)
            timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs)
          }
        } catch (error) {
          clearTimeout(timeout)
          stream.error(controller.signal.aborted ? timeoutError : error)
        }
      },
      async cancel(reason) {
        clearTimeout(timeout)
        await reader.cancel(reason).catch(() => undefined)
      }
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    clearTimeout(timeout)
    throw controller.signal.aborted ? timeoutError : error
  }
}

async function parseJsonResponse(response: Response, providerName: string): Promise<unknown> {
  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(`${providerName} request failed with ${response.status}: ${bodyText}`)
  }
  try {
    return JSON.parse(bodyText) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${providerName} returned invalid JSON: ${message}`)
  }
}

function requireString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(errorMessage)
  }
  return value
}

function strictUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function microsoftSignature(url: string): string {
  const guid = randomUUID().replace(/-/g, "")
  const escapedUrl = strictUriEncode(url)
  const dateTime = new Date().toUTCString()
  const bytes = `MSTranslatorAndroidApp${escapedUrl}${dateTime}${guid}`.toLowerCase()
  const signature = createHmac("sha256", MICROSOFT_TRANSLATOR_PRIVATE_KEY).update(bytes, "utf8").digest("base64")
  return `MSTranslatorAndroidApp::${signature}::${dateTime}::${guid}`
}

async function requestMicrosoftTranslation(request: TranslationRequest): Promise<Response> {
  let url = `api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(request.direction.microsoftTarget)}`
  if (request.direction.sourceLanguage !== "auto") {
    url += `&from=${encodeURIComponent(LANGUAGE_MICROSOFT[request.direction.sourceLanguage] || request.direction.sourceLanguage)}`
  }

  return fetchWithTimeout(
    `https://${url}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MT-Signature": microsoftSignature(url)
      },
      body: JSON.stringify([{ Text: request.text }])
    },
    request.settings.requestTimeoutMs
  )
}

export async function translateWithMicrosoft(request: TranslationRequest): Promise<TranslationResponse> {
  const response = await requestMicrosoftTranslation(request)
  const json = (await parseJsonResponse(response, "Microsoft")) as Array<{
    detectedLanguage?: { language?: string }
    translations?: Array<{ text?: string }>
  }>
  const translatedText = requireString(json[0]?.translations?.[0]?.text, "Microsoft returned an empty translation.")

  return {
    translatedText,
    providerName: "Microsoft",
    detectedSourceLanguage: json[0]?.detectedLanguage?.language
  }
}

export async function translateWithDeepL(request: TranslationRequest): Promise<TranslationResponse> {
  const endpoint = "https://api-free.deepl.com/v2/translate"
  const body: Record<string, unknown> = {
    text: [request.text],
    target_lang: request.direction.deeplTarget
  }
  if (request.direction.sourceLanguage !== "auto") {
    body.source_lang = request.direction.sourceLanguage.toUpperCase()
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${request.settings.deeplApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "DeepL")) as {
    translations?: Array<{ detected_source_language?: string; text?: string }>
  }
  const translatedText = requireString(json.translations?.[0]?.text, "DeepL returned an empty translation.")

  return {
    translatedText,
    providerName: "DeepL",
    detectedSourceLanguage: json.translations?.[0]?.detected_source_language
  }
}

export async function translateWithYoudao(request: TranslationRequest): Promise<TranslationResponse> {
  const mysticTime = String(Date.now())
  const client = "deskdict"
  const product = "deskdict"
  const sign = createHash("md5").update(`client=${client}&mysticTime=${mysticTime}&product=${product}&key=cybibtzhdwayqjmrncst`, "utf8").digest("hex")
  const from = request.direction.sourceLanguage === "auto" ? "auto" : request.direction.sourceLanguage === "zh" ? "zh-CHS" : request.direction.sourceLanguage
  const to = request.direction.targetLanguage === "zh" ? "zh-CHS" : request.direction.targetLanguage
  const body = new URLSearchParams({ i: request.text })
  const params = new URLSearchParams({
    keyfrom: "deskdict.main",
    client,
    from,
    to,
    keyid: "deskdict",
    mysticTime,
    pointParam: "client,product,mysticTime",
    sign,
    domain: "0",
    useTerm: "false",
    noCheckPrivate: "false",
    recTerms: "[]",
    id: "0a464aedddbc6e4b9",
    vendor: "fanyiweb_navigation",
    in: "YoudaoDict_fanyiweb_navigation",
    appVer: "11.2.0.0",
    appZengqiang: "0",
    abTest: "0",
    model: "LENOVO",
    screen: "1920*1080",
    OsVersion: "10.0.19045",
    network: "none",
    mid: "windows10.0.19045",
    appVersion: "11.2.0.0",
    product,
    source: "mine_transtab_realtime"
  })
  const response = await fetchWithTimeout(
    `https://dict.youdao.com/dicttranslate?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Youdao Desktop Dict (Windows NT 10.0)",
        Cookie: "DESKDICT_VENDOR=unknown"
      },
      body: body.toString()
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Youdao")) as {
    translateResult?: Array<Array<{ tgt?: string }>>
  }
  const translatedText = requireString(
    json.translateResult
      ?.map(row => row.map(item => item.tgt || "").join(""))
      .join("")
      .trim(),
    "Youdao returned an empty translation."
  )

  return {
    translatedText,
    providerName: "Youdao"
  }
}

interface YoudaoWordTrsEntry {
  tr?: Array<{ l?: { i?: unknown } }>
}

interface YoudaoWordEntry {
  ukphone?: unknown
  usphone?: unknown
  trs?: YoudaoWordTrsEntry[]
  wfs?: Array<{ wf?: { name?: unknown; value?: unknown } }>
}

interface YoudaoNewhhEntry {
  dataList?: Array<{
    pinyin?: unknown
    cat?: unknown
    sense?: Array<{ def?: unknown; cat?: unknown }>
  }>
}

function youdaoString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * 从 ec（英汉词典）词条抽取「词性 + 释义」。tr.l.i 可能是字符串数组
 * （每个元素一个义项）或单个字符串，两种形状都要兼容。
 */
function youdaoEcSenses(entry: YoudaoWordEntry): string[] {
  const senses: string[] = []
  for (const trsEntry of entry.trs || []) {
    for (const tr of trsEntry.tr || []) {
      const items = tr.l?.i
      if (typeof items === "string") {
        if (items.trim() !== "") senses.push(items.trim())
      } else if (Array.isArray(items)) {
        for (const item of items) {
          const sense = youdaoString(item)
          if (sense !== "") senses.push(sense)
        }
      }
    }
  }
  return senses
}

/** 从 newhh（现代汉语规范词典）词条抽取「词性. 释义」行 */
function youdaoNewhhSenses(entry: NonNullable<YoudaoNewhhEntry["dataList"]>[number]): string[] {
  const senses: string[] = []
  const category = youdaoString(entry.cat)
  for (const sense of entry.sense || []) {
    const defs = sense.def
    const defText = Array.isArray(defs)
      ? defs
          .map(item => youdaoString(item))
          .filter(item => item !== "")
          .join("；")
      : youdaoString(defs)
    if (defText === "") continue
    const senseCategory = youdaoString(sense.cat) || category
    senses.push(senseCategory === "" ? defText : `${senseCategory}. ${defText}`)
  }
  return senses
}

/**
 * 查询有道词典接口（jsonapi_s），返回单词的音标、词性释义和词形变化。
 *
 * 该接口与 translateWithYoudao 使用的 dicttranslate 不同：它是词典查询，
 * 不做整句机翻。英文源词主要用 ec 词典（tr/wfs），中文源词用 newhh
 * （拼音/词性/释义）加 web_trans 的第一个网络释义作为目标语言对应词。
 * 查无词条时抛错，由上层决定是否回退到普通机翻。
 */
export async function fetchYoudaoWordInfo(request: TranslationRequest): Promise<TranslationResponse> {
  const sourceIsChinese = request.direction.sourceLanguage === "zh"
  const body = new URLSearchParams({
    q: request.text,
    type: "1",
    client: "deskdict",
    keyfrom: "deskdict",
    le: sourceIsChinese ? "zh" : "eng",
    includeSenses: "true",
    includeTrans: "true",
    includeDict: "true",
    includeExample: "true",
    tvs: "2000",
    verify: "des",
    time: String(Date.now())
  })
  const response = await fetchWithTimeout(
    "https://dict.youdao.com/jsonapi_s",
    {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Youdao Desktop Dict (Windows NT 10.0)",
        Cookie: "DESKDICT_VENDOR=unknown"
      },
      body: body.toString()
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Youdao Dict")) as {
    ec?: { word?: YoudaoWordEntry[] }
    newhh?: YoudaoNewhhEntry
    web_trans?: { "web-translation"?: Array<{ trans?: Array<{ value?: unknown }> }> }
    input?: unknown
  }

  // 有道对查不到的词返回 200 + 空 input，先把这种情况挡住。
  const inputText = youdaoString((json.input as { input?: unknown } | undefined)?.input ?? json.input)
  if (inputText === "" && !json.ec && !json.newhh) {
    throw new Error("Youdao Dict found no entry for this word.")
  }

  const wordEntry = json.ec?.word?.[0]
  const newhhEntry = json.newhh?.dataList?.[0]
  const webTranslations = json.web_trans?.["web-translation"]
  const senses = wordEntry ? youdaoEcSenses(wordEntry) : newhhEntry ? youdaoNewhhSenses(newhhEntry) : []
  if (senses.length === 0) {
    throw new Error("Youdao Dict found no entry for this word.")
  }

  const wordForms: Array<{ name: string; value: string }> = []
  for (const wf of wordEntry?.wfs || []) {
    const name = youdaoString(wf.wf?.name)
    const value = youdaoString(wf.wf?.value)
    if (name !== "" && value !== "") wordForms.push({ name, value })
  }

  const dictionary: WordDictionaryInfo = {
    senses,
    wordForms,
    ...(wordEntry ? { ukPhonetic: youdaoString(wordEntry.ukphone), usPhonetic: youdaoString(wordEntry.usphone) } : {}),
    ...(newhhEntry?.pinyin ? { pinyin: youdaoString(newhhEntry.pinyin) } : {}),
    // 中文源词没有整句译文，用第一个网络释义充当目标语言对应词。
    ...(sourceIsChinese ? { fallbackTranslation: youdaoString(webTranslations?.[0]?.trans?.[0]?.value) } : {})
  }

  // 译文取分词条目的第一行，去掉「词性. 」前缀后作为主结果展示。
  const primarySense = senses[0]
  const translatedText = primarySense.replace(/^[a-zA-Z.\s&]+\.\s*/, "").trim() || primarySense

  return {
    translatedText,
    providerName: "Youdao Dict",
    dictionary
  }
}

function caiyunTranslationType(direction: LanguageDirection): string {
  // 彩云只支持中英双向
  if (direction.targetLanguage === "zh") return direction.sourceLanguage === "en" ? "en2zh" : "auto2zh"
  return direction.sourceLanguage === "zh" ? "zh2en" : "auto2en"
}

function caiyunCrypt(ifDecrypt = true): Record<string, string> {
  const normalKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=.+-_/"
  const cipherKey = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm0123456789=.+-_/"
  const source = ifDecrypt ? cipherKey : normalKey
  const target = ifDecrypt ? normalKey : cipherKey
  const map: Record<string, string> = {}
  for (let i = 0; i < source.length; i++) {
    map[source[i]] = target[i]
  }
  return map
}

function caiyunDecrypt(cipherText: string): string {
  const map = caiyunCrypt(true)
  const normalized = cipherText
    .split("")
    .map(char => map[char] ?? char)
    .join("")
  return Buffer.from(normalized, "base64").toString("utf8")
}

const CAIYUN_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "App-Name": "xy",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "Device-Id": "",
  Origin: "https://fanyi.caiyunapp.com",
  "Os-Type": "web",
  "Os-Version": "",
  Pragma: "no-cache",
  Referer: "https://fanyi.caiyunapp.com/",
  "X-Authorization": CAIYUN_DEFAULT_TOKEN
}

async function getCaiyunJwt(request: TranslationRequest): Promise<string> {
  const body = JSON.stringify({ browser_id: CAIYUN_BROWSER_ID })
  await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/user/jwt/generate",
    {
      method: "OPTIONS",
      headers: CAIYUN_HEADERS,
      body
    },
    request.settings.requestTimeoutMs
  )
  const response = await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/user/jwt/generate",
    {
      method: "POST",
      headers: CAIYUN_HEADERS,
      body
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Caiyun JWT")) as { jwt?: string }
  return requireString(json.jwt, "Caiyun returned an empty JWT.")
}

export async function translateWithCaiyun(request: TranslationRequest): Promise<TranslationResponse> {
  if (!["zh", "en"].includes(request.direction.targetLanguage)) {
    throw new Error("Caiyun only supports Chinese and English target languages.")
  }

  const transType = caiyunTranslationType(request.direction)
  const jwt = await getCaiyunJwt(request)
  const headers = {
    ...CAIYUN_HEADERS,
    "T-Authorization": jwt
  }
  const body = JSON.stringify({
    source: request.text,
    trans_type: transType,
    request_id: "web_fanyi",
    media: "text",
    os_type: "web",
    dict: true,
    cached: true,
    replaced: true,
    detect: true,
    browser_id: CAIYUN_BROWSER_ID
  })
  await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/translator",
    {
      method: "OPTIONS",
      headers,
      body
    },
    request.settings.requestTimeoutMs
  )
  const response = await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/translator",
    {
      method: "POST",
      headers,
      body
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Caiyun")) as {
    target?: string
    rc?: number
  }
  const translatedText = requireString(json.target ? caiyunDecrypt(json.target) : "", "Caiyun returned an empty translation.")

  return {
    translatedText,
    providerName: "Caiyun"
  }
}

interface TranslationPromptMessage {
  Role: "system" | "user"
  Text: string
  Timestamp: number
}

function buildTranslationPrompt(text: string, targetLabel: string): TranslationPromptMessage[] {
  const now = Date.now()
  return [
    {
      Role: "system",
      Text: `Translate the user's text into ${targetLabel}. Return only the translation. Preserve code blocks, URLs, numbers, proper nouns, and the original line breaks and paragraph structure when appropriate. Multiple consecutive blank lines in the source should become a single line break in the translation. Do not add explanations.`,
      Timestamp: now
    },
    {
      Role: "user",
      Text: text,
      Timestamp: now
    }
  ]
}

export function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n")
}

export class IncompleteTranslationError extends Error {
  constructor(
    message: string,
    readonly partialText: string
  ) {
    super(message)
    this.name = "IncompleteTranslationError"
    Object.setPrototypeOf(this, IncompleteTranslationError.prototype)
  }
}

export type TranslationProgress = (text: string) => Promise<void>

async function translateWithWoxAiStream(request: TranslationRequest, onProgress: TranslationProgress): Promise<TranslationResponse> {
  const providerName = "Wox AI"
  const model = parseWoxAiModel(request.settings.woxAiModel)
  if (!model) throw new Error(`${providerName}: no model selected. Pick one in the plugin settings.`)
  const stream = request.woxAiStream
  if (!stream) {
    throw new Error(`${providerName} needs Wox 2.4.8 or newer. Update Wox or choose another provider.`)
  }

  const prompt = buildTranslationPrompt(request.text, request.direction.targetLabel)
  const state = { text: "", error: null as Error | null, finished: false }
  // onUpdate 是同步回调，而 onProgress 需要按 token 顺序落地。把更新串成一条
  // promise 链，既保证顺序，也不让 UI 更新阻塞模型输出。
  let updates: Promise<void> = Promise.resolve()

  // AIChatStream 的 RPC 在流开始前就返回：core 用 goroutine 跑 runChatLoop，
  // 只有这条 promise 才代表「整段输出结束」。不能拿它的 resolve 当完成信号。
  let settle!: () => void
  let fail!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // 先挂一个 catch，避免失败路径在 await 之前成为未处理的 rejection。
  done.catch(() => undefined)

  // 流可能因为网络或宿主问题悄悄停掉。每次收到数据就重置，长时间没动静才判超时，
  // 这样慢模型的首个 token 不会被误杀。
  const idleTimeoutMs = Math.max(request.settings.requestTimeoutMs, 30000)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (state.finished || state.error) return
      const error = new Error(`${providerName} stopped responding after ${idleTimeoutMs}ms.`)
      state.error = error
      fail(error)
    }, idleTimeoutMs)
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  resetIdle()

  const onUpdate = (update: WoxAiStreamUpdate) => {
    // Wox 的 Data 是累积正文。Reasoning 被有意丢弃：翻译只显示译文。
    if (update.status === "error") {
      clearIdle()
      state.error = new Error(update.text.trim() || `${providerName} returned a stream error.`)
      fail(state.error)
      return
    }
    resetIdle()
    const text = typeof update.text === "string" ? update.text : ""
    if (text !== "" && text !== state.text) {
      state.text = text
      updates = updates.then(() => onProgress(text)).catch(() => undefined)
    }
    if (update.status === "finished") {
      clearIdle()
      state.finished = true
      settle()
    }
  }

  try {
    await stream(
      model,
      prompt.map(message => ({ Role: message.Role, Text: message.Text, Timestamp: message.Timestamp })),
      onUpdate
    )
    // 等流结束，而不是等 RPC 返回。
    await done
    await updates
  } finally {
    clearIdle()
  }

  if (state.error) throw state.error
  if (!state.finished) throw new IncompleteTranslationError("Translation incomplete: the Wox AI stream ended without a completion event.", state.text)
  const translatedText = requireString(state.text, `${providerName} returned an empty translation.`)
  await onProgress(translatedText)
  return { translatedText, providerName }
}

export async function translateText(provider: TranslationProvider, request: TranslationRequest, onProgress?: TranslationProgress): Promise<TranslationResponse> {
  // Wox AI 只有流式接口；没有进度回调时用空实现跑同一条流，保证行为一致。
  if (provider === "wox_ai") return translateWithWoxAiStream(request, onProgress ?? (async () => undefined))
  if (provider === "youdao_word") return fetchYoudaoWordInfo(request)
  if (provider === "microsoft") {
    return translateWithMicrosoft(request)
  }
  if (provider === "youdao") {
    return translateWithYoudao(request)
  }
  if (provider === "caiyun") {
    return translateWithCaiyun(request)
  }
  return translateWithDeepL(request)
}
