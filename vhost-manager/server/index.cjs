const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")
const core = require("./core.cjs")
const ops = require("./operations.cjs")
const security = require("./security.cjs")

const config = core.configFromEnv()
const plans = new Map()
let sslJob = null
const MANAGER_SERVICE = "renew-dev-ssl-vhost-manager.service"
const csrf = crypto.randomBytes(24).toString("base64url")
const publicDir = path.join(__dirname, "public")
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

function loopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  })
  res.end(JSON.stringify(data))
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""))
  const right = Buffer.from(String(b || ""))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function addJobOutput(job, chunk) {
  job.output = `${job.output}${chunk}`.slice(-80000)
}

function publicSslJob(job) {
  const publicJob = { ...job }
  delete publicJob.process
  return publicJob
}

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error("Request body is too large.")
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch {
    throw new Error("Request body must be valid JSON.")
  }
}

function scan() {
  const manifest = ops.readManifest(config)
  return core.inventory(config, manifest)
}

function storePlan(plan) {
  plans.set(plan.id, plan)
  for (const [id, item] of plans) if (item.expiresAt < Date.now()) plans.delete(id)
  return plan
}

function api(req, res, url) {
  if (!loopback(req.socket.remoteAddress)) return send(res, 403, { error: "Loopback access only." })
  const host = String(req.headers.host || "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    return send(res, 403, { error: "Local host header required." })
  if (req.method === "GET" && url.pathname === "/api/session") return send(res, 200, { csrf })
  if (req.method === "GET" && url.pathname === "/api/status")
    return send(res, 200, {
      services: ops.serviceState(config),
      inventory: scan(),
      history: ops.history(config),
      capabilities: core.depsInNginx(config),
      options: core.managerOptions(config),
      root: config.testMode || process.getuid?.() === 0,
    })
  if (req.method === "GET" && url.pathname === "/api/site") {
    try {
      return send(
        res,
        200,
        core.siteDetails(config, url.searchParams.get("domain"), ops.readManifest(config))
      )
    } catch (error) {
      return send(res, 404, { error: error.message })
    }
  }
  if (req.method === "GET" && url.pathname === "/api/history")
    return send(res, 200, { history: ops.history(config) })
  if (req.method === "GET" && url.pathname === "/api/security")
    return send(res, 200, security.securitySnapshot(config))
  if (req.method === "GET" && url.pathname === "/api/ssl-job") {
    const id = url.searchParams.get("id")
    if (!id) {
      if (!sslJob) return send(res, 200, { job: null })
      return send(res, 200, { job: publicSslJob(sslJob) })
    }
    if (!sslJob || sslJob.id !== id)
      return send(res, 404, { error: "SSL renewal session not found." })
    return send(res, 200, { job: publicSslJob(sslJob) })
  }
  if (req.method !== "POST") return send(res, 404, { error: "Not found." })
  const origin = req.headers.origin
  if (
    !origin ||
    origin !== `http://${req.headers.host}` ||
    !safeEqual(req.headers["x-csrf-token"], csrf)
  )
    return send(res, 403, { error: "Request origin or CSRF token is invalid." })
  return body(req)
    .then((input) => {
      if (url.pathname === "/api/ssl-renew") {
        const domain = String(input.domain || "")
          .trim()
          .toLowerCase()
        if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
          return send(res, 400, { error: "Choose a valid website domain." })
        if (!config.testMode && process.getuid?.() !== 0)
          return send(res, 403, { error: "SSL renewal requires the root Vhost Manager service." })
        if (sslJob?.status === "running")
          return send(res, 409, { error: `SSL renewal is already running for ${sslJob.domain}.` })
        const site = scan().sites.find((entry) => entry.domain === domain)
        if (!site?.managed || !site.nginxConfigs.length)
          return send(res, 404, {
            error: "SSL renewal is available for manager-created Nginx virtual hosts.",
          })
        if (site.tlsReady)
          return send(res, 409, { error: `${domain} already has a valid certificate.` })
        if (config.testMode)
          return send(res, 501, { error: "SSL renewal is disabled in test mode." })

        const id = crypto.randomUUID()
        sslJob = {
          id,
          domain,
          status: "running",
          output: "Entering root login shell with sudo -i…\n",
          startedAt: new Date().toISOString(),
          exitCode: null,
          process: null,
        }
        const repoRoot = path.resolve(__dirname, "../..")
        const renewalCommand = `cd -- ${shellQuote(repoRoot)} && /bin/bash ./update_domain_inventory.sh --add-new ${shellQuote(domain)} && /bin/bash ./renew_all_domains.sh --domain ${shellQuote(domain)}`
        const command = `/usr/bin/sudo -i /bin/bash -lc ${shellQuote(renewalCommand)}`
        let child
        try {
          child = spawn(
            "/usr/bin/script",
            ["--quiet", "--flush", "--return", "--command", command, "/dev/null"],
            {
              stdio: ["pipe", "pipe", "pipe"],
              env: process.env,
            }
          )
          sslJob.process = child
          child.stdout.on("data", (chunk) => addJobOutput(sslJob, chunk.toString("utf8")))
          child.stderr.on("data", (chunk) => addJobOutput(sslJob, chunk.toString("utf8")))
          child.on("error", (error) => {
            addJobOutput(sslJob, `\nCould not start SSL renewal: ${error.message}\n`)
            sslJob.status = "failed"
            sslJob.exitCode = 1
            sslJob.finishedAt = new Date().toISOString()
            sslJob.process = null
          })
          child.on("close", (code) => {
            if (sslJob?.id !== id) return
            sslJob.status = code === 0 ? "completed" : "failed"
            sslJob.exitCode = code
            sslJob.finishedAt = new Date().toISOString()
            sslJob.process = null
          })
        } catch (error) {
          sslJob.status = "failed"
          sslJob.exitCode = 1
          sslJob.finishedAt = new Date().toISOString()
          addJobOutput(sslJob, `Could not start SSL renewal: ${error.message}\n`)
        }
        return send(res, 202, { job: publicSslJob(sslJob) })
      }
      if (url.pathname === "/api/ssl-input") {
        const text = String(input.text || "")
        if (!sslJob || sslJob.id !== input.jobId || sslJob.status !== "running" || !sslJob.process)
          return send(res, 409, { error: "There is no active SSL renewal prompt." })
        if (text.length > 2000 || /[\r\n]/.test(text))
          return send(res, 400, { error: "Enter one response of at most 2,000 characters." })
        sslJob.process.stdin.write(`${text}\n`)
        return send(res, 202, { accepted: true })
      }
      if (url.pathname === "/api/scan")
        return send(res, 200, { inventory: scan(), services: ops.serviceState(config) })
      if (url.pathname === "/api/runtime") {
        const actions = { restart: "restart", logoff: "stop" }
        const systemctlAction = actions[input.action]
        if (!systemctlAction) return send(res, 400, { error: "Choose restart or log off." })
        if (!config.testMode && process.getuid?.() !== 0)
          return send(res, 403, { error: "Runtime controls require the root manager service." })
        send(res, 202, {
          action: input.action,
          message:
            input.action === "restart"
              ? "Restarting Vhost Manager…"
              : "Vhost Manager is shutting down. Use its launcher to start it again.",
        })
        setTimeout(() => {
          if (config.testMode) return
          const result = spawnSync(
            "/usr/bin/systemctl",
            ["--no-block", systemctlAction, MANAGER_SERVICE],
            { encoding: "utf8", timeout: 5000 }
          )
          if (result.status !== 0)
            process.stderr.write(
              `Could not ${systemctlAction} ${MANAGER_SERVICE}: ${(result.stderr || result.error?.message || result.stdout || "unknown error").trim()}\n`
            )
        }, 150)
        return
      }
      if (url.pathname === "/api/plan/reset")
        return send(res, 200, { plan: storePlan(core.resetPlan(config)) })
      if (url.pathname === "/api/archive/examples") {
        const plan = plans.get(input.planId)
        if (!plan || plan.expiresAt < Date.now())
          return send(res, 410, { error: "This review expired. Rescan and preview again." })
        return send(res, 200, ops.archiveExamples(plan, config))
      }
      if (url.pathname === "/api/plan/site")
        return send(res, 200, {
          plan: storePlan(core.sitePlan(config, input, scan(), ops.readManifest(config))),
        })
      if (url.pathname === "/api/plan/toggle")
        return send(res, 200, {
          plan: storePlan(core.togglePlan(config, input, ops.readManifest(config))),
        })
      if (url.pathname === "/api/plan/adopt")
        return send(res, 200, {
          plan: storePlan(core.adoptPlan(config, input, scan(), ops.readManifest(config))),
        })
      if (url.pathname === "/api/validate")
        return send(res, 200, { services: ops.serviceState(config) })
      if (url.pathname === "/api/apply") {
        const plan = plans.get(input.planId)
        if (!plan || plan.expiresAt < Date.now())
          return send(res, 410, { error: "This preview expired. Rescan and review a new plan." })
        if (input.confirmation !== plan.confirmation)
          return send(res, 400, { error: "Confirmation text does not match the preview." })
        const result = ops.applyPlan(plan, config)
        plans.delete(plan.id)
        return send(res, 200, { ...result, inventory: scan() })
      }
      if (url.pathname === "/api/rollback")
        return send(res, 200, {
          ...ops.rollbackOperation(input.operationId, config),
          inventory: scan(),
        })
      return send(res, 404, { error: "Not found." })
    })
    .catch((error) => send(res, 400, { error: error.message || "Request failed." }))
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  )
  const url = new URL(req.url, "http://127.0.0.1")
  if (url.pathname.startsWith("/api/")) return api(req, res, url)
  if (!loopback(req.socket.remoteAddress)) return send(res, 403, { error: "Loopback access only." })
  let decodedPath
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 400, { error: "Invalid encoded path." })
  }
  const target =
    decodedPath === "/"
      ? path.join(publicDir, "index.html")
      : path.resolve(publicDir, `.${decodedPath}`)
  if (!target.startsWith(`${publicDir}${path.sep}`))
    return send(res, 403, { error: "Invalid path." })
  fs.readFile(target, (error, data) => {
    if (error) return send(res, 404, { error: "Build the interface with npm run vhost:build." })
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    })
    res.end(data)
  })
})

const port = Number(process.env.VHOST_MANAGER_PORT || 4310)
try {
  ops.ensureRoot(config)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`Vhost Manager available at http://127.0.0.1:${port}\n`)
)
