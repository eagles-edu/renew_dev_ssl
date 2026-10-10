const { test, expect } = require("@playwright/test")
const fs = require("node:fs")
const path = require("node:path")

test.afterAll(() => {
  // The fixture API stores its test archive and journal under var/; keep runtime state out of source fixtures.
  fs.rmSync(path.join(__dirname, "../fixtures/vhost-manager/var"), { recursive: true, force: true })
})

test("dashboard opens create flow, previews files, and cancels without changes", async ({
  page,
}) => {
  await page.goto("/")
  const html = fs.readFileSync(path.join(__dirname, "../../vhost-manager/ui/index.html"), "utf8")
  expect(html).toContain("<!DOCTYPE html>")
  expect(html).not.toMatch(
    /<(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b[^>]*\/>/i
  )
  expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat")
  await expect(page.getByRole("heading", { name: "Vhost setup" })).toBeVisible()
  await expect(page.getByRole("option", { name: /phpmyadmin/ })).toBeVisible()
  await page.getByRole("button", { name: "Create new website" }).first().click()
  await page.getByLabel("Domain name").fill("preview.example.test")
  await expect(page.getByLabel("Webroot")).toHaveValue(/preview\.example\.test\/public_html\/$/)
  await expect(page.getByLabel("Directory permissions")).toHaveValue("0755")
  await expect(page.getByLabel("CSP policy source")).toHaveValue("global")
  await expect(page.getByLabel("Global CSP policy")).toHaveValue(/worker-src 'self' blob:/)
  await expect(page.getByLabel("Global CSP policy")).toHaveValue(/https:\/\/\*\.gptpatient\.com/)
  await expect(page.getByLabel("Global CSP policy")).toHaveValue(/www\.googletagmanager\.com/)
  await expect(page.getByLabel("Memory limit")).toHaveValue("128M")
  await expect(page.getByLabel("TCP ports")).toHaveValue("80, 443")
  await page.getByLabel("UDP ports").fill("5353")
  await expect(page.getByLabel("Advanced ini directives")).toBeEditable()
  await page.getByLabel("Memory limit").fill("512M")
  await page.getByLabel("Advanced ini directives").fill("opcache.memory_consumption = 192")
  await page.getByLabel("CSP policy source").selectOption("custom")
  await expect(page.getByLabel("Custom CSP policy")).toHaveValue(/default-src 'self'/)
  await expect(page.getByLabel("Custom CSP policy")).toBeEditable()
  await page.getByRole("button", { name: "Reset custom policy to global defaults" }).click()
  await expect(page.getByLabel("CSP delivery mode")).toHaveValue("report-only")
  await page.getByRole("button", { name: "Review plan" }).click()
  await expect(page.getByRole("heading", { name: "Create preview.example.test" })).toBeVisible()
  await expect(page.getByText("IPTABLES FIREWALL RULES")).toBeVisible()
  await expect(page.getByText("UDP 5353")).toBeVisible()
  await expect(
    page.locator(".file-item summary span").filter({ hasText: "/etc/iptables/rules.v4" })
  ).toBeVisible()
  const phpIniReview = page.locator(".file-item").filter({
    has: page.locator("summary > span").filter({ hasText: /\/\.site-config\/php\.ini$/ }),
  })
  await expect(phpIniReview).toHaveCount(1)
  await expect(phpIniReview).toContainText("memory_limit = 512M")
  await expect(phpIniReview).toContainText("opcache.memory_consumption = 192")
  await expect(page.getByText("DIRECTORIES, OWNERSHIP, AND MODES")).toBeVisible()
  await expect(
    page
      .locator(".file-item summary span")
      .filter({ hasText: "/home/preview.example.test/public_html/index.html" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Cancel changes" }).click()
  await expect(page.getByRole("option", { name: /phpmyadmin/ })).toBeVisible()
})

test("all create actions open the inline form with dark mode and optional database", async ({
  page,
}) => {
  await page.goto("/")

  const openAndCancel = async (button) => {
    await button.click()
    await expect(page.locator(".create-panel")).toBeVisible()
    await expect(page.locator(".modal-backdrop")).toHaveCount(0)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
  }

  const createWebsiteButtons = page.getByRole("button", {
    name: "Create new website",
    exact: true,
  })
  const createWebsiteButtonCount = await createWebsiteButtons.count()
  for (let index = 0; index < createWebsiteButtonCount; index += 1) {
    const button = createWebsiteButtons.nth(index)
    if (await button.isVisible()) await openAndCancel(button)
  }

  const newSiteButton = page.getByRole("button", { name: "New site", exact: true })
  if (await newSiteButton.isVisible()) await openAndCancel(newSiteButton)

  const firstWebsiteButton = page.getByRole("button", {
    name: "Create the first website",
    exact: true,
  })
  if (await firstWebsiteButton.isVisible()) await openAndCancel(firstWebsiteButton)

  await page.getByRole("button", { name: "Help", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create new website", exact: true })
    .click()

  const createPanel = page.locator(".create-panel")
  await expect(createPanel).toBeVisible()
  await expect(createPanel.locator(".theme-toggle")).toHaveCount(0)
  const [panelWidth, slotWidth] = await Promise.all([
    createPanel.evaluate((element) => element.getBoundingClientRect().width),
    page.locator(".create-form-slot").evaluate((element) => element.getBoundingClientRect().width),
  ])
  expect(panelWidth).toBeCloseTo(slotWidth, 0)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(createPanel).toHaveCSS("background-color", "rgb(38, 38, 38)")
  await expect(createPanel).toHaveCSS("filter", "none")
  await expect(page.locator(".app-shell")).toHaveCSS("filter", "none")
  await page.getByRole("button", { name: "Dark mode, switch to light mode" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(createPanel).toHaveCSS("background-color", "rgb(255, 255, 255)")
  await expect(createPanel).toHaveCSS("filter", "none")
  await page.getByRole("button", { name: "Light mode, switch to dark mode" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(createPanel).toHaveCSS("background-color", "rgb(38, 38, 38)")
})

test("reset preview names phpMyAdmin resources that will be preserved", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Preview clean initialization" }).click()
  await expect(
    page.getByRole("heading", { name: "Reset site vhosts (phpMyAdmin preserved)" })
  ).toBeVisible()
  await expect(page.getByText("Protected resources preserved")).toBeVisible()
  await expect(page.getByText("/opt/phpmyadmin")).toBeVisible()
  await expect(page.getByText("the OLS phpMyAdmin listener and credentials")).toBeVisible()
  await expect(page.getByText("Example configs will be saved in the archive")).toBeVisible()
  await page.getByRole("button", { name: "Save examples to archive only" }).click()
  await expect(page.getByRole("button", { name: "Examples archived" })).toBeDisabled()
  await expect(page.getByText(/Active server configs remain unchanged/)).toBeVisible()
  await expect(page.getByRole("option", { name: /phpmyadmin/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled()
})

test("help, settings, config inspection, and webroot inspection respond", async ({ page }) => {
  await page.goto("/")
  await page.getByLabel("Search websites").fill("no-such-site.example")
  await expect(page.getByText("No matching configuration records")).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("option", { name: /phpmyadmin/ })).toBeVisible()
  await page.getByRole("button", { name: "Scan server" }).click()
  await expect(page.locator(".toast")).toContainText("Inventory refreshed.")
  await page.getByRole("button", { name: "Help" }).click()
  await expect(page.getByRole("heading", { name: "Setup guide" })).toBeVisible()
  await page.getByLabel("Close").click()
  await page.getByRole("button", { name: /Server admin/ }).click()
  await expect(page.getByRole("heading", { name: "Server paths and options" })).toBeVisible()
  await page.getByLabel("Close").click()
  await page.getByRole("option", { name: /phpmyadmin/ }).click()
  await expect(page.getByText("/opt/phpmyadmin/", { exact: true })).toBeVisible()
  await expect(page.getByText(/phpMyAdmin is intentionally protected/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Edit settings" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Enable challenge config" })).toBeDisabled()
  await page.getByRole("button", { name: "Validate configs" }).click()
  await expect(page.locator(".toast")).toContainText("Nginx: valid")
  await page.getByRole("button", { name: "View config" }).click()
  await expect(page.getByRole("heading", { name: "phpmyadmin configuration" })).toBeVisible()
  await expect(page.locator(".info-content")).toContainText("vhconf.conf")
  await page.getByLabel("Close").click()
  await page.getByRole("button", { name: "View webroot" }).click()
  await expect(page.getByRole("heading", { name: "phpmyadmin webroot" })).toBeVisible()
  await expect(page.locator(".info-content")).toContainText("/opt/phpmyadmin")
  await page.getByLabel("Close").click()
  await page.getByRole("button", { name: "Activity log" }).click()
  await expect(page.getByRole("heading", { name: "Operation history" })).toBeVisible()
})

test("layout remains usable at mobile width and navigation opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open menu" }).click()
  await expect(page.locator(".nav-label")).toHaveText("WORKSPACE")
  await page.mouse.click(300, 200)
  await expect(page.getByRole("heading", { name: "Vhost setup" })).toBeVisible()
})

test("PHP profile values prefill when status arrives after the create form opens", async ({
  page,
}) => {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch()
    await new Promise((resolve) => setTimeout(resolve, 750))
    await route.fulfill({ response })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Create new website" }).first().click()
  await expect(page.getByLabel("Memory limit")).toHaveValue("128M")
  await expect(page.getByLabel("Upload max filesize")).toHaveValue("8M")
})
