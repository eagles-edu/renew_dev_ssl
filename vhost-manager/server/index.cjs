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
const publicDir =
  config.testMode && process.env.VHOST_MANAGER_PUBLIC_DIR
    ? path.resolve(process.env.VHOST_MANAGER_PUBLIC_DIR)
    : path.join(__dirname, "public")
const CURATOR_V2_CRITERIA = Object.freeze({
  nginx_valid: "The generated Nginx configuration passes validation.",
  ols_valid: "The generated OpenLiteSpeed configuration passes validation.",
  site_reachable: "The configured site returns a navigable response after reload.",
  operation_recorded: "Vhost Manager records the requested operation outcome.",
  human_review: "A human reviews this Vhost Manager operation outcome.",
})
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
  const criterionIds =
    plan.kind === "site"
      ? [
          "nginx_valid",
          ...(plan.settings?.requestMode === "ols" ? ["ols_valid"] : []),
          "site_reachable",
        ]
      : plan.kind === "toggle"
        ? ["nginx_valid"]
        : plan.kind === "reset"
          ? ["nginx_valid", "ols_valid"]
          : ["operation_recorded"]
  const reviewedPlan = {
    ...plan,
    curatorV2Goal: {
      problem: `${plan.title}: ${plan.summary}`,
      success_criteria: [...criterionIds, "human_review"].map((criterion_id) => ({
        criterion_id,
        description: CURATOR_V2_CRITERIA[criterion_id],
      })),
    },
  }
  plans.set(reviewedPlan.id, reviewedPlan)
  for (const [id, item] of plans) if (item.expiresAt < Date.now()) plans.delete(id)
  return reviewedPlan
}

function curatorV2Receipt(operation, request = null) {
  const required = [
    "CURATOR_V2_BRIDGE_PYTHON",
    "CURATOR_V2_MCP_COMMAND",
    "CURATOR_V2_DATABASE",
    "CURATOR_V2_PROJECT_ROOT",
    "CURATOR_V2_PROFILE_ID",
    "CURATOR_V2_UID",
    "CURATOR_V2_GID",
    "CURATOR_V2_HOME",
  ]
  if (required.some((name) => !process.env[name]))
    return { status: "pending", reason: "not_configured" }
  const uid = Number(process.env.CURATOR_V2_UID)
  const gid = Number(process.env.CURATOR_V2_GID)
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1)
    return { status: "pending", reason: "invalid_host_identity" }
  if (
    [
      process.env.CURATOR_V2_BRIDGE_PYTHON,
      process.env.CURATOR_V2_MCP_COMMAND,
      process.env.CURATOR_V2_DATABASE,
      process.env.CURATOR_V2_PROJECT_ROOT,
      process.env.CURATOR_V2_HOME,
    ].some((value) => !path.isAbsolute(value))
  )
    return { status: "pending", reason: "invalid_host_configuration" }

  const helper = path.join(__dirname, "../curatormd-v2/apply_bridge.py")
  const result = spawnSync(process.env.CURATOR_V2_BRIDGE_PYTHON, [helper], {
    cwd: process.env.CURATOR_V2_PROJECT_ROOT,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.CURATOR_V2_HOME,
      CURATOR_V2_MCP_COMMAND: process.env.CURATOR_V2_MCP_COMMAND,
      CURATOR_V2_DATABASE: process.env.CURATOR_V2_DATABASE,
      CURATOR_V2_PROJECT_ROOT: process.env.CURATOR_V2_PROJECT_ROOT,
      CURATOR_V2_PROFILE_ID: process.env.CURATOR_V2_PROFILE_ID,
    },
    uid,
    gid,
    encoding: "utf8",
    input: JSON.stringify({
      operation: {
        id: operation.id,
        kind: operation.kind,
        title: operation.title,
        domain: operation.domain,
        state: operation.state,
        producerId: operation.producerId,
        exitCode: operation.exitCode,
      },
      ...(request ? { request } : {}),
    }),
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  })
  if (result.status !== 0 || result.error) {
    const bridgeErrorType = String(result.stderr || "").trim()
    return {
      status: "pending",
      reason: "curator_unavailable",
      ...(/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(bridgeErrorType) ? { bridgeErrorType } : {}),
    }
  }
  try {
    const response = JSON.parse(result.stdout)
    const receipt = response.receipt
    const eventPrefix =
      operation.kind === "rollback"
        ? "vhost-rollback-"
        : operation.kind === "archive"
          ? "vhost-archive-"
          : operation.kind === "ssl-renew"
            ? "vhost-ssl-renew-"
            : operation.kind === "ssl-cron"
              ? "vhost-ssl-cron-"
              : operation.kind === "script"
                ? "vhost-script-"
                : "vhost-apply-"
    const expectedEventId = `${eventPrefix}${operation.id}`
    if (
      receipt?.project_id === "vhost-manager-alpha" &&
      receipt?.event_id === expectedEventId &&
      ["processed", "duplicate"].includes(receipt.status)
    )
      return {
        ...receipt,
        status: "received",
        receipt_status: receipt.status,
      }
  } catch {
    // A malformed helper response is not a durable Curator receipt.
  }
  return { status: "pending", reason: "receipt_unverified" }
}

