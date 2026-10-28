const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")
const crypto = require("node:crypto")
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

function emptyLifetimeState() {
  return {
    version: 1,
    processedLogArchives: {},
    lifetimeSources: {},
    sshCursor: null,
    sshFailedLogins: {},
    dirty: false,
  }
}

function readLifetimeState(config) {
  if (config.testMode) return emptyLifetimeState()
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(config.stateDir, "security-counts.json"), "utf8")
    )
    if (state?.version !== 1) return emptyLifetimeState()
    return {
      ...emptyLifetimeState(),
      ...state,
      processedLogArchives: state.processedLogArchives || {},
      lifetimeSources: state.lifetimeSources || {},
      sshFailedLogins: state.sshFailedLogins || {},
      dirty: false,
    }
  } catch {
    return emptyLifetimeState()
  }
}

function writeLifetimeState(config, state) {
  if (config.testMode || !state.dirty) return
  const file = path.join(config.stateDir, "security-counts.json")
  const temporary = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o750 })
    fs.writeFileSync(temporary, JSON.stringify({ ...state, dirty: undefined }), { mode: 0o640 })
    fs.renameSync(temporary, file)
    state.dirty = false
  } catch {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}

function incrementSourceCounts(target, ip, counts) {
  const source = target[ip] || { requests: 0, attackSignals: 0, deniedRequests: 0, failedLogins: 0 }
  for (const key of ["requests", "attackSignals", "deniedRequests", "failedLogins"])
    source[key] += counts[key] || 0
  target[ip] = source
}

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
}

function attackSignal(record) {
  return (
    ATTACK_PATH.test(record.target) ||
    SCANNER_AGENT.test(record.userAgent) ||
    record.method === "TRACE" ||
    record.method === "CONNECT"
  )
}

