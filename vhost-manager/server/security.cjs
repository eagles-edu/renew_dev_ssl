const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")
const net = require("node:net")
const { spawnSync } = require("node:child_process")

const WINDOW_MS = 24 * 60 * 60 * 1000
const CACHE_MS = 30 * 1000
const GEOIP_CACHE_MS = 12 * 60 * 60 * 1000
const MAX_GEOIP_CACHE = 10_000
const MAX_LOG_BYTES = 32 * 1024 * 1024
const MONTHS = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
    (month, index) => [month, index]
  )
)
const ATTACK_PATH =
  /(?:^|\/)(?:\.env|\.git(?:\/|$)|wp-login(?:\.php)?(?:\/|$)|wp-admin(?:\/|$)|xmlrpc\.php(?:\/|$)|phpmyadmin(?:\/|$)|pma(?:\/|$)|adminer(?:\.php|\/|$)|vendor\/phpunit(?:\/|$)|cgi-bin(?:\/|$)|actuator(?:\/|$)|server-status(?:\/|$)|hnap1(?:\/|$)|boaform(?:\/|$)|autodiscover\/autodiscover\.xml|\.well-known\/\.\.|console(?:\/|$)|\.\.%2f|%2e%2e)/i
const SCANNER_AGENT = /(?:sqlmap|nikto|nmap|zgrab|masscan|gobuster|dirbuster|nuclei)/i

let cache = null
const geoipCache = new Map()

