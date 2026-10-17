import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { speakText } from "./speech"
import { randomUUID } from "node:crypto"
import {
  DEFAULT_SETTINGS,
  getMissingConfiguration,
  historyKeyMatches,
  IncompleteTranslationError,
  isLanguageModelProvider,
  normalizeProvider,
  parseHistoryEntries,
  parseProviderList,
  parseProviderTableRows,
  parseTranslationQuery,
  PluginSettings,
  resolveLanguageDirection,
  searchHistoryEntries,
  translateText,
  TranslationHistoryEntry,
  TranslationProvider,
  translationConfigurationKey,
  LanguageDirection,
  upsertHistoryEntry,
  LanguageCode
} from "./translate"

let api: PublicAPI
let woxLanguage: LanguageCode = "en"
let historyWrites: Promise<void> = Promise.resolve()

const HISTORY_SETTING_KEY = "translation_history"
const VISIBLE_PROVIDERS: TranslationProvider[] = ["microsoft", "youdao", "caiyun", "openai", "claude", "deepseek", "llm_custom"]

const PLUGIN_ICON: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

async function getSetting(ctx: Context, key: string, fallback: string): Promise<string> {
  try {
    const value = await api.GetSetting(ctx, key)
    return value.trim() === "" ? fallback : value.trim()
  } catch {
    return fallback
  }
}

async function loadSettings(ctx: Context): Promise<PluginSettings> {
  const timeoutRaw = await getSetting(ctx, "request_timeout_ms", String(DEFAULT_SETTINGS.requestTimeoutMs))
  const timeoutMs = Number.parseInt(timeoutRaw, 10)
  const historyLimitRaw = await getSetting(ctx, "history_limit", String(DEFAULT_SETTINGS.historyLimit))
  const historyLimit = Number.parseInt(historyLimitRaw, 10)
  const showPreviewDetails = (await getSetting(ctx, "show_preview_details", String(DEFAULT_SETTINGS.showPreviewDetails))) === "true"
  const enableSpeechPlayback = (await getSetting(ctx, "enable_speech_playback", String(DEFAULT_SETTINGS.enableSpeechPlayback))) === "true"
  const noSetupProviderTableValue = await getSetting(ctx, "no_setup_provider_table", "")
  const llmProviderTableValue = await getSetting(ctx, "llm_provider_table", "")
  const legacyProviders = parseProviderList(await getSetting(ctx, "visible_providers", ""))
  const enabled = await Promise.all(VISIBLE_PROVIDERS.map(provider => getSetting(ctx, `visible_provider_${provider}`, legacyProviders.includes(provider) ? "true" : "false")))
  const visibleProviders = VISIBLE_PROVIDERS.filter((_provider, index) => enabled[index] === "true")

  const targetLanguageRaw = await getSetting(ctx, "default_target_language", DEFAULT_SETTINGS.defaultTargetLanguage || "auto")
  const pairLanguageRaw = await getSetting(ctx, "pair_language", DEFAULT_SETTINGS.pairLanguage || "auto")

  return {
    defaultProvider: normalizeProvider(await getSetting(ctx, "default_provider", DEFAULT_SETTINGS.defaultProvider)),
    visibleProviders,
    providerRows: [...parseProviderTableRows(noSetupProviderTableValue), ...parseProviderTableRows(llmProviderTableValue)],
    defaultSourceLanguage: (await getSetting(ctx, "default_source_language", DEFAULT_SETTINGS.defaultSourceLanguage)) as LanguageCode,
    defaultTargetLanguage: normalizeLanguageCode(targetLanguageRaw) as LanguageCode,
    pairLanguage: normalizeLanguageCode(pairLanguageRaw) as LanguageCode,
    woxLanguage,
    deeplApiKey: await getSetting(ctx, "deepl_api_key", DEFAULT_SETTINGS.deeplApiKey),
    openaiBaseUrl: await getSetting(ctx, "openai_base_url", DEFAULT_SETTINGS.openaiBaseUrl),
    openaiApiKey: await getSetting(ctx, "openai_api_key", DEFAULT_SETTINGS.openaiApiKey),
    openaiModel: await getSetting(ctx, "openai_model", DEFAULT_SETTINGS.openaiModel),
    requestTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SETTINGS.requestTimeoutMs,
    showPreviewDetails,
    enableSpeechPlayback,
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? historyLimit : DEFAULT_SETTINGS.historyLimit
  }
}

