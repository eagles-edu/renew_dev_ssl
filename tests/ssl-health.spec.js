const { test, expect } = require("@playwright/test")

const DEFAULT_BASE_URL = "https://example.com"
const BASE_URL = process.env.TARGET_URL || process.env.BASE_URL || DEFAULT_BASE_URL
const strictSecurityHeaders = process.env.PLAYWRIGHT_REQUIRE_SECURITY_HEADERS === "1"
const enforceSecurityHeaders = strictSecurityHeaders || BASE_URL !== DEFAULT_BASE_URL

const normalizeHeaders = (headers = {}) =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : value,
    ])
  )

test.describe("SSL posture", () => {
  test("homepage is reachable over HTTPS", async ({ page, baseURL }) => {
    test.skip(!baseURL, "baseURL is not configured.")

    const response = await page.goto("/")
    expect(response, "navigation failed").toBeTruthy()
    expect(response.ok(), "non-2xx response").toBeTruthy()

    const current = new URL(page.url())
    expect(current.protocol).toBe("https:")
  })

  test("security headers are present", async ({ request, baseURL }) => {
    if (strictSecurityHeaders && (!baseURL || baseURL === DEFAULT_BASE_URL)) {
      throw new Error(
        "PLAYWRIGHT_REQUIRE_SECURITY_HEADERS=1 requires TARGET_URL or BASE_URL to be set to a non-default host."
      )
    }

    test.skip(
      !baseURL || !enforceSecurityHeaders,
      "Set TARGET_URL/BASE_URL or PLAYWRIGHT_REQUIRE_SECURITY_HEADERS=1 to enforce security headers."
    )

    const response = await request.get(baseURL, { failOnStatusCode: false })
    expect(response.status(), "target did not return success").toBeLessThan(400)

    const headers = normalizeHeaders(response.headers())
    expect.soft(headers["strict-transport-security"]).toMatch(/max-age=/i)
    expect.soft(headers["x-content-type-options"]).toMatch(/nosniff/i)
    expect.soft(headers["x-frame-options"]).toMatch(/(deny|sameorigin)/i)
    expect.soft(headers["content-security-policy"]).toBeTruthy()
    expect.soft(headers["referrer-policy"]).toBeTruthy()
  })
})
