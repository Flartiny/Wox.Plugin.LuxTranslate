import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { speakText } from "./speech"
import { randomUUID } from "node:crypto"
import {
  collapseExtraBlankLines,
  DEFAULT_SETTINGS,
  getMissingConfiguration,
  historyKeyMatches,
  IncompleteTranslationError,
  isLanguageModelProvider,
  isSingleWord,
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
  LanguageCode,
  WoxAiModel,
  WoxAiStreamUpdate,
  WoxAiConversation,
  WoxAiStreamer
} from "./translate"

let api: PublicAPI
let woxLanguage: LanguageCode = "en"
let historyWrites: Promise<void> = Promise.resolve()
let providerWrites: Promise<void> = Promise.resolve()
let lastProviderSelection = ""
let providerRefinementId = "translation_providers"

const HISTORY_SETTING_KEY = "translation_history"
const PROVIDERS_SETTING_KEY = "visible_providers"
const PROVIDERS_MIGRATED_KEY = "visible_providers_migrated"
// DeepL stays out of the picker: it has no settings row, so selecting it would
// only ever produce a "needs configuration" result.
const VISIBLE_PROVIDERS: TranslationProvider[] = ["microsoft", "youdao", "caiyun", "wox_ai"]

// The bundled SDK predates QueryResponse. Keep the supported Wox >= 2.0.4
// wire fields typed here without adding a runtime dependency or changing the host.
type TranslationQuery = Query & { Refinements?: Record<string, string> }
interface ProviderRefinement {
  Id: string
  Title: string
  Type: "multiSelect"
  Options: Array<{ Value: string; Title: string }>
  DefaultValue: string[]
  Hotkey: string
}
interface TranslationQueryResponse {
  Results: Result[]
  Refinements: ProviderRefinement[]
}

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

function visibleProviderList(value: string): TranslationProvider[] {
  return parseProviderList(value).filter(provider => VISIBLE_PROVIDERS.includes(provider))
}

// The pre-0.2.0 settings page had one switch per provider, including the four
// separate LLM providers. All four now collapse into wox_ai, so any of them
// being on must keep the user on a large model instead of dropping the choice.
const LEGACY_LLM_SWITCHES = ["openai", "claude", "deepseek", "llm_custom"]

async function migrateVisibleProviders(ctx: Context): Promise<void> {
  if ((await getSetting(ctx, PROVIDERS_MIGRATED_KEY, "")) === "true") return
  const legacy = visibleProviderList(await getSetting(ctx, PROVIDERS_SETTING_KEY, ""))
  const enabled = await Promise.all(VISIBLE_PROVIDERS.map(provider => getSetting(ctx, `visible_provider_${provider}`, legacy.includes(provider) ? "true" : "false")))
  const providers = VISIBLE_PROVIDERS.filter((_provider, index) => enabled[index] === "true")
  const legacyLlmEnabled = await Promise.all(LEGACY_LLM_SWITCHES.map(provider => getSetting(ctx, `visible_provider_${provider}`, "false")))
  if (legacyLlmEnabled.some(value => value === "true") && !providers.includes("wox_ai")) {
    providers.push("wox_ai")
  }
  await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, providers.join(","), false)
  // Empty is a valid selection; remember migration separately so old switches
  // cannot restore cleared choices on the next startup.
  await api.SaveSetting(ctx, PROVIDERS_MIGRATED_KEY, "true", false)
}

async function saveVisibleProviders(ctx: Context, providers: TranslationProvider[]): Promise<void> {
  const write = providerWrites.then(async () => {
    const value = providers.join(",")
    await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, value, false)
    lastProviderSelection = value
    providerRefinementId = "translation_providers_" + randomUUID()
  })
  providerWrites = write.catch(() => undefined)
  await write
}

async function resolveVisibleProviders(ctx: Context, refinements?: Record<string, string>): Promise<{ providers: TranslationProvider[]; refinementId: string }> {
  // Serialize reads and writes together so rapid filter queries observe the
  // preceding save instead of mistaking it for an edit from the settings page.
  const update = providerWrites.then(async () => {
    const stored = await api.GetSetting(ctx, PROVIDERS_SETTING_KEY)
    if (stored !== lastProviderSelection) {
      // Wox retains query values by refinement ID. A new ID discards stale
      // filters and lets the host apply the settings page's updated selection.
      providerRefinementId = "translation_providers_" + randomUUID()
      lastProviderSelection = stored
    }
    let providers = visibleProviderList(stored)
    const selected = refinements?.[providerRefinementId]
    if (typeof selected === "string") {
      const next = visibleProviderList(selected)
      if (next.length || selected.trim() === "") {
        const value = next.join(",")
        if (value !== stored) await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, value, false)
        lastProviderSelection = value
        providers = next
      }
    }
    return { providers, refinementId: providerRefinementId }
  })
  providerWrites = update.then(
    () => undefined,
    () => undefined
  )
  return update
}