function settingsForProvider(settings: PluginSettings, provider: TranslationProvider): PluginSettings {
  const row = settings.providerRows.find(item => item.provider === provider)
  const providerDefaults: Partial<Pick<PluginSettings, "openaiBaseUrl" | "openaiModel">> = {
    openaiBaseUrl:
      provider === "openai" ? "https://api.openai.com/v1" : provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "claude" ? "https://api.anthropic.com/v1" : settings.openaiBaseUrl,
    openaiModel: provider === "openai" ? "gpt-4o-mini" : provider === "deepseek" ? "deepseek-chat" : provider === "claude" ? "claude-3-5-haiku-latest" : settings.openaiModel
  }

  if (!row) {
    return { ...settings, ...providerDefaults }
  }

  return {
    ...settings,
    ...providerDefaults,
    openaiBaseUrl: row.baseUrl?.trim() || providerDefaults.openaiBaseUrl || settings.openaiBaseUrl,
    openaiApiKey: row.apiKey?.trim() || settings.openaiApiKey,
    openaiModel: row.model?.trim() || providerDefaults.openaiModel || settings.openaiModel
  }
}

const VALID_LANGUAGE_CODES = ["auto", "zh", "en", "ja", "ko", "ru", "ar", "fr", "de"]

function normalizeLanguageCode(value: string): LanguageCode {
  if (VALID_LANGUAGE_CODES.includes(value)) {
    return value as LanguageCode
  }
  return "auto"
}

function normalizeWoxLanguageProbe(value: string): LanguageCode {
  const normalized = value.trim().toLowerCase().replace("-", "_")
  if (normalized.startsWith("zh")) return "zh"
  if (normalized.startsWith("ja")) return "ja"
  if (normalized.startsWith("ko")) return "ko"
  if (normalized.startsWith("ru")) return "ru"
  if (normalized.startsWith("ar")) return "ar"
  if (normalized.startsWith("fr")) return "fr"
  if (normalized.startsWith("de")) return "de"
  return "en"
}

function providerCommand(provider: TranslationProvider): string {
  if (provider === "microsoft") return "ms"
  if (provider === "youdao") return "youdao"
  if (provider === "caiyun") return "caiyun"
  if (provider === "deepl") return "deepl"
  if (provider === "openai") return "openai"
  if (provider === "claude") return "claude"
  if (provider === "deepseek") return "deepseek"
  if (provider === "llm_custom" || provider === "openai_compatible") return "custom"
  return "ms"
}

function providerDisplayName(provider: TranslationProvider): string {
  if (provider === "microsoft") return "Microsoft"
  if (provider === "youdao") return "Youdao"
  if (provider === "caiyun") return "Caiyun"
  if (provider === "deepl") return "DeepL"
  if (provider === "openai") return "OpenAI"
  if (provider === "claude") return "Claude"
  if (provider === "deepseek") return "DeepSeek"
  return "Custom LLM"
}

async function t(ctx: Context, key: string): Promise<string> {
  try {
    const value = await api.GetTranslation(ctx, key)
    return value.trim() === "" ? key : value
  } catch {
    return key
  }
}