function parseNginxTime(value) {
  const match = String(value || "").match(
    /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/
  )
  if (match) {
    const [, day, month, year, hour, minute, second, sign, offsetHour, offsetMinute] = match
    const monthIndex = MONTHS.get(month)
    if (monthIndex == null) return null
    const direction = sign === "+" ? 1 : -1
    const offset = direction * (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000
    return new Date(
      Date.UTC(
        Number(year),
        monthIndex,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ) - offset
    )
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

function normalizeIp(value) {
  const ip = String(value || "")
    .trim()
    .replace(/^"|"$/g, "")
  const normalized = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip
  return net.isIP(normalized) ? normalized.toLowerCase() : null
}

function countryName(code) {
  if (!/^[A-Z]{2}$/.test(String(code || ""))) return null
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code)
  } catch {
    return code
  }
}

function parseGeoIpCountry(output) {
  const match = String(output || "").match(/GeoIP Country Edition:\s*([A-Z]{2}),/)
  return match?.[1] || null
}

function lookupCountryCode(config, ip, now) {
  const address = normalizeIp(ip)
  const database =
    address && net.isIP(address) === 6 ? config.geoipDatabaseV6 : config.geoipDatabase
  if (
    !address ||
    config.testMode ||
    !config.geoipLookup ||
    !database ||
    !fs.existsSync(config.geoipLookup) ||
    !fs.existsSync(database)
  )
    return null

  const cacheKey = `${database}|${address}`
  const cached = geoipCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.code
  const child = spawnSync(config.geoipLookup, ["-f", database, address], {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const code = child.status === 0 && !child.error ? parseGeoIpCountry(child.stdout) : null
  if (geoipCache.size >= MAX_GEOIP_CACHE) geoipCache.delete(geoipCache.keys().next().value)
  geoipCache.set(cacheKey, { code, expiresAt: now + GEOIP_CACHE_MS })
  return code
}

function jsonRecord(line) {
  try {
    const value = JSON.parse(line)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const request = String(value.request || "")
    const requestParts = request.match(/^([A-Z]+)\s+(\S+)/)
    const timestamp = value.time_iso8601 || value.timestamp || value.time || value.ts
    const date =
      typeof timestamp === "number" ? new Date(timestamp * 1000) : parseNginxTime(timestamp)
    return {
      ip: normalizeIp(value.remote_addr || value.remoteAddress || value.client_ip || value.ip),
      date,
      method: String(
        value.request_method || value.method || requestParts?.[1] || "GET"
      ).toUpperCase(),
      target: String(value.uri || value.request_uri || value.path || requestParts?.[2] || "").split(
        "?"
      )[0],
      status: Number(value.status || value.status_code),
      userAgent: String(value.http_user_agent || value.user_agent || ""),
      countryCode: String(
        value.geoip2_country_code || value.country_code || value.country || ""
      ).toUpperCase(),
    }
  } catch {
    return null
  }
}

function parseAccessLine(line) {
  const json = jsonRecord(line)
  if (json) return json
  const match = line.match(
    /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)(?:\s+HTTP\/[^"]*)?"\s+(\d{3})\s+\S+(?:\s+\S+)?(?:\s+"[^"]*"\s+"([^"]*)")?/
  )
  if (!match) return null
  return {
    ip: normalizeIp(match[1]),
    date: parseNginxTime(match[2]),
    method: match[3],
    target: match[4].split("?")[0],
    status: Number(match[5]),
    userAgent: match[6] || "",
    countryCode: "",
  }
}

function readLog(file) {
  const stat = fs.statSync(file)
  if (stat.size > MAX_LOG_BYTES) return null
  const data = fs.readFileSync(file)
  return file.endsWith(".gz") ? zlib.gunzipSync(data, { maxOutputLength: MAX_LOG_BYTES }) : data
}

function logFiles(config) {
  let names
  try {
    names = fs.readdirSync(config.nginxLogDir)
  } catch {
    return []
  }
  return names
    .filter((name) => /^(?:access|[^/]+_access)\.log(?:\.\d+)?(?:\.gz)?$/.test(name))
    .map((name) => path.join(config.nginxLogDir, name))
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      } catch {
        return 0
      }
    })
    .slice(0, 20)
}

function attackSignal(record) {
  return (
    ATTACK_PATH.test(record.target) ||
    SCANNER_AGENT.test(record.userAgent) ||
    record.method === "TRACE" ||
    record.method === "CONNECT"
  )
}

function scanNginxLogs(config, now) {
  const files = logFiles(config)
  const from = now - WINDOW_MS
  const sources = new Map()
  const countries = new Map()
  const hourly = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(now - (23 - index) * 60 * 60 * 1000).toISOString().slice(0, 13) + ":00:00.000Z",
    requests: 0,
    attackSignals: 0,
  }))
  let requests = 0
  let attackSignals = 0
  let deniedRequests = 0
  let filesRead = 0

  for (const file of files) {
    let content
    try {
      content = readLog(file)
      if (!content) continue
      filesRead += 1
    } catch {
      continue
    }
    for (const line of content.toString("utf8").split(/\r?\n/)) {
      if (!line) continue
      const record = parseAccessLine(line)
      if (!record?.ip || !record.date || !Number.isFinite(record.status)) continue
      const timestamp = record.date.getTime()
      if (timestamp < from || timestamp > now + 5 * 60_000) continue

      requests += 1
      const attack = attackSignal(record)
      const denied = [401, 403, 429, 444].includes(record.status)
      if (attack) attackSignals += 1
      if (denied) deniedRequests += 1

      const hourIndex = Math.floor((timestamp - from) / (60 * 60 * 1000))
      if (hourIndex >= 0 && hourIndex < hourly.length) {
        hourly[hourIndex].requests += 1
        if (attack) hourly[hourIndex].attackSignals += 1
      }

      if (record.countryCode) {
        const code = record.countryCode.slice(0, 2)
        if (/^[A-Z]{2}$/.test(code)) {
          const country = countries.get(code) || {
            code,
            name: countryName(code),
            requests: 0,
            attackSignals: 0,
          }
          country.requests += 1
          if (attack) country.attackSignals += 1
          countries.set(code, country)
        }
      }

      if (!attack && !denied) continue
      const source = sources.get(record.ip) || {
        ip: record.ip,
        countryCode: record.countryCode || null,
        country: record.countryCode ? countryName(record.countryCode.slice(0, 2)) : null,
        countrySource: record.countryCode ? "Nginx log" : null,
        requests: 0,
        attackSignals: 0,
        deniedRequests: 0,
        failedLogins: 0,
        blocked: false,
        lastSeen: null,
      }
      source.requests += 1
      if (attack) source.attackSignals += 1
      if (denied) source.deniedRequests += 1
      if (!source.countryCode && record.countryCode) {
        source.countryCode = record.countryCode
        source.country = countryName(record.countryCode.slice(0, 2))
        source.countrySource = "Nginx log"
      }
      if (!source.lastSeen || timestamp > Date.parse(source.lastSeen))
        source.lastSeen = record.date.toISOString()
      sources.set(record.ip, source)
    }
  }

  return {
    requests,
    attackSignals,
    deniedRequests,
    filesRead,
    available: filesRead > 0,
    sources,
    countries,
    hourly,
  }
}