function submitCuratorV2(operation, request = null) {
  if (request) {
    const persisted = ops.recordCuratorV2Request(config, operation.id, request)
    if (!persisted)
      return {
        ...operation,
        curatorV2: { status: "pending", reason: "request_conflict" },
      }
    operation = persisted
  }
  const receipt = curatorV2Receipt(operation, request || operation.curatorRequest || null)
  return (
    ops.recordCuratorV2(config, operation.id, receipt) || {
      ...operation,
      curatorV2: receipt,
    }
  )
}

function finishSslJob(id, status, exitCode) {
  if (!sslJob || sslJob.id !== id || sslJob.finishedAt) return
  sslJob.status = status
  sslJob.exitCode = exitCode
  sslJob.finishedAt = new Date().toISOString()
  sslJob.process = null
  const operation = ops.recordOperation(config, {
    id,
    kind: "ssl-renew",
    title: "Renew SSL certificate",
    domain: sslJob.domain,
    at: sslJob.startedAt,
    finishedAt: sslJob.finishedAt,
    rollbackAvailable: false,
    state: status,
    exitCode,
  })
  const updated = submitCuratorV2(operation)
  sslJob.curatorV2 = updated.curatorV2
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
    .then(async (input) => {
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

        if (config.testMode) {
          const simulatedStatus =
            input.testOutcome ||
            (process.env.VHOST_MANAGER_TEST_SSL_RENEWAL === "vary"
              ? undefined
              : process.env.VHOST_MANAGER_TEST_SSL_RENEWAL)
          if (!["completed", "failed", "interrupted", "running"].includes(simulatedStatus))
            return send(res, 501, { error: "SSL renewal is disabled in test mode." })
          const id = crypto.randomUUID()
          const startedAt = new Date().toISOString()
          if (simulatedStatus === "running") {
            sslJob = {
              id,
              domain,
              status: "running",
              output: "Test mode: in-progress certificate renewal simulated.\n",
              startedAt,
              exitCode: null,
              process: null,
            }
            ops.recordOperation(config, {
              id,
              kind: "ssl-renew",
              title: "Renew SSL certificate",
              domain,
              at: startedAt,
              rollbackAvailable: false,
              state: "running",
              exitCode: null,
            })
            return send(res, 202, { job: publicSslJob(sslJob) })
          }
          sslJob = {
            id,
            domain,
            status: simulatedStatus,
            output: "Test mode: certificate renewal result simulated.\n",
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode:
              simulatedStatus === "completed" ? 0 : simulatedStatus === "interrupted" ? 143 : 1,
            process: null,
          }
          const operation = ops.recordOperation(config, {
            id,
            kind: "ssl-renew",
            title: "Renew SSL certificate",
            domain,
            at: sslJob.startedAt,
            finishedAt: sslJob.finishedAt,
            rollbackAvailable: false,
            state: simulatedStatus,
            exitCode: sslJob.exitCode,
          })
          const updated = submitCuratorV2(operation)
          sslJob.curatorV2 = updated.curatorV2
          return send(res, 202, { job: publicSslJob(sslJob) })
        }

        const id = crypto.randomUUID()
        const startedAt = new Date().toISOString()
        ops.recordOperation(config, {
          id,
          kind: "ssl-renew",
          title: "Renew SSL certificate",
          domain,
          at: startedAt,
          rollbackAvailable: false,
          state: "running",
          exitCode: null,
        })
        sslJob = {
          id,
          domain,
          status: "running",
          output: "Entering root login shell with sudo -i…\n",
          startedAt,
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
            finishSslJob(id, "failed", 1)
          })
          child.on("close", (code, signal) => {
            const interrupted = signal !== null || [130, 143].includes(code)
            const status = interrupted ? "interrupted" : code === 0 ? "completed" : "failed"
            finishSslJob(id, status, code ?? (signal === "SIGINT" ? 130 : 143))
          })
        } catch (error) {
          addJobOutput(sslJob, `Could not start SSL renewal: ${error.message}\n`)
          finishSslJob(id, "failed", 1)
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
      if (url.pathname === "/api/ssl-cron-result") {
        if (!config.testMode && process.getuid?.() !== 0)
          return send(res, 403, {
            error: "Scheduled SSL renewal requires the root Vhost Manager service.",
          })
        const operationId = input.operationId
        const exitCode = input.exitCode
        if (
          typeof operationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
        )
          return send(res, 400, { error: "A valid renewal operation ID is required." })
        if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
          return send(res, 400, { error: "A valid ACME exit code is required." })
        const at = new Date().toISOString()
        const operation = ops.recordOperation(config, {
          id: operationId,
          kind: "ssl-cron",
          title: "Scheduled ACME renewal",
          at,
          finishedAt: at,
          rollbackAvailable: false,
          state: exitCode === 0 ? "completed" : "failed",
          exitCode,
        })
        const updated = submitCuratorV2(operation)
        return send(res, 202, { operation: updated, curatorV2: updated.curatorV2 })
      }
      if (url.pathname === "/api/script-result") {
        if (!config.testMode && process.getuid?.() !== 0)
          return send(res, 403, {
            error: "Standalone utility receipts require the root Vhost Manager service.",
          })
        const operationId = input.operationId
        const producerId = input.producerId
        const exitCode = input.exitCode
        const producers = {
          manual_dns_renewal: "Manual DNS certificate renewal",
          domain_batch_renewal: "Domain batch renewal",
          domain_inventory_refresh: "Domain inventory refresh",
          nginx_vhost_setup: "Nginx vhost setup",
        }
        if (
          typeof operationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
        )
          return send(res, 400, { error: "A valid standalone operation ID is required." })
        if (!Object.hasOwn(producers, producerId))
          return send(res, 400, { error: "Choose a known standalone producer." })
        if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
          return send(res, 400, { error: "A valid utility exit code is required." })
        const existing = ops.history(config).find((item) => item.id === operationId)
        if (
          existing &&
          (existing.kind !== "script" ||
            existing.producerId !== producerId ||
            existing.exitCode !== exitCode)
        )
          return send(res, 409, {
            error: "This operation ID is already bound to a different result.",
          })
        const at = new Date().toISOString()
        const operation = ops.recordOperation(config, {
          id: operationId,
          kind: "script",
          producerId,
          title: producers[producerId],
          at,
          finishedAt: at,
          rollbackAvailable: false,
          state: exitCode === 0 ? "completed" : "failed",
          exitCode,
        })
        const updated = submitCuratorV2(operation)
        return send(res, 202, { operation: updated, curatorV2: updated.curatorV2 })
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
        const result = ops.archiveExamples(plan, config)
        const operation = submitCuratorV2(result.operation)
        return send(res, 200, { ...result, operation, curatorV2: operation.curatorV2 })
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
        let result
        const curatorRequest = {
          problem: plan.curatorV2Goal.problem,
          criterion_ids: plan.curatorV2Goal.success_criteria.map(
            (criterion) => criterion.criterion_id
          ),
        }
        try {
          result = ops.applyPlan(plan, config)
        } catch (error) {
          plans.delete(plan.id)
          const failed = ops
            .history(config)
            .find((entry) => entry.id === plan.id && entry.state === "failed")
          if (!failed) throw error
          const operation = submitCuratorV2(failed, curatorRequest)
          return send(res, 400, {
            error: error.message || "Apply failed.",
            operation,
            curatorV2: operation.curatorV2,
          })
        }
        plans.delete(plan.id)
        const operation = submitCuratorV2(result.operation, curatorRequest)
        return send(res, 200, {
          ...result,
          operation,
          curatorV2: operation.curatorV2,
          inventory: scan(),
        })
      }
      if (url.pathname === "/api/curator/retry") {
        const operation = ops.history(config).find((entry) => entry.id === input.operationId)
        const completed =
          (operation &&
            ["site", "reset", "toggle", "adopt"].includes(operation.kind) &&
            ["applied", "failed"].includes(operation.state)) ||
          (operation?.kind === "ssl-renew" &&
            ["completed", "failed", "interrupted"].includes(operation.state)) ||
          (operation?.kind === "ssl-cron" && ["completed", "failed"].includes(operation.state)) ||
          (operation?.kind === "script" && ["completed", "failed"].includes(operation.state)) ||
          (operation?.kind === "rollback" && ["complete", "failed"].includes(operation.state)) ||
          (operation?.kind === "archive" && operation.state === "archived")
        if (!operation || !completed)
          return send(res, 404, { error: "Completed operation not found." })
        if (operation.curatorV2?.status === "received")
          return send(res, 200, { operation, curatorV2: operation.curatorV2 })
        if (operation.curatorV2?.status !== "pending")
          return send(res, 409, { error: "This operation has no pending Curator V2 receipt." })
        const updated = submitCuratorV2(operation)
        return send(res, 200, { operation: updated, curatorV2: updated.curatorV2 })
      }
      if (url.pathname === "/api/rollback") {
        let result
        try {
          result = ops.rollbackOperation(input.operationId, config)
        } catch (error) {
          const failedAttempt = ops.recordFailedRollback(input.operationId, config)
          if (!failedAttempt) throw error
          const rollback = submitCuratorV2(failedAttempt)
          return send(res, 400, {
            error: error.message || "Rollback failed.",
            rollback,
            curatorV2: rollback.curatorV2,
          })
        }
        const rollback = submitCuratorV2(result.rollback)
        return send(res, 200, {
          ...result,
          rollback,
          curatorV2: rollback.curatorV2,
          inventory: scan(),
        })
      }
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
  for (const operation of ops.recoverInterruptedSslRenewals(config)) submitCuratorV2(operation)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`Vhost Manager available at http://127.0.0.1:${port}\n`)
)