async function loadSettings(ctx: Context): Promise<PluginSettings> {
  await providerWrites
  const timeoutRaw = await getSetting(ctx, "request_timeout_ms", String(DEFAULT_SETTINGS.requestTimeoutMs))
  const timeoutMs = Number.parseInt(timeoutRaw, 10)
  const historyLimitRaw = await getSetting(ctx, "history_limit", String(DEFAULT_SETTINGS.historyLimit))
  const historyLimit = Number.parseInt(historyLimitRaw, 10)
  const showPreviewDetails = (await getSetting(ctx, "show_preview_details", String(DEFAULT_SETTINGS.showPreviewDetails))) === "true"
  const enableSpeechPlayback = (await getSetting(ctx, "enable_speech_playback", String(DEFAULT_SETTINGS.enableSpeechPlayback))) === "true"
  const noSetupProviderTableValue = await getSetting(ctx, "no_setup_provider_table", "")
  const visibleProviders = visibleProviderList(await getSetting(ctx, PROVIDERS_SETTING_KEY, ""))

  const targetLanguageRaw = await getSetting(ctx, "default_target_language", DEFAULT_SETTINGS.defaultTargetLanguage || "auto")
  const pairLanguageRaw = await getSetting(ctx, "pair_language", DEFAULT_SETTINGS.pairLanguage || "auto")

  return {
    defaultProvider: normalizeProvider(await getSetting(ctx, "default_provider", DEFAULT_SETTINGS.defaultProvider)),
    visibleProviders,
    providerRows: parseProviderTableRows(noSetupProviderTableValue),
    defaultSourceLanguage: (await getSetting(ctx, "default_source_language", DEFAULT_SETTINGS.defaultSourceLanguage)) as LanguageCode,
    defaultTargetLanguage: normalizeLanguageCode(targetLanguageRaw) as LanguageCode,
    pairLanguage: normalizeLanguageCode(pairLanguageRaw) as LanguageCode,
    woxLanguage,
    deeplApiKey: await getSetting(ctx, "deepl_api_key", DEFAULT_SETTINGS.deeplApiKey),
    woxAiModel: await getSetting(ctx, "wox_ai_model", DEFAULT_SETTINGS.woxAiModel),
    requestTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SETTINGS.requestTimeoutMs,
    showPreviewDetails,
    enableSpeechPlayback,
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? historyLimit : DEFAULT_SETTINGS.historyLimit,
    singleWordFastPath: (await getSetting(ctx, "single_word_fast_path", String(DEFAULT_SETTINGS.singleWordFastPath))) === "true"
  }
}

// AIChatStream arrived in Wox 2.4.8 / SDK 0.0.143; the bundled SDK only types
// LLMStream. Declare the wire shape here so the plugin works on both.
interface WoxAiChatStreamData {
  Status: WoxAiStreamUpdate["status"]
  Data: string
  Reasoning?: string
}
type WoxAiChatStream = (ctx: Context, model: WoxAiModel, conversations: WoxAiConversation[], options: Record<string, never>, callback: (data: WoxAiChatStreamData) => void) => Promise<void>