function runJson(command, args) {
  if (process.getuid?.() !== 0) return { available: false, result: null }
  const child = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (child.status !== 0 || child.error) return { available: false, result: null }
  try {
    return { available: true, result: JSON.parse(child.stdout) }
  } catch {
    return { available: false, result: null }
  }
}

function serviceActive(service) {
  if (process.getuid?.() !== 0) return false
  const child = spawnSync("/usr/bin/systemctl", ["is-active", "--quiet", service], {
    encoding: "utf8",
    timeout: 2500,
    stdio: "ignore",
  })
  return child.status === 0
}

function crowdsecAcquisitionConfigs(config) {
  if (config.testMode) return []
  const files = ["/etc/crowdsec/acquis.yaml"]
  try {
    for (const name of fs.readdirSync("/etc/crowdsec/acquis.d"))
      if (/\.ya?ml$/i.test(name)) files.push(path.join("/etc/crowdsec/acquis.d", name))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  return files.flatMap((file) => {
    try {
      return [fs.readFileSync(file, "utf8")]
    } catch {
      return []
    }
  })
}

function permanentSshBans(config) {
  if (config.testMode) return new Set()
  try {
    return new Set(
      fs
        .readFileSync("/var/lib/crowdsec/permanent-ssh-bans.txt", "utf8")
        .split(/\r?\n/)
        .map(normalizeIp)
        .filter(Boolean)
    )
  } catch {
    return new Set()
  }
}

function scanSshJournal(config, now) {
  if (config.testMode || process.getuid?.() !== 0)
    return { available: false, failedLogins: 0, sources: new Map() }
  const child = spawnSync(
    "/usr/bin/journalctl",
    ["--unit=ssh.service", "--since", "24 hours ago", "--output=json", "--no-pager"],
    {
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  )
  if (child.status !== 0 || child.error)
    return { available: false, failedLogins: 0, sources: new Map() }

  const from = now - WINDOW_MS
  const sources = new Map()
  let failedLogins = 0
  for (const line of child.stdout.split(/\r?\n/)) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const message = String(entry.MESSAGE || "")
    const failure = message.match(
      /^Failed (?:password|publickey) for (?:invalid user )?\S+ from ([^\s]+)/i
    )
    if (!failure) continue
    const timestamp = Number(entry.__REALTIME_TIMESTAMP) / 1000
    if (!Number.isFinite(timestamp) || timestamp < from || timestamp > now + 5 * 60_000) continue
    const ip = normalizeIp(failure[1])
    if (!ip) continue
    failedLogins += 1
    const source = sources.get(ip) || { ip, failedLogins: 0, lastSeen: null }
    source.failedLogins += 1
    if (!source.lastSeen || timestamp > Date.parse(source.lastSeen))
      source.lastSeen = new Date(timestamp).toISOString()
    sources.set(ip, source)
  }
  return { available: true, failedLogins, sources }
}

function normalizeDecisions(value) {
  const alerts = Array.isArray(value)
    ? value
    : Array.isArray(value?.decisions)
      ? value.decisions
      : []
  return alerts.flatMap((alert) => (Array.isArray(alert?.decisions) ? alert.decisions : [alert]))
}

function collect(config, now) {
  const nginx = scanNginxLogs(config, now)
  const ssh = scanSshJournal(config, now)
  for (const [ip, loginSource] of ssh.sources) {
    const source = nginx.sources.get(ip) || {
      ip,
      countryCode: null,
      country: null,
      countrySource: null,
      requests: 0,
      attackSignals: 0,
      deniedRequests: 0,
      failedLogins: 0,
      blocked: false,
      lastSeen: null,
    }
    source.failedLogins = loginSource.failedLogins
    if (!source.lastSeen || Date.parse(loginSource.lastSeen) > Date.parse(source.lastSeen))
      source.lastSeen = loginSource.lastSeen
    nginx.sources.set(ip, source)
  }
  const metrics = config.testMode
    ? { available: false, result: null }
    : runJson(config.crowdsecCli, ["metrics", "--output", "json"])
  const decisionsResult = config.testMode
    ? { available: false, result: null }
    : runJson(config.crowdsecCli, ["decisions", "list", "-o", "json"])
  const decisions = normalizeDecisions(decisionsResult.result)
  const blocks = new Map()
  for (const decision of decisions) {
    if (String(decision.scope || "").toLowerCase() !== "ip") continue
    const ip = normalizeIp(decision.value)
    if (!ip) continue
    const entry = blocks.get(ip) || {
      ip,
      countryCode: decision.country || decision.country_code || null,
      country: countryName(decision.country || decision.country_code),
      countrySource: decision.country || decision.country_code ? "CrowdSec" : null,
      requests: 0,
      attackSignals: 0,
      deniedRequests: 0,
      failedLogins: 0,
      blocked: true,
      lastSeen: null,
      scenario: String(decision.scenario || decision.type || "CrowdSec decision").slice(0, 100),
    }
    blocks.set(ip, entry)
  }
  const permanentBans = permanentSshBans(config)
  for (const ip of permanentBans) {
    const entry = blocks.get(ip) || {
      ip,
      countryCode: null,
      country: null,
      countrySource: null,
      requests: 0,
      attackSignals: 0,
      deniedRequests: 0,
      failedLogins: 0,
      lastSeen: null,
    }
    blocks.set(ip, {
      ...entry,
      blocked: true,
      permanent: true,
      scenario: "Permanent SSH brute-force ban",
    })
  }
  for (const [ip, blocked] of blocks) {
    const logged = nginx.sources.get(ip)
    if (logged) {
      logged.blocked = true
      logged.permanent = blocked.permanent === true
      logged.scenario = blocked.scenario
      logged.countryCode ||= blocked.countryCode
      logged.country ||= blocked.country
      logged.countrySource ||= blocked.countrySource
      blocks.set(ip, {
        ...blocked,
        ...logged,
        blocked: true,
        permanent: blocked.permanent === true,
        countrySource: logged.countrySource,
        scenario: blocked.scenario,
      })
    }
  }

  const topSources = new Map(nginx.sources)
  for (const [ip, block] of blocks) if (!topSources.has(ip)) topSources.set(ip, block)
  const countryMap = new Map(nginx.countries)
  for (const source of topSources.values()) {
    if (!source.countryCode) {
      const code = lookupCountryCode(config, source.ip, now)
      if (code) {
        source.countryCode = code
        source.country = countryName(code)
        source.countrySource = "Local GeoIP database"
      }
    }
    const code = String(source.countryCode || "")
      .slice(0, 2)
      .toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) continue
    const country = countryMap.get(code) || {
      code,
      name: countryName(code),
      requests: 0,
      attackSignals: 0,
    }
    if (source.countrySource === "Local GeoIP database") {
      country.requests += source.requests
      country.attackSignals += source.attackSignals
    }
    countryMap.set(code, country)
  }
  for (const block of blocks.values()) {
    const code = String(block.countryCode || "")
      .slice(0, 2)
      .toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) continue
    const country = countryMap.get(code) || {
      code,
      name: countryName(code),
      requests: 0,
      attackSignals: 0,
    }
    countryMap.set(code, country)
  }

  const acquisition = Object.keys(metrics.result?.acquisition || {})
  const acquisitionConfigs = crowdsecAcquisitionConfigs(config)
  const nginxAcquisitionConfigured = acquisitionConfigs.some(
    (source) => /type:\s*nginx\b/i.test(source) && /\/var\/log\/nginx\//i.test(source)
  )
  const sshAcquisitionConfigured = acquisitionConfigs.some(
    (source) => /source:\s*journalctl\b/i.test(source) && /_SYSTEMD_UNIT=ssh\.service/i.test(source)
  )
  const bouncers = metrics.result?.bouncers || {}
  const bouncerSeen = Object.keys(bouncers).some((name) => name.toLowerCase().includes("firewall"))
  const crowdsecActive = !config.testMode && serviceActive(config.crowdsecService)
  const bouncerActive = !config.testMode && serviceActive(config.crowdsecBouncerService)
  const countryRows = [...countryMap.values()].sort(
    (a, b) =>
      b.attackSignals - a.attackSignals || b.requests - a.requests || a.code.localeCompare(b.code)
  )
  const geoipAvailable =
    !config.testMode &&
    Boolean(
      config.geoipLookup &&
      config.geoipDatabase &&
      fs.existsSync(config.geoipLookup) &&
      fs.existsSync(config.geoipDatabase) &&
      config.geoipDatabaseV6 &&
      fs.existsSync(config.geoipDatabaseV6)
    )
  const topSourceRows = [...topSources.values()]
    .sort(
      (a, b) =>
        b.failedLogins - a.failedLogins ||
        b.attackSignals - a.attackSignals ||
        b.deniedRequests - a.deniedRequests ||
        b.requests - a.requests
    )
    .slice(0, 8)
  const uniqueAttackIps = [...topSources.values()].filter(
    (source) =>
      source.attackSignals > 0 ||
      source.deniedRequests > 0 ||
      source.failedLogins > 0 ||
      source.blocked
  ).length

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: 24,
    summary: {
      requests: nginx.requests,
      attackSignals: nginx.attackSignals,
      deniedRequests: nginx.deniedRequests,
      failedLogins: ssh.failedLogins,
      activeBlocks: blocks.size,
      uniqueAttackIps,
    },
    sources: {
      nginx: {
        available: nginx.available,
        filesRead: nginx.filesRead,
        acquisitionConfiguredInCrowdSec: nginxAcquisitionConfigured,
      },
      ssh: {
        available: ssh.available,
        acquisitionConfiguredInCrowdSec: sshAcquisitionConfigured,
        permanentBanCount: permanentBans.size,
      },
      crowdsec: {
        available: metrics.available && decisionsResult.available,
        active: crowdsecActive,
        bouncerActive,
        bouncerSeenInMetrics: bouncerSeen,
        decisionsAvailable: decisionsResult.available,
        acquisitionSources: acquisition.map((source) => source.replace(/^file:/, "")),
      },
      geoip: {
        available: geoipAvailable,
        reason: geoipAvailable
          ? null
          : "Install a local GeoIP country database to resolve source countries. External lookups are disabled.",
      },
    },
    topSources: topSourceRows,
    countries: countryRows,
    hourly: nginx.hourly,
  }
}

function securitySnapshot(config, now = Date.now()) {
  const key = `${config.nginxLogDir}|${config.crowdsecCli}|${config.geoipDatabase}|${config.geoipDatabaseV6}|${config.testMode}`
  if (cache?.key === key && cache.expiresAt > now) return cache.value
  const value = collect(config, now)
  cache = { key, expiresAt: now + CACHE_MS, value }
  return value
}

module.exports = {
  parseNginxTime,
  parseAccessLine,
  parseGeoIpCountry,
  scanNginxLogs,
  securitySnapshot,
}