function desc(text: string): string {
  return text.replace(/^`[^`]+`\s*/, "")
}

async function buildHelpResult(ctx: Context): Promise<Result> {
  const cmd = await t(ctx, "help_preview_command")
  const dsc = await t(ctx, "help_preview_description")
  return {
    Title: await t(ctx, "help_title"),
    SubTitle: await t(ctx, "help_subtitle"),
    Icon: PLUGIN_ICON,
    Score: 100,
    Preview: {
      PreviewType: "markdown",
      PreviewData: [
        `# ${await t(ctx, "plugin_name")}`,
        "",
        `| ${cmd} | ${dsc} |`,
        "| --- | --- |",
        `| tr hello | ${desc(await t(ctx, "help_default_provider"))} |`,
        `| tr ms hello | ${desc(await t(ctx, "help_microsoft"))} |`,
        `| tr youdao hello | ${desc(await t(ctx, "help_youdao"))} |`,
        `| tr caiyun hello | ${desc(await t(ctx, "help_caiyun"))} |`,
        `| tr openai hello | ${desc(await t(ctx, "help_openai"))} |`,
        `| tr claude hello | ${desc(await t(ctx, "help_claude"))} |`,
        `| tr deepseek hello | ${desc(await t(ctx, "help_deepseek"))} |`,
        `| tr custom hello | ${desc(await t(ctx, "help_custom_llm"))} |`,
        `| tr history | ${desc(await t(ctx, "help_history"))} |`,
        `| tr history hello | ${desc(await t(ctx, "help_history_search"))} |`,
        "",
        `### ${await t(ctx, "preview_direction")}`,
        "",
        `| ${cmd} | ${dsc} |`,
        "| --- | --- |",
        `| tr zh hello | ${desc(await t(ctx, "help_lang_target"))} |`,
        `| tr en:zh hello | ${desc(await t(ctx, "help_lang_source_target"))} |`,
        `| tr :zh hello | ${desc(await t(ctx, "help_lang_colon_target"))} |`,
        `| tr ms zh hello | ${desc(await t(ctx, "help_provider_lang"))} |`,
        `| tr ms en:zh hello | ${desc(await t(ctx, "help_provider_source_target"))} |`
      ].join("\n"),
      PreviewProperties: {}
    }
  }
}

async function loadHistory(ctx: Context): Promise<TranslationHistoryEntry[]> {
  return parseHistoryEntries(await getSetting(ctx, HISTORY_SETTING_KEY, "[]"))
}

async function saveHistory(ctx: Context, entries: TranslationHistoryEntry[]): Promise<void> {
  await api.SaveSetting(ctx, HISTORY_SETTING_KEY, JSON.stringify(entries), false)
}

async function saveHistoryEntry(ctx: Context, entry: TranslationHistoryEntry, historyLimit: number): Promise<void> {
  // Only serialize the read/merge/write, not the network requests. Each completion must
  // merge the latest history rather than overwriting a snapshot from before translation.
  const write = historyWrites.then(async () => saveHistory(ctx, upsertHistoryEntry(await loadHistory(ctx), entry, historyLimit)))
  historyWrites = write.catch(() => undefined)
  return write
}

function buildConfigurationResult(message: string, provider: TranslationProvider): Result {
  const title = `${providerDisplayName(provider)} needs configuration`
  return {
    Title: title,
    SubTitle: message,
    Icon: PLUGIN_ICON,
    Score: 100,
    Preview: {
      PreviewType: "markdown",
      PreviewData: `# Configuration required\n\n${message}\n\nOpen Wox plugin settings and update LuxTranslate.`,
      PreviewProperties: {}
    }
  }
}

function errorMessageForProvider(error: unknown, provider: TranslationProvider): string {
  const message = error instanceof Error ? error.message : String(error)
  const suffix = provider === "microsoft" ? " The Microsoft no-setup provider uses an unofficial endpoint and may stop working." : ""
  return `${message}${suffix}`
}

async function buildResultActions(
  ctx: Context,
  translatedText: string,
  sourceText: string,
  provider: TranslationProvider,
  settings: PluginSettings,
  direction: Pick<LanguageDirection, "sourceLanguage" | "targetLanguage">
): Promise<Result["Actions"]> {
  const actions: Result["Actions"] = [
    {
      Name: await t(ctx, "action_copy_translation"),
      IsDefault: true,
      Action: async (ctx: Context) => {
        await api.Copy(ctx, { type: "text", text: translatedText })
      }
    },
    {
      Name: await t(ctx, "action_copy_source"),
      Action: async (ctx: Context) => {
        await api.Copy(ctx, { type: "text", text: sourceText })
      }
    }
  ]

  if (settings.enableSpeechPlayback) {
    actions.push({
      Name: await t(ctx, "action_play_translation"),
      Action: async (ctx: Context) => {
        try {
          await speakText(translatedText, direction.targetLanguage)
        } catch (error) {
          await api.Log(ctx, "Error", error instanceof Error ? error.stack || error.message : String(error))
        }
      }
    })
  }

  return actions.concat(await buildRetryActions(ctx, sourceText, provider, direction))
}

