import { execFile } from "node:child_process"

export type SpeechPlayerKind = "windows" | "none"

export interface SpeechPlayer {
  kind: SpeechPlayerKind
  speak(text: string, language?: string): Promise<void>
}

class NoopSpeechPlayer implements SpeechPlayer {
  kind: SpeechPlayerKind = "none"

  async speak(): Promise<void> {
    return undefined
  }
}

class WindowsSpeechPlayer implements SpeechPlayer {
  kind: SpeechPlayerKind = "windows"

  async speak(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === "") {
      return
    }

    await new Promise<void>((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.Speak($args[0])",
          trimmed
        ],
        { windowsHide: true },
        error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        }
      )
    })
  }
}

export function resolveDefaultSpeechPlayer(platform: NodeJS.Platform = process.platform): SpeechPlayerKind {
  return platform === "win32" ? "windows" : "none"
}

export function createSpeechPlayer(platform: NodeJS.Platform = process.platform): SpeechPlayer {
  return resolveDefaultSpeechPlayer(platform) === "windows" ? new WindowsSpeechPlayer() : new NoopSpeechPlayer()
}

export async function speakText(text: string, language?: string): Promise<void> {
  await createSpeechPlayer().speak(text, language)
}