function scanNginxLogs(config, now, lifetimeState) {
  const files = logFiles(config)
  const from = now - WINDOW_MS
  const sources = new Map()
  const liveLifetimeSources = new Map()
  const countries = new Map()
  const hourly = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(now - (23 - index) * 60 * 60 * 1000).toISOString().slice(0, 13) + ":00:00.000Z",
    requests: 0,
    attackSignals: 0,
  }))
  let requests = 0
  let attackSignals = 0
  let deniedRequests = 0
  let serverErrors = 0
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
    const filename = path.basename(file)
    const archived = /\.log\.\d+(?:\.gz)?$/.test(filename)
    const archiveBase = filename.replace(/\.log\.\d+(?:\.gz)?$/, ".log")
    const archiveKey = archived
      ? `${archiveBase}:${crypto.createHash("sha256").update(content).digest("hex")}`
      : null
    const recordArchive = archived && !lifetimeState.processedLogArchives[archiveKey]
    const lifetimeTarget = recordArchive ? lifetimeState.lifetimeSources : archived ? null : null
    const currentFile = !archived
    for (const line of content.toString("utf8").split(/\r?\n/)) {
      if (!line) continue
      const record = parseAccessLine(line)
      if (!record?.ip || !record.date || !Number.isFinite(record.status)) continue
      const timestamp = record.date.getTime()
      if (timestamp > now + 5 * 60_000) continue
      const attack = attackSignal(record)
      const denied = [401, 403, 429, 444].includes(record.status)
      const recent = timestamp >= from
      if ((recordArchive || currentFile) && (attack || denied)) {
        const counts = {
          requests: 1,
          attackSignals: Number(attack),
          deniedRequests: Number(denied),
        }
        if (recordArchive) incrementSourceCounts(lifetimeTarget, record.ip, counts)
        else {
          const previous = liveLifetimeSources.get(record.ip) || {
            ip: record.ip,
            requests: 0,
            attackSignals: 0,
            deniedRequests: 0,
            failedLogins: 0,
          }
          previous.requests += counts.requests
          previous.attackSignals += counts.attackSignals
          previous.deniedRequests += counts.deniedRequests
          liveLifetimeSources.set(record.ip, previous)
        }
      }
      if (recent) {
        requests += 1
        if (attack) attackSignals += 1
        if (denied) deniedRequests += 1
        if (record.status >= 500 && record.status < 600) serverErrors += 1
      }

      const hourIndex = recent ? Math.floor((timestamp - from) / (60 * 60 * 1000)) : -1
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
          if (recent) {
            country.requests += 1
            if (attack) country.attackSignals += 1
          }
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
      if (!recent) {
        source.requests -= 1
        if (attack) source.attackSignals -= 1
        if (denied) source.deniedRequests -= 1
      }
      sources.set(record.ip, source)
    }
    if (recordArchive) {
      lifetimeState.processedLogArchives[archiveKey] = true
      lifetimeState.dirty = true
    }
  }

  const lifetimeSources = new Map(
    Object.entries(lifetimeState.lifetimeSources).map(([ip, counts]) => [ip, { ip, ...counts }])
  )
  for (const [ip, counts] of liveLifetimeSources) {
    const previous = lifetimeSources.get(ip) || {
      ip,
      requests: 0,
      attackSignals: 0,
      deniedRequests: 0,
      failedLogins: 0,
    }
    lifetimeSources.set(ip, {
      ...previous,
      requests: previous.requests + counts.requests,
      attackSignals: previous.attackSignals + counts.attackSignals,
      deniedRequests: previous.deniedRequests + counts.deniedRequests,
    })
  }

  return {
    requests,
    attackSignals,
    deniedRequests,
    serverErrors,
    filesRead,
    available: filesRead > 0,
    sources,
    lifetimeSources,
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

function parsePermanentBanLines(value) {
  return new Set(
    String(value || "")
      .split(/\r?\n/)
      .map(normalizeIp)
      .filter(Boolean)
  )
}

function readPermanentBanFile(file) {
  try {
    return parsePermanentBanLines(fs.readFileSync(file, "utf8"))
  } catch {
    return new Set()
  }
}

function permanentBanFiles(config) {
  if (config.testMode) return { ssh: new Set(), web: new Set() }
  return {
    ssh: readPermanentBanFile("/var/lib/crowdsec/permanent-ssh-bans.txt"),
    web: readPermanentBanFile("/var/lib/crowdsec/permanent-web-attack-bans.txt"),
  }
}

function scanSshJournal(config, now, lifetimeState) {
  if (config.testMode || process.getuid?.() !== 0)
    return {
      available: false,
      failedLogins: 0,
      lifetimeFailedLogins: 0,
      sources: new Map(),
      lifetimeSources: new Map(),
    }
  const runJournal = (args) =>
    spawnSync("/usr/bin/journalctl", args, {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
  const recentJournal = runJournal([
    "--unit=ssh.service",
    "--since=24 hours ago",
    "--output=json",
    "--no-pager",
  ])
  if (recentJournal.status !== 0 || recentJournal.error)
    return {
      available: false,
      failedLogins: 0,
      lifetimeFailedLogins: 0,
      sources: new Map(),
      lifetimeSources: new Map(),
    }

  const lifetimeArgs = ["--unit=ssh.service", "--output=json", "--no-pager"]
  if (lifetimeState.sshCursor) lifetimeArgs.push(`--after-cursor=${lifetimeState.sshCursor}`)
  const lifetimeJournal = runJournal(lifetimeArgs)
  const available = lifetimeJournal.status === 0 && !lifetimeJournal.error

  const from = now - WINDOW_MS
  const sources = new Map()
  const lifetimeSources = new Map(
    Object.entries(lifetimeState.sshFailedLogins).map(([ip, failedLogins]) => [
      ip,
      { ip, failedLogins },
    ])
  )
  let failedLogins = 0
  let lastCursor = lifetimeState.sshCursor
  for (const line of available ? lifetimeJournal.stdout.split(/\r?\n/) : []) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.__CURSOR) lastCursor = entry.__CURSOR
    const message = String(entry.MESSAGE || "")
    const failure = message.match(
      /^Failed (?:password|publickey) for (?:invalid user )?\S+ from ([^\s]+)/i
    )
    if (failure) {
      const ip = normalizeIp(failure[1])
      if (ip) {
        const lifetimeSource = lifetimeSources.get(ip) || { ip, failedLogins: 0 }
        lifetimeSource.failedLogins += 1
        lifetimeSources.set(ip, lifetimeSource)
        lifetimeState.sshFailedLogins[ip] = lifetimeSource.failedLogins
        lifetimeState.dirty = true
      }
    }
  }
  for (const line of recentJournal.stdout.split(/\r?\n/)) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const failure = String(entry.MESSAGE || "").match(
      /^Failed (?:password|publickey) for (?:invalid user )?\S+ from ([^\s]+)/i
    )
    if (!failure) continue
    const timestamp = Number(entry.__REALTIME_TIMESTAMP) / 1000
    const ip = normalizeIp(failure[1])
    if (!ip || !Number.isFinite(timestamp) || timestamp < from || timestamp > now + 5 * 60_000)
      continue
    failedLogins += 1
    const source = sources.get(ip) || { ip, failedLogins: 0, lastSeen: null }
    source.failedLogins += 1
    if (!source.lastSeen || timestamp > Date.parse(source.lastSeen))
      source.lastSeen = new Date(timestamp).toISOString()
    sources.set(ip, source)
  }
  if (lastCursor && lastCursor !== lifetimeState.sshCursor) {
    lifetimeState.sshCursor = lastCursor
    lifetimeState.dirty = true
  }
  const lifetimeFailedLogins = [...lifetimeSources.values()].reduce(
    (sum, source) => sum + source.failedLogins,
    0
  )
  return {
    available: true,
    lifetimeAvailable: available,
    failedLogins,
    lifetimeFailedLogins,
    sources,
    lifetimeSources,
  }
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
  const lifetimeState = readLifetimeState(config)
  const nginx = scanNginxLogs(config, now, lifetimeState)
  const ssh = scanSshJournal(config, now, lifetimeState)
  writeLifetimeState(config, lifetimeState)
  const observedIps = new Set([
    ...nginx.sources.keys(),
    ...nginx.lifetimeSources.keys(),
    ...ssh.sources.keys(),
    ...ssh.lifetimeSources.keys(),
  ])
  const emptyCounts = () => ({ requests: 0, attackSignals: 0, deniedRequests: 0, failedLogins: 0 })
  for (const ip of observedIps) {
    const recentWeb = nginx.sources.get(ip)
    const lifetimeWeb = nginx.lifetimeSources.get(ip)
    const recentSsh = ssh.sources.get(ip)
    const lifetimeSsh = ssh.lifetimeSources.get(ip)
    const source = {
      ...(lifetimeWeb || {}),
      ...(recentWeb || {}),
      ip,
      lifetime: {
        requests: lifetimeWeb?.requests || 0,
        attackSignals: lifetimeWeb?.attackSignals || 0,
        deniedRequests: lifetimeWeb?.deniedRequests || 0,
        failedLogins: lifetimeSsh?.failedLogins || 0,
      },
      last24h: {
        requests: recentWeb?.requests || 0,
        attackSignals: recentWeb?.attackSignals || 0,
        deniedRequests: recentWeb?.deniedRequests || 0,
        failedLogins: recentSsh?.failedLogins || 0,
      },
      countryCode: recentWeb?.countryCode || lifetimeWeb?.countryCode || null,
      country: recentWeb?.country || lifetimeWeb?.country || null,
      countrySource: recentWeb?.countrySource || lifetimeWeb?.countrySource || null,
      lastSeen:
        [recentWeb?.lastSeen, lifetimeWeb?.lastSeen, recentSsh?.lastSeen, lifetimeSsh?.lastSeen]
          .filter(Boolean)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null,
      blocked: false,
    }
    nginx.sources.set(ip, source)
  }
  for (const [ip, source] of nginx.sources) {
    source.failedLogins = source.last24h.failedLogins
    source.attackSignals = source.last24h.attackSignals
    source.deniedRequests = source.last24h.deniedRequests
    source.requests = source.last24h.requests
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
      lifetime: emptyCounts(),
      last24h: emptyCounts(),
      blocked: true,
      lastSeen: null,
      scenario: String(decision.scenario || decision.type || "CrowdSec decision").slice(0, 100),
    }
    blocks.set(ip, entry)
  }
  const permanentBanLists = permanentBanFiles(config)
  const permanentBans = new Map([
    ...[...permanentBanLists.ssh].map((ip) => [ip, "Permanent SSH brute-force ban"]),
    ...[...permanentBanLists.web].map((ip) => [ip, "Permanent web attack ban"]),
  ])
  for (const [ip, reason] of permanentBans) {
    const entry = blocks.get(ip) || {
      ip,
      countryCode: null,
      country: null,
      countrySource: null,
      requests: 0,
      attackSignals: 0,
      deniedRequests: 0,
      failedLogins: 0,
      lifetime: emptyCounts(),
      last24h: emptyCounts(),
      lastSeen: null,
    }
    blocks.set(ip, {
      ...entry,
      blocked: true,
      permanent: true,
      scenario: reason,
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
  const topSourceRows = [...topSources.values()].sort(
    (a, b) =>
      b.last24h.failedLogins - a.last24h.failedLogins ||
      b.last24h.attackSignals - a.last24h.attackSignals ||
      b.last24h.deniedRequests - a.last24h.deniedRequests ||
      b.lifetime.failedLogins - a.lifetime.failedLogins ||
      b.lifetime.attackSignals - a.lifetime.attackSignals ||
      b.lifetime.deniedRequests - a.lifetime.deniedRequests ||
      a.ip.localeCompare(b.ip)
  )
  const uniqueAttackIps = [...topSources.values()].filter(
    (source) =>
      source.lifetime.attackSignals > 0 ||
      source.lifetime.deniedRequests > 0 ||
      source.lifetime.failedLogins > 0 ||
      source.last24h.attackSignals > 0 ||
      source.last24h.deniedRequests > 0 ||
      source.last24h.failedLogins > 0 ||
      source.blocked
  ).length
  const lifetimeSummary = [...topSources.values()].reduce(
    (summary, source) => ({
      attackSignals: summary.attackSignals + source.lifetime.attackSignals,
      deniedRequests: summary.deniedRequests + source.lifetime.deniedRequests,
      failedLogins: summary.failedLogins + source.lifetime.failedLogins,
    }),
    { attackSignals: 0, deniedRequests: 0, failedLogins: 0 }
  )

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: 24,
    summary: {
      requests: nginx.requests,
      attackSignals: nginx.attackSignals,
      deniedRequests: nginx.deniedRequests,
      serverErrors: nginx.serverErrors,
      failedLogins: ssh.failedLogins,
      activeBlocks: blocks.size,
      uniqueAttackIps,
      lifetime: lifetimeSummary,
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
        permanentBanCount: permanentBanLists.ssh.size,
      },
      web: {
        permanentBanCount: permanentBanLists.web.size,
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
      lifetime: {
        description: "Archived history and persisted counts tracked by this dashboard.",
        olderHistoryMayBeUnavailable: true,
        sshAvailable: ssh.lifetimeAvailable !== false,
      },
    },
    topSources: topSourceRows,
    countries: countryRows,
    hourly: nginx.hourly,
  }
}

function securitySnapshot(config, now = Date.now()) {
  const key = `${config.nginxLogDir}|${config.stateDir}|${config.crowdsecCli}|${config.geoipDatabase}|${config.geoipDatabaseV6}|${config.testMode}`
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
  parsePermanentBanLines,
}