async function buildRetryActions(
  ctx: Context,
  sourceText: string,
  provider: TranslationProvider,
  direction: Pick<LanguageDirection, "sourceLanguage" | "targetLanguage">
): Promise<NonNullable<Result["Actions"]>> {
  // Include an explicit language spec before the body so retrying also preserves
  // literal text such as "history" or "en", regardless of the current defaults.
  const queryFor = (next: TranslationProvider, refresh = false) => `tr ${providerCommand(next)} ${refresh ? "--refresh " : ""}${direction.sourceLanguage}:${direction.targetLanguage} ${sourceText}`
  const actions: NonNullable<Result["Actions"]> = [
    {
      Name: await t(ctx, "action_retranslate"),
      ContextData: { provider },
      Action: async (ctx: Context) => {
        await api.ChangeQuery(ctx, { QueryType: "input", QueryText: queryFor(provider, true) })
      }
    }
  ]
  for (const alternate of VISIBLE_PROVIDERS) {
    if (alternate === provider) {
      continue
    }
    actions.push({
      Name: `${await t(ctx, "action_retry_with")} ${providerDisplayName(alternate)}`,
      ContextData: { provider: alternate },
      Action: async (ctx: Context, actionContext: ActionContext) => {
        const nextProvider = (actionContext.ContextData.provider || alternate) as TranslationProvider
        await api.ChangeQuery(ctx, {
          QueryType: "input",
          QueryText: queryFor(nextProvider)
        })
      }
    })
  }

  return actions
}

async function buildTranslationPreview(ctx: Context, translatedText: string, sourceText: string, providerName: string, direction: string, showDetails: boolean): Promise<string> {
  if (!showDetails) {
    return translatedText
  }

  return [
    translatedText,
    "",
    "---",
    "",
    `## ${await t(ctx, "preview_source")}`,
    sourceText,
    "",
    `## ${await t(ctx, "preview_details")}`,
    `- ${await t(ctx, "preview_provider")}: ${providerName}`,
    `- ${await t(ctx, "preview_direction")}: ${direction}`
  ].join("\n")
}

