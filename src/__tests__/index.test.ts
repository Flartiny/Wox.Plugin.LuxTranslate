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
    return { translatedText: "AB", providerName: "OpenAI" }
  })
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000)
  const settings: Record<string, string> = { visible_providers: "openai", openai_api_key: "test" }
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
    const response = await plugin.query(ctx, { Type: "input", Search: "openai hello" } as Query)
    // The placeholder is registered before streaming; the returned response
    // now carries refinements separately from the pushed results.
    expect(response.Results).toEqual([])
    expect(api.PushResults).toHaveBeenCalledTimes(1)
    resume()
    await finished
    expect(api.UpdateResult).toHaveBeenCalledTimes(2)
    expect(api.UpdateResult).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Id: expect.any(String), Title: "AB" }))
    expect(api.SaveSetting).toHaveBeenCalledWith(ctx, "translation_history", expect.stringContaining('"translatedText":"AB"'), false)
    expect(api.Log).not.toHaveBeenCalledWith(ctx, "Error", expect.anything())
  } finally {
    resume()
    stream.mockRestore()
    clock.mockRestore()
  }
})
