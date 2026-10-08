export const AUTH_DEFAULTS = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  requestMs: 30_000,
  loginMs: 900_000,
  pollMs: 5_000,
  refreshMarginMs: 60_000,
}

export type AuthOptions = typeof AUTH_DEFAULTS
export type Credentials = { accessToken: string; accountId: string }
type Tokens = Credentials & { refreshToken: string; expiresAt: number }

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function required(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing authentication field")
  return value
}

function claims(token: string): Record<string, unknown> {
  return object(JSON.parse(Buffer.from(required(token.split(".")[1]), "base64url").toString("utf8")))
}

export async function deviceLogin(options: AuthOptions, announce: (url: string, code: string) => void) {
  const post = (path: string, body: BodyInit, contentType: string, signal?: AbortSignal) => fetch(`${options.issuer}${path}`, {
    method: "POST", body, redirect: "error",
    headers: { "content-type": contentType },
    signal: AbortSignal.any([AbortSignal.timeout(options.requestMs), ...(signal ? [signal] : [])]),
  })
  const read = async (response: Response) => {
    if (!response.ok) throw new Error(`Authentication request failed (${response.status})`)
    return object(await response.json())
  }
  const exchange = async (form: Record<string, string>, previous?: Tokens, signal?: AbortSignal): Promise<Tokens> => {
    const body = await read(await post("/oauth/token", new URLSearchParams({ client_id: options.clientId, ...form }), "application/x-www-form-urlencoded", signal))
    const accessToken = required(body.access_token)
    const access = claims(accessToken)
    const identity = body.id_token ? claims(required(body.id_token)) : access
    const account = object(identity["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {})
    if (typeof access.exp !== "number" || !Number.isFinite(access.exp)) throw new Error("Missing token expiry")
    return {
      accessToken,
      refreshToken: required(body.refresh_token ?? previous?.refreshToken),
      accountId: required(account.chatgpt_account_id ?? previous?.accountId),
      expiresAt: access.exp * 1_000,
    }
  }
  const deadline = AbortSignal.timeout(options.loginMs)
  const device = await read(await post("/api/accounts/deviceauth/usercode", JSON.stringify({ client_id: options.clientId }), "application/json", deadline))
  const id = required(device.device_auth_id)
  const code = required(device.user_code ?? device.usercode)
  const interval = Number(device.interval) * 1_000
  const pollMs = Number.isFinite(interval) && interval > 0 ? Math.max(interval, options.pollMs) : options.pollMs
  announce(`${options.issuer}/codex/device`, code)
  let tokens: Tokens
  for (;;) {
    deadline.throwIfAborted()
    await Bun.sleep(Math.min(pollMs, options.loginMs))
    deadline.throwIfAborted()
    const response = await post("/api/accounts/deviceauth/token", JSON.stringify({ device_auth_id: id, user_code: code }), "application/json", deadline)
    if (response.status === 403 || response.status === 404) { await response.body?.cancel(); continue }
    const body = await read(response)
    tokens = await exchange({
      grant_type: "authorization_code", code: required(body.authorization_code),
      code_verifier: required(body.code_verifier), redirect_uri: `${options.issuer}/deviceauth/callback`,
    }, undefined, deadline)
    break
  }
  let refreshing: Promise<Tokens> | undefined
  return async (): Promise<Credentials> => {
    if (tokens.expiresAt <= Date.now() + options.refreshMarginMs) {
      refreshing ??= exchange({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, tokens).then((next) => {
        tokens = next
        return next
      }).finally(() => { refreshing = undefined })
      await refreshing
    }
    return { accessToken: tokens.accessToken, accountId: tokens.accountId }
  }
}