async function translateProviderResult(
  ctx: Context,
  provider: TranslationProvider,
  sourceText: string,
  settings: PluginSettings,
  score: number,
  includeProviderInTitle: boolean,
  languageOverrides?: { sourceLanguage?: LanguageCode; targetLanguage?: LanguageCode; forceRefresh?: boolean },
  query?: Query
): Promise<Result | null> {
  const providerSettings = settingsForProvider(settings, provider)

  // 用户通过 tr 指令指定的语言覆盖优先，否则走设置项
  const effectiveSource = languageOverrides?.sourceLanguage || providerSettings.defaultSourceLanguage
  const effectiveTarget = languageOverrides?.targetLanguage || (providerSettings.defaultTargetLanguage === "auto" ? providerSettings.woxLanguage || "en" : providerSettings.defaultTargetLanguage)
  const forceFixedTarget = Boolean(languageOverrides?.targetLanguage) || providerSettings.defaultTargetLanguage !== "auto"
  const pair = forceFixedTarget ? effectiveTarget : providerSettings.pairLanguage || "auto"

  let direction = resolveLanguageDirection(sourceText, effectiveSource, effectiveTarget, pair)
  const missingConfiguration = getMissingConfiguration(provider, providerSettings)
  if (missingConfiguration) {
    return { ...buildConfigurationResult(missingConfiguration, provider), Score: score, Actions: await buildRetryActions(ctx, sourceText, provider, direction) }
  }
  const configurationKey = translationConfigurationKey(provider, providerSettings)
  const history = await loadHistory(ctx)
  const directionFromDetectedLanguage = (detectedLanguage?: string): LanguageDirection | undefined => {
    if (forceFixedTarget || effectiveSource !== "auto" || !detectedLanguage) return undefined
    const detected = normalizeLanguageCode(detectedLanguage.toLowerCase().replace("_", "-").split("-")[0])
    if (detected === "auto") return undefined
    return { ...resolveLanguageDirection(sourceText, detected, effectiveTarget, pair), sourceLanguage: "auto" }
  }
  // Script heuristics cannot distinguish Chinese from Japanese written only in kanji.
  // Reuse a provider's earlier detection before choosing the cached target direction.
  const detectedHistory = history.find(
    entry => entry.provider === provider && entry.sourceText === sourceText && entry.sourceLanguage === "auto" && entry.configurationKey === configurationKey && entry.detectedSourceLanguage
  )
  direction = directionFromDetectedLanguage(detectedHistory?.detectedSourceLanguage) || direction
  const historyEntry = languageOverrides?.forceRefresh ? undefined : history.find(entry => historyKeyMatches(entry, provider, sourceText, direction, configurationKey))
  if (historyEntry) {
    return buildTranslationResult(ctx, historyEntry, sourceText, providerSettings, score, includeProviderInTitle, true)
  }

  const finishTranslation = async (onProgress?: (text: string) => Promise<void>): Promise<Result> => {
    let translation = await translateText(
      provider,
      {
        text: sourceText,
        direction,
        settings: providerSettings
      },
      onProgress
    )
    const correctedDirection = directionFromDetectedLanguage(translation.detectedSourceLanguage)
    if (correctedDirection && correctedDirection.targetLanguage !== direction.targetLanguage) {
      const detectedSourceLanguage = translation.detectedSourceLanguage
      direction = correctedDirection
      translation = {
        ...(await translateText(provider, { text: sourceText, direction, settings: providerSettings }, onProgress)),
        detectedSourceLanguage
      }
    }
    const entry: TranslationHistoryEntry = {
      sourceText,
      translatedText: translation.translatedText,
      provider,
      providerName: translation.providerName,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      detectedSourceLanguage: translation.detectedSourceLanguage,
      timestamp: Date.now(),
      configurationKey
    }
    await saveHistoryEntry(ctx, entry, providerSettings.historyLimit)
    return buildTranslationResult(ctx, entry, sourceText, providerSettings, score, includeProviderInTitle, false)
  }

  const failureResult = async (error: unknown): Promise<Result> => {
    await api.Log(ctx, "Error", error instanceof Error ? error.message : String(error))
    const message = errorMessageForProvider(error, provider)
    const title = `${providerDisplayName(provider)}: ${await t(ctx, error instanceof IncompleteTranslationError ? "translation_incomplete_title" : "translation_failed_title")}`
    return {
      Title: title,
      SubTitle: message,
      Icon: PLUGIN_ICON,
      Score: score,
      Preview: {
        PreviewType: "markdown",
        PreviewData: `${message}\n\n${error instanceof IncompleteTranslationError ? error.partialText : ""}`,
        PreviewProperties: {}
      },
      Actions: await buildRetryActions(ctx, sourceText, provider, direction)
    }
  }

  if (query && isLanguageModelProvider(provider) && typeof api.PushResults === "function") {
    const resultId = `lux-tr-${randomUUID()}`
    const placeholder: Result = {
      Id: resultId,
      Title: await t(ctx, "translating_title"),
      SubTitle: sourceText,
      Icon: PLUGIN_ICON,
      Score: score,
      Actions: [],
      Preview: { PreviewType: "markdown", PreviewData: await t(ctx, "translating_title"), PreviewProperties: {} }
    }
    // Register the placeholder before the first token; updating an unregistered ID
    // can otherwise cancel a fast stream, especially when another provider is slow.
    if (!(await api.PushResults(ctx, query, [placeholder]))) return null
    const stream = async () => {
      try {
        let lastUpdate = 0
        const result = await finishTranslation(async text => {
          if (lastUpdate !== 0 && Date.now() - lastUpdate < 80) return
          lastUpdate = Date.now()
          const visible = await api.UpdateResult(ctx, {
            Id: resultId,
            Preview: { PreviewType: "markdown", PreviewData: text, PreviewProperties: {} }
          })
          if (!visible) throw new Error("Query no longer visible")
        })
        await api.UpdateResult(ctx, { ...result, Id: resultId })
      } catch (error) {
        if (error instanceof Error && error.message === "Query no longer visible") return
        await api.UpdateResult(ctx, { ...(await failureResult(error)), Id: resultId })
      }
    }
    void stream().catch(error => api.Log(ctx, "Error", error instanceof Error ? error.message : String(error)))
    return null
  }

  try {
    return await finishTranslation()
  } catch (error) {
    return failureResult(error)
  }
}