function woxAiStreamer(ctx: Context): WoxAiStreamer | undefined {
  const candidate = (api as unknown as { AIChatStream?: WoxAiChatStream }).AIChatStream
  if (typeof candidate !== "function") return undefined
  return async (model, conversations, onUpdate) => {
    // Call through `api`: the host implementation keeps its stream callbacks on
    // `this`. Detaching the method drops `this` and it throws on llmStreamCallbacks.
    await candidate.call(api, ctx, model, conversations, {}, data => {
      // Reasoning is deliberately dropped: translation only shows the answer.
      onUpdate({ status: data.Status, text: data.Data })
    })
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
  if (provider === "wox_ai") return "wox"
  if (provider === "youdao_word") return "dict"
  return "ms"
}

function providerDisplayName(provider: TranslationProvider): string {
  if (provider === "microsoft") return "Microsoft"
  if (provider === "youdao") return "Youdao"
  if (provider === "caiyun") return "Caiyun"
  if (provider === "deepl") return "DeepL"
  if (provider === "youdao_word") return "Youdao Dict"
  return "Wox AI"
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** i18n key for a provider's display label, shared by the filter and the help table. */
function providerLabelKey(provider: TranslationProvider): string {
  if (provider === "microsoft") return "provider_microsoft"
  if (provider === "youdao") return "provider_youdao"
  if (provider === "caiyun") return "provider_caiyun"
  if (provider === "deepl") return "provider_deepl"
  if (provider === "youdao_word") return "provider_youdao_word"
  return "provider_wox_ai"
}

async function buildProviderRefinement(ctx: Context, settings: PluginSettings, refinementId: string): Promise<ProviderRefinement> {
  return {
    Id: refinementId,
    Title: await t(ctx, "refinement_provider_title"),
    Type: "multiSelect",
    // Look the label up per provider so the two lists cannot drift apart.
    Options: await Promise.all(VISIBLE_PROVIDERS.map(async provider => ({ Value: provider, Title: await t(ctx, providerLabelKey(provider)) }))),
    DefaultValue: settings.visibleProviders,
    Hotkey: ""
  }
}

async function buildDefaultProviderAction(ctx: Context, queryText = "tr "): Promise<NonNullable<Result["Actions"]>[number]> {
  return {
    Name: await t(ctx, "action_use_default_provider"),
    PreventHideAfterAction: true,
    Action: async (ctx: Context) => {
      await saveVisibleProviders(ctx, [])
      // Replacing the query also clears the host's old refinement map. An empty
      // multi-select otherwise reuses its defaults in Wox 2.4.7.
      await api.ChangeQuery(ctx, { QueryType: "input", QueryText: queryText })
    }
  }
}

async function buildHelpResult(ctx: Context, settings: PluginSettings): Promise<Result> {
  const cmd = await t(ctx, "help_preview_command")
  const dsc = await t(ctx, "help_preview_description")
  return {
    Title: await t(ctx, "help_title"),
    SubTitle: `${await t(ctx, "help_provider_selection")} · ${await t(ctx, "selected_providers")}: ${(settings.visibleProviders.length ? settings.visibleProviders : [settings.defaultProvider]).map(providerDisplayName).join(", ")}`,
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
        `| tr wox hello | ${desc(await t(ctx, "help_wox_ai"))} |`,
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

  actions.push(await buildDefaultProviderAction(ctx, `tr ${direction.sourceLanguage}:${direction.targetLanguage} ${sourceText}`))
  return actions
}

async function buildDictionarySection(ctx: Context, dictionary: NonNullable<TranslationHistoryEntry["dictionary"]>): Promise<string[]> {
  const lines: string[] = []
  const phonetics: string[] = []
  if (dictionary.ukPhonetic) phonetics.push(`UK /${dictionary.ukPhonetic}/`)
  if (dictionary.usPhonetic) phonetics.push(`US /${dictionary.usPhonetic}/`)
  if (dictionary.pinyin) phonetics.push(dictionary.pinyin)
  if (phonetics.length > 0) {
    lines.push(`*${phonetics.join(" · ")}*`, "")
  }
  if (dictionary.senses.length > 0) {
    for (const sense of dictionary.senses) {
      lines.push(`- ${sense}`)
    }
    lines.push("")
  }
  if (dictionary.wordForms.length > 0) {
    const forms = dictionary.wordForms.map(form => `${form.name} **${form.value}**`).join(" · ")
    lines.push(`**${await t(ctx, "preview_word_forms")}**: ${forms}`, "")
  }
  if (dictionary.fallbackTranslation) {
    lines.push(`**${await t(ctx, "preview_corresponding_word")}**: ${dictionary.fallbackTranslation}`, "")
  }
  return lines
}

async function buildTranslationPreview(
  ctx: Context,
  translatedText: string,
  sourceText: string,
  providerName: string,
  direction: string,
  showDetails: boolean,
  dictionary?: TranslationHistoryEntry["dictionary"]
): Promise<string> {
  const text = collapseExtraBlankLines(translatedText)
  if (!showDetails) {
    return text
  }

  const blocks = [
    text,
    "",
    "---",
    "",
    `## ${await t(ctx, "preview_source")}`,
    sourceText,
    "",
    `## ${await t(ctx, "preview_details")}`,
    `- ${await t(ctx, "preview_provider")}: ${providerName}`,
    `- ${await t(ctx, "preview_direction")}: ${direction}`
  ]
  if (dictionary) {
    blocks.push("", `## ${await t(ctx, "preview_dictionary")}`, "", ...(await buildDictionarySection(ctx, dictionary)))
  }
  return blocks.join("\n")
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
  // 用户通过 tr 指令指定的语言覆盖优先，否则走设置项
  const effectiveSource = languageOverrides?.sourceLanguage || settings.defaultSourceLanguage
  const effectiveTarget = languageOverrides?.targetLanguage || (settings.defaultTargetLanguage === "auto" ? settings.woxLanguage || "en" : settings.defaultTargetLanguage)
  const forceFixedTarget = Boolean(languageOverrides?.targetLanguage) || settings.defaultTargetLanguage !== "auto"
  const pair = forceFixedTarget ? effectiveTarget : settings.pairLanguage || "auto"

  let direction = resolveLanguageDirection(sourceText, effectiveSource, effectiveTarget, pair)
  const missingConfiguration = getMissingConfiguration(provider, settings)
  if (missingConfiguration) {
    return { ...buildConfigurationResult(missingConfiguration, provider), Score: score, Actions: await buildRetryActions(ctx, sourceText, provider, direction) }
  }
  const configurationKey = translationConfigurationKey(provider, settings)
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
    return buildTranslationResult(ctx, historyEntry, sourceText, settings, score, includeProviderInTitle, true)
  }

  const finishTranslation = async (onProgress?: (text: string) => Promise<void>, resultId?: string): Promise<Result> => {
    // The Wox AI channel is injected per call so a missing method on older Wox
    // surfaces as a clear error instead of a silent hang.
    const woxAiStream = provider === "wox_ai" ? woxAiStreamer(ctx) : undefined
    let translation = await translateText(
      provider,
      {
        text: sourceText,
        direction,
        settings: settings,
        woxAiStream
      },
      onProgress
    )
    const correctedDirection = directionFromDetectedLanguage(translation.detectedSourceLanguage)
    if (correctedDirection && correctedDirection.targetLanguage !== direction.targetLanguage) {
      const detectedSourceLanguage = translation.detectedSourceLanguage
      direction = correctedDirection
      translation = {
        ...(await translateText(provider, { text: sourceText, direction, settings: settings, woxAiStream }, onProgress)),
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
      configurationKey,
      ...(translation.dictionary ? { dictionary: translation.dictionary } : {})
    }
    await saveHistoryEntry(ctx, entry, settings.historyLimit)
    const result = await buildTranslationResult(ctx, entry, sourceText, settings, score, includeProviderInTitle, false)
    return resultId ? { ...result, Id: resultId } : result
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

  if (query && isLanguageModelProvider(provider) && typeof api.UpdateResult === "function") {
    const resultId = `lux-tr-${randomUUID()}`
    const providerName = providerDisplayName(provider)
    const placeholderTitle = await t(ctx, "translating_title")
    const placeholder: Result = {
      Id: resultId,
      Title: includeProviderInTitle ? `${providerName}: ${placeholderTitle}` : placeholderTitle,
      SubTitle: `${await t(ctx, "subtitle_source")}: ${sourceText}`,
      Icon: PLUGIN_ICON,
      Score: score,
      Actions: [],
      Preview: { PreviewType: "markdown", PreviewData: placeholderTitle, PreviewProperties: {} }
    }

    // The placeholder must travel in this query response. Wox replaces its result
    // list with the final query snapshot, which only contains accepted result IDs;
    // a placeholder pushed with PushResults during the query is dropped before the
    // first token can update it. Return the row now and stream into it afterwards.
    const stream = async () => {
      // Let this query response reach the host before the first UpdateResult.
      await delay(0)
      let lastUpdate = 0
      let lastPreview = placeholderTitle
      let updateErrorLogged = false

      const update = async (patch: Partial<Result>): Promise<boolean> => {
        try {
          return await api.UpdateResult(ctx, { ...patch, Id: resultId })
        } catch (error) {
          // Retries can be frequent; keep the first host error and avoid log spam.
          if (!updateErrorLogged) {
            updateErrorLogged = true
            await api.Log(ctx, "Warning", `LuxTranslate failed to update ${resultId}: ${error instanceof Error ? error.message : String(error)}`)
          }
          return false
        }
      }
      const updatePreview = async (text: string) => {
        const previewText = collapseExtraBlankLines(text)
        if (previewText === lastPreview) return
        lastPreview = previewText
        // A failed preview update must not cancel the translation. Wox can still be
        // applying the query response; later tokens and the final update retry.
        await update({ Preview: { PreviewType: "markdown", PreviewData: previewText, PreviewProperties: {} } })
      }
      const replaceResult = async (next: Result): Promise<boolean> => {
        // The query response holds this row, but a slow sibling provider can delay
        // the snapshot that makes the row updatable. Retry for at least as long as
        // one provider request may take instead of dropping the finished text.
        const retryWindowMs = Math.min(15000, Math.max(2000, settings.requestTimeoutMs))
        const attempts = Math.max(16, Math.ceil(retryWindowMs / 120))
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (await update(next)) return true
          await delay(120)
        }
        return false
      }

      try {
        const result = await finishTranslation(async text => {
          if (lastUpdate !== 0 && Date.now() - lastUpdate < 80) return
          lastUpdate = Date.now()
          await updatePreview(text)
        }, resultId)
        if (!(await replaceResult(result))) {
          await api.Log(ctx, "Warning", `LuxTranslate finished ${providerName} but its result is no longer visible.`)
        }
      } catch (error) {
        const failure = await failureResult(error)
        if (!(await replaceResult(failure))) {
          await api.Log(ctx, "Error", `LuxTranslate could not show the ${providerName} failure: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    void stream().catch(error => api.Log(ctx, "Error", error instanceof Error ? error.message : String(error)))
    return placeholder
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
      PreviewData: await buildTranslationPreview(
        ctx,
        entry.translatedText,
        sourceText,
        entry.providerName,
        `${entry.sourceLanguage} -> ${entry.targetLanguage}`,
        settings.showPreviewDetails,
        entry.dictionary
      ),
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

export const plugin: Omit<Plugin, "query"> & { query: (ctx: Context, query: TranslationQuery) => Promise<TranslationQueryResponse> } = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    historyWrites = Promise.resolve()
    providerWrites = Promise.resolve()
    await migrateVisibleProviders(ctx)
    lastProviderSelection = await api.GetSetting(ctx, PROVIDERS_SETTING_KEY)
    providerRefinementId = "translation_providers"
    // Detect Wox's selected UI language through plugin i18n.
    try {
      woxLanguage = normalizeWoxLanguageProbe(await api.GetTranslation(ctx, "language_probe"))
    } catch {
      woxLanguage = "en"
    }
    await api.Log(ctx, "Info", `LuxTranslate initialized, Wox language: ${woxLanguage}`)
  },

  query: async (ctx: Context, query: TranslationQuery): Promise<TranslationQueryResponse> => {
    const search = query.Type === "selection" ? query.Selection.Text : query.Search
    const settings = await loadSettings(ctx)
    const historySearch = query.Type === "selection" ? null : parseHistoryQuery(search)
    if (historySearch !== null) {
      return { Results: await buildHistoryResults(ctx, historySearch, settings), Refinements: [] }
    }
    // Selection contents are literal data, even when they begin with a command alias.
    const parsed = query.Type === "selection" ? { provider: settings.defaultProvider, text: search, forcedProvider: false } : parseTranslationQuery(search, settings.defaultProvider)

    const selection = await resolveVisibleProviders(ctx, parsed.forcedProvider ? undefined : query.Refinements)
    settings.visibleProviders = selection.providers
    // Explicit provider commands remain one-shot overrides; hiding the picker
    // avoids showing controls that would not affect those translation results.
    const refinements = parsed.forcedProvider ? [] : [await buildProviderRefinement(ctx, settings, selection.refinementId)]
    if (parsed.text === "") {
      const reset = await buildDefaultProviderAction(ctx)
      // Give reset its own explicit row. A sole help action becomes the
      // default Enter action in Wox and would silently erase preferences.
      return {
        Results: [
          await buildHelpResult(ctx, settings),
          { Title: reset.Name, SubTitle: (await t(ctx, "settings_provider")) + ": " + providerDisplayName(settings.defaultProvider), Icon: PLUGIN_ICON, Score: 90, Actions: [reset] }
        ],
        Refinements: refinements
      }
    }

    let providers = parsed.forcedProvider || settings.visibleProviders.length === 0 ? [parsed.provider] : settings.visibleProviders
    // 单词快速路径：开关打开且非显式指定翻译源时，把 Wox AI 行替换成有道词典。
    // 显式 tr wox 表示用户点名要大模型，必须尊重；其他机翻源本身够快，不替换。
    if (settings.singleWordFastPath && !parsed.forcedProvider && isSingleWord(parsed.text) && providers.includes("wox_ai")) {
      const fastPath: TranslationProvider[] = []
      for (const provider of providers) {
        if (provider === "wox_ai") {
          if (!fastPath.includes("youdao_word")) fastPath.push("youdao_word")
        } else if (!fastPath.includes(provider)) {
          fastPath.push(provider)
        }
      }
      providers = fastPath
    }
    const results = await Promise.all(providers.map((provider, index) => translateProviderResult(ctx, provider, parsed.text, settings, 100 - index, providers.length > 1, parsed, query)))
    return { Results: results.filter((result): result is Result => result !== null), Refinements: refinements }
  }
}
