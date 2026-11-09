/**
 * Shared storage layer for an account's Antigravity login blob: the one place
 * that knows how `agy` stores credentials (`go-keyring-base64:`-prefixed
 * base64 JSON in the OS keychain, plain JSON in `antigravity-oauth-token`).
 *
 * Both the account pool (which only needs the email) and the Cloud Code client
 * (which needs the whole OAuth credential) decode the same blobs, so the keychain
 * unlock, the `security` argv, the timeouts and the file fallback live here only.
 * This module deliberately imports nothing from `accounts.ts` or `cloudcode.ts`
 * so both can depend on it without a cycle.
 * @module dsh-llm-antigravity-acp/credential
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { CommandRunner } from './preflight.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WINCRED_EXE = join(__dirname, '..', 'lib', 'wincred.exe')

/** Prefix `agy` writes in front of the base64 JSON blob stored by `go-keyring`. */
export const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

/**
 * Read the active Windows Credential Manager entry for gemini:antigravity.
 */
export function readWinCred(target = 'gemini:antigravity'): string | undefined {
  if (process.platform !== 'win32' || !existsSync(WINCRED_EXE)) return undefined
  try {
    const res = spawnSync(WINCRED_EXE, ['read', target], { encoding: 'utf8', timeout: 5000 })
    if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) return res.stdout.trim()
  } catch {}
  return undefined
}

/**
 * Write a credential payload into Windows Credential Manager.
 */
export function writeWinCred(target = 'gemini:antigravity', username = 'antigravity', payload?: string): boolean {
  if (process.platform !== 'win32' || !existsSync(WINCRED_EXE) || !payload) return false
  try {
    const res = spawnSync(WINCRED_EXE, ['write', target, username], { input: payload, encoding: 'utf8', timeout: 5000 })
    return res.status === 0
  } catch {
    return false
  }
}

/**
 * Delete a credential entry from Windows Credential Manager.
 */
export function deleteWinCred(target = 'gemini:antigravity'): boolean {
  if (process.platform !== 'win32' || !existsSync(WINCRED_EXE)) return false
  try {
    const res = spawnSync(WINCRED_EXE, ['delete', target], { timeout: 5000 })
    return res.status === 0
  } catch {
    return false
  }
}

/** Layout fields the credential reader needs; structurally satisfied by `AccountLayout`. */
export interface CredentialLayout {
  /** True when the account reuses this machine's own login (no sandboxed `$HOME`). */
  system: boolean
  /** `$HOME` the keychain lookup is scoped to. */
  homeDir: string
  /** `--app-data-dir` that owns the `antigravity-oauth-token` fallback file. */
  appDir: string
}

/**
 * Unwrap one stored credential blob into its JSON text.
 * Supports `go-keyring-base64:<base64>` (written by `agy` via `go-keyring` on
 * macOS Keychain) and plain JSON token files; JWT payloads stay to the caller.
 * @param raw - token payload from the keychain or oauth-token file.
 * @returns the JSON text, or undefined when the blob is empty or undecodable.
 */
export function decodeStoredCredential(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) return trimmed
  try {
    return Buffer.from(trimmed.slice(GO_KEYRING_BASE64_PREFIX.length).trim(), 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Unlock the empty-password login keychain of a sandboxed account. macOS
 * resolves the default keychain from `$HOME/Library/Keychains`, so a non-system
 * account has to be unlocked before any `security find-generic-password` lookup
 * scoped to that home can succeed. Missing keychain files and failed unlocks are
 * both ignored: the caller falls back to the token file.
 * @param layout - account layout (or any object carrying `homeDir`).
 * @param run - helper command runner.
 */
export async function unlockAccountKeychain(layout: Pick<CredentialLayout, 'homeDir'>, run: CommandRunner): Promise<void> {
  const kcPath = join(layout.homeDir, 'Library', 'Keychains', 'login.keychain-db')
  if (!existsSync(kcPath)) return
  await run(['security', 'unlock-keychain', '-p', '', kcPath], 5_000, { HOME: layout.homeDir }).catch(() => undefined)
}

/**
 * Read one account's raw stored credential: the sandboxed keychain first, the
 * `antigravity-oauth-token` file second. A keychain blob the caller cannot use
 * (`accept` returns false) falls through to the file exactly as before.
 *
 * macOS resolves the default keychain from `$HOME/Library/Keychains`, so a
 * non-system account unlocks its own empty-password keychain first (only when
 * the file exists) and every lookup then runs with `HOME` pointing at it.
 * @param layout - account layout (or any object carrying these three fields).
 * @param run - helper command runner.
 * @param platform - host platform, injectable for tests.
 * @param accept - predicate deciding whether a raw blob is usable.
 * @returns the raw blob, or undefined when the account is not signed in.
 */
export async function readStoredCredentialRaw(
  layout: CredentialLayout,
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  accept: (raw: string) => boolean = () => true,
): Promise<string | undefined> {
  if (platform === 'darwin') {
    if (!layout.system) await unlockAccountKeychain(layout, run)
    const argv = ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']
    const stored = layout.system ? await run(argv, 10_000) : await run(argv, 10_000, { HOME: layout.homeDir })
    if (stored.code === 0 && accept(stored.stdout)) return stored.stdout
  }
  const file = join(layout.appDir, 'antigravity-oauth-token')
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8')
      if (accept(raw)) return raw
    } catch {}
  }
  if (platform === 'win32' && layout.system) {
    const winRaw = readWinCred('gemini:antigravity')
    if (winRaw && accept(winRaw)) {
      try {
        mkdirSync(layout.appDir, { recursive: true })
        writeFileSync(file, winRaw, 'utf8')
      } catch {}
      return winRaw
    }
  }
  return undefined
}
