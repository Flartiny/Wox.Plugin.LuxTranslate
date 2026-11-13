import { Context, PluginInitParams, Query, Result } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import * as translate from "../translate"

test("streaming UI skips throttled updates without cancelling translation", async () => {
  let resume!: () => void
  const ready = new Promise<void>(resolve => {
    resume = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>(resolve => {
    finish = resolve
  })
  const stream = jest.spyOn(translate, "translateText").mockImplementation(async (_provider, _request, onProgress) => {
    await ready
    await onProgress?.("A")
    await onProgress?.("AB")
    return { translatedText: "AB", providerName: "Wox AI" }
  })
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000)
  const settings: Record<string, string> = { visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) }
  const api = {
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] || ""),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    PushResults: jest.fn(async () => true),
    UpdateResult: jest.fn(async (_ctx: Context, result: Partial<Result>) => {
      if (result.Actions?.length) finish()
      return true
    }),
    SaveSetting: jest.fn(async (_ctx: Context, key: string, value: string) => {
      settings[key] = value
    }),
    Log: jest.fn(async () => undefined)
  }
  const ctx = {} as Context
  try {
    await plugin.init(ctx, { API: api } as unknown as PluginInitParams)
    const response = await plugin.query(ctx, { Type: "input", Search: "wox hello" } as Query)
    // The placeholder must be part of this query response. Wox replaces the result
    // list with its final snapshot, which only contains accepted result IDs.
    expect(response.Results).toHaveLength(1)
    const placeholder = response.Results[0]
    expect(placeholder.Id).toMatch(/^lux-tr-/)
    expect(placeholder.Title).toBe("translating_title")
    expect(api.PushResults).not.toHaveBeenCalled()
    resume()
    await finished
    expect(api.UpdateResult).toHaveBeenCalledTimes(2)
    expect(api.UpdateResult).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Id: placeholder.Id, Title: "AB" }))
    expect(api.SaveSetting).toHaveBeenCalledWith(ctx, "translation_history", expect.stringContaining('"translatedText":"AB"'), false)
    expect(api.Log).not.toHaveBeenCalledWith(ctx, "Error", expect.anything())
  } finally {
    resume()
    stream.mockRestore()
    clock.mockRestore()
  }
})

test("streaming keeps going when the host has not applied the result yet", async () => {
  let resume!: () => void
  const ready = new Promise<void>(resolve => {
    resume = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>(resolve => {
    finish = resolve
  })
  const stream = jest.spyOn(translate, "translateText").mockImplementation(async (_provider, _request, onProgress) => {
    await ready
    await onProgress?.("A")
    await onProgress?.("AB")
    return { translatedText: "AB", providerName: "Wox AI" }
  })
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000)
  const settings: Record<string, string> = { visible_providers: "wox_ai", wox_ai_model: JSON.stringify({ Provider: "openai", Name: "gpt-4o-mini" }) }
  let updateCalls = 0
  const api = {
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] || ""),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    PushResults: jest.fn(async () => true),
    UpdateResult: jest.fn(async (_ctx: Context, result: Partial<Result>) => {
      updateCalls++
      const accepted = updateCalls > 3
      if (accepted && result.Actions?.length) finish()
      return accepted
    }),
    SaveSetting: jest.fn(async (_ctx: Context, key: string, value: string) => {
      settings[key] = value
    }),
    Log: jest.fn(async () => undefined)
  }
  const ctx = {} as Context
  try {
    await plugin.init(ctx, { API: api } as unknown as PluginInitParams)
    const [placeholder] = (await plugin.query(ctx, { Type: "input", Search: "wox hello" } as Query)).Results
    resume()
    await finished
    // Early preview updates were rejected, but the final result was still retried
    // instead of aborting with "Query no longer visible".
    expect(api.UpdateResult).toHaveBeenCalledTimes(4)
    expect(api.UpdateResult).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Id: placeholder.Id, Title: "AB" }))
    expect(api.Log).not.toHaveBeenCalledWith(ctx, "Error", expect.anything())
  } finally {
    resume()
    stream.mockRestore()
    clock.mockRestore()
  }
})