async function buildTranslationResult(
  ctx: Context,
  entry: TranslationHistoryEntry,
  sourceText: string,
  settings: PluginSettings,
  score: number,
  includeProviderInTitle: boolean,
  fromHistory: boolean
): Promise<Result> {
  const subtitleParts = [`${await t(ctx, "subtitle_source")}: ${sourceText}`, `${entry.sourceLanguage} -> ${entry.targetLanguage}`, await t(ctx, "subtitle_enter_to_copy")]
  if (entry.detectedSourceLanguage) {
    subtitleParts.splice(1, 0, `${await t(ctx, "subtitle_detected")} ${entry.detectedSourceLanguage}`)
  }
  if (fromHistory) {
    subtitleParts.splice(1, 0, await t(ctx, "subtitle_history"))
  }

  return {
    Title: includeProviderInTitle ? `${entry.providerName}: ${entry.translatedText}` : entry.translatedText,
    SubTitle: subtitleParts.join(" | "),
    Icon: PLUGIN_ICON,
    Score: score,
    Preview: {
      PreviewType: "markdown",
      PreviewData: await buildTranslationPreview(ctx, entry.translatedText, sourceText, entry.providerName, `${entry.sourceLanguage} -> ${entry.targetLanguage}`, settings.showPreviewDetails),
      PreviewProperties: {}
    },
    Tails: [
      {
        Type: "text",
        Text: fromHistory ? await t(ctx, "subtitle_history") : providerDisplayName(entry.provider)
      }
    ],
    Actions: await buildResultActions(ctx, entry.translatedText, sourceText, entry.provider, settings, { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage })
  }
}

async function buildHistoryResults(ctx: Context, searchText: string, settings: PluginSettings): Promise<Result[]> {
  const entries = searchHistoryEntries(await loadHistory(ctx), searchText)
  if (entries.length === 0) {
    return [
      {
        Title: await t(ctx, "history_empty_title"),
        SubTitle: searchText.trim() === "" ? await t(ctx, "history_empty_subtitle") : `${await t(ctx, "history_no_match")}: ${searchText}`,
        Icon: PLUGIN_ICON,
        Score: 100
      }
    ]
  }

  return Promise.all(entries.map((entry, index) => buildTranslationResult(ctx, entry, entry.sourceText, settings, 100 - index, true, true)))
}

function parseHistoryQuery(search: string): string | null {
  const trimmed = search.trim()
  const match = /^(history|his)(?:\s+(.*))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return match[2]?.trim() ?? ""
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    historyWrites = Promise.resolve()
    // Wox 2.4.7's native select currently ignores IsMulti. Initialize independent
    // checkbox preferences from the old comma/JSON list without changing existing choices.
    const legacyProviders = parseProviderList(await getSetting(ctx, "visible_providers", ""))
    for (const provider of VISIBLE_PROVIDERS) {
      const key = `visible_provider_${provider}`
      if ((await getSetting(ctx, key, "")) === "") await api.SaveSetting(ctx, key, String(legacyProviders.includes(provider)), false)
    }
    // Detect Wox's selected UI language through plugin i18n.
    try {
      woxLanguage = normalizeWoxLanguageProbe(await api.GetTranslation(ctx, "language_probe"))
    } catch {
      woxLanguage = "en"
    }
    await api.Log(ctx, "Info", `LuxTranslate initialized, Wox language: ${woxLanguage}`)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const search = query.Type === "selection" ? query.Selection.Text : query.Search
    const settings = await loadSettings(ctx)
    const historySearch = query.Type === "selection" ? null : parseHistoryQuery(search)
    if (historySearch !== null) {
      return buildHistoryResults(ctx, historySearch, settings)
    }
    // Selection contents are literal data, even when they begin with a command alias.
    const parsed = query.Type === "selection" ? { provider: settings.defaultProvider, text: search, forcedProvider: false } : parseTranslationQuery(search, settings.defaultProvider)

    if (parsed.text === "") {
      return [await buildHelpResult(ctx)]
    }

    const providers = parsed.forcedProvider || settings.visibleProviders.length === 0 ? [parsed.provider] : settings.visibleProviders
    const results = await Promise.all(providers.map((provider, index) => translateProviderResult(ctx, provider, parsed.text, settings, 100 - index, providers.length > 1, parsed, query)))
    return results.filter((result): result is Result => result !== null)
  }
}
